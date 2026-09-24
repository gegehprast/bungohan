import { err, ok, type Result } from "@bungohan/result"
import type { Clock, Reservation, TimerId } from "@bungohan/types"
import type { ClusterNode, PoolMatch } from "./cluster/node"
import type { RoomInfo } from "./cluster/protocol"
import { RoomProxy } from "./cluster/proxy"
import { BungohanError, type ErrorCode } from "./errors"
import type { Logger } from "./logger"
import { Room, type RoomPlacement } from "./room"
import type { RoomManager } from "./room-manager"
import {
  createRoomType,
  packOptions,
  type RoomTypeDef,
  readServerOptions,
} from "./room-type"
import type {
  CreateRoomArgs,
  DefineRoomOptions,
  MatchMakerQueryOptions,
  MetadataValue,
  Placement,
  ProcessInfo,
  ProcessSelector,
  ReserveArgs,
  RoomClass,
  RoomConstructor,
  RoomListingInfo,
} from "./types"

interface ReservationEntry {
  readonly reservation: Reservation
  readonly room: Room
  expired: boolean
  readonly cleanup: TimerId
}

export interface MatchMakerDeps {
  readonly manager: RoomManager
  readonly clock: Clock
  readonly logger: Logger
  readonly processId: string
  readonly clusterEnabled: boolean
  /** The running cluster node, once `start()` built one (spec §6.4). */
  readonly cluster: () => ClusterNode | undefined
  /** True while this process drains: it creates and offers no new rooms. */
  readonly draining: () => boolean
  /** This process's `ProcessInfo.metadata`. */
  readonly metadata: () => Record<string, unknown>
  readonly createId: (size: number) => string
}

let current: MatchMaker | undefined

/**
 * The matchmaker of the most recently created server, for code that has
 * no server reference (prefer `server.getMatchMaker()` when you have
 * one). Throws if no server exists yet: calling it before creating one is
 * a setup error.
 */
export function getMatchMaker(): MatchMaker {
  if (current === undefined) {
    throw new Error("getMatchMaker(): no Bungohan server has been created")
  }
  return current
}

/**
 * A class that checks joins into an existing room (instance `onAuth`) but
 * inherits the default static `onAuth`, which admits every creating join.
 */
function checksOnlyExistingRooms(ctor: RoomConstructor): boolean {
  const instanceHook: unknown = Reflect.get(ctor.prototype, "onAuth")
  const staticHook: unknown = Reflect.get(ctor, "onAuth")
  return (
    instanceHook !== Reflect.get(Room.prototype, "onAuth") &&
    staticHook === Reflect.get(Room, "onAuth")
  )
}

/** @internal */
export function setMatchMaker(matchMaker: MatchMaker): void {
  current = matchMaker
}

/**
 * Finds, creates and reserves rooms from server code: a lobby room placing
 * players, an HTTP endpoint, a bot (see docs/guides/matchmaking.md).
 * Clients' joins go through the same logic. Get it with
 * `server.getMatchMaker()`.
 *
 * With cluster mode on, every lookup is local first and cluster-wide
 * second: a room found on another process comes back as a {@link RoomProxy}
 * with the same `Room` type. Without it, a `ProcessSelector` that picks a
 * process other than this one is `CLUSTER_NOT_IMPLEMENTED`, since there is
 * no cluster to route to.
 *
 * While this process drains (`server.drain()`), it creates no rooms and
 * matchmaking skips its rooms: `createRoom`, `joinOrCreate` and `reserve`
 * place a new room on a process that isn't draining, or fail with
 * `SERVER_SHUTTING_DOWN` when there is none. `joinById` and existing
 * reservations are unaffected (see docs/guides/scaling.md#draining-a-process).
 */
export class MatchMaker {
  private readonly _deps: MatchMakerDeps
  private readonly _types = new Map<string, RoomTypeDef>()
  private readonly _reservations = new Map<string, ReservationEntry>()
  /**
   * Find-or-create calls that are creating a room, by room type: settles
   * when the room is ready or wasn't created (spec §6.7.2).
   */
  private readonly _creating = new Map<string, Promise<void>>()

  public constructor(deps: MatchMakerDeps) {
    this._deps = deps
  }

  /**
   * Registers a room type. Validates its contract and every Schema class
   * reachable from its state, and **throws** a `TypeError` listing every
   * problem, or if the name is taken. Definition time only.
   * `server.defineRoomType` calls this.
   */
  public registerRoomType<R extends Room>(
    name: string,
    RoomClass: RoomClass<R>,
    options?: DefineRoomOptions,
  ): void {
    if (this._types.has(name)) {
      throw new TypeError(`room type "${name}" is already defined`)
    }
    const ctor: RoomConstructor = RoomClass
    this._types.set(name, createRoomType(name, ctor, options))
    if (checksOnlyExistingRooms(ctor)) {
      this._deps.logger.warn(
        `room type "${name}": ${ctor.name} overrides the instance onAuth ` +
          "but not the static one, so the join that creates a room is " +
          "admitted unchecked. Override the static onAuth too (return true " +
          "if creating is open to anyone), or check identity once in " +
          "ServerOptions.authenticate.",
      )
    }
  }

  /** @internal */
  public _getType(name: string): RoomTypeDef | undefined {
    return this._types.get(name)
  }

  /**
   * Creates a room, here or (with a selector, in cluster mode) on another
   * process. Pass the room **class** to have its create options typed; a
   * name takes anything, checked when it is converted.
   * Either way, typed options go through the wire encoding, so the room
   * gets what a client's would decode to, wherever it runs, and options
   * that don't fit the declaration are `INVALID_OPTIONS`.
   */
  public createRoom<R extends Room>(
    roomType: RoomClass<R>,
    ...args: CreateRoomArgs<R>
  ): Promise<Result<Room, BungohanError>>
  public createRoom(
    roomType: string,
    options?: unknown,
    placement?: ProcessSelector | Placement,
  ): Promise<Result<Room, BungohanError>>
  public async createRoom(
    roomType: string | RoomConstructor,
    options?: unknown,
    placement?: ProcessSelector | Placement,
  ): Promise<Result<Room, BungohanError>> {
    const name = this._nameOf(roomType)
    if (name.isErr()) return name
    const place = resolvePlacement(placement)
    const bad = this._badKey(place.key)
    if (bad !== undefined) return err(bad)
    const key = place.key
    if (key === undefined) return this._createPlaced(name.value, options, place)
    // One room per key: checked and created under the key's lock, after
    // any creation of it in progress here.
    const pool = poolOf(name.value, place)
    for (
      let creating = this._creating.get(pool);
      creating !== undefined;
      creating = this._creating.get(pool)
    ) {
      await creating
    }
    const claim = this._claimCreation(pool)
    try {
      await claim.granted
      const existing = await this._lookupKeyed(name.value, key)
      if (existing !== undefined) {
        return err(
          this._error(
            "ROOM_EXISTS",
            `a room of type "${name.value}" with key "${key}" exists`,
          ),
        )
      }
      return await this._createPlaced(name.value, options, place)
    } finally {
      claim.release()
    }
  }

  /** `createRoom` without the key check: creates, wherever it's placed. */
  private async _createPlaced(
    name: string,
    options: unknown,
    place: ResolvedPlacement,
  ): Promise<Result<Room, BungohanError>> {
    const processSelector = place.selector
    const created: RoomPlacement = {
      ...(place.key === undefined ? {} : { key: place.key }),
      ...(place.where === undefined ? {} : { where: place.where }),
    }
    const cluster = this._deps.cluster()
    if (
      cluster !== undefined &&
      (processSelector !== undefined || this._deps.draining())
    ) {
      const placed = await this._place(
        cluster,
        name,
        options,
        processSelector,
        created,
      )
      if (placed.isErr()) return placed
      // A room elsewhere, or `undefined`: this process was chosen.
      if (placed.value !== undefined) return ok(placed.value)
    } else {
      if (this._deps.draining()) return err(this._noProcessLeft())
      const local = this._selectLocal(processSelector)
      if (local.isErr()) return local
    }
    const type = this._type(name)
    if (type.isErr()) return type
    const read = readServerOptions(type.value, "create", options)
    if (read.isErr()) {
      return err(this._error("INVALID_OPTIONS", read.error.message))
    }
    return this._deps.manager._createReady(type.value, read.value, created)
  }

  /**
   * An available room of the type (public, unlocked, not full); doesn't
   * seat anyone. Looks on this process first, then across the cluster,
   * skipping draining processes.
   */
  public async joinRoom(
    roomType: string,
    _options?: unknown,
    placement?: Pick<Placement, "where" | "key">,
  ): Promise<Result<Room, BungohanError>> {
    const known = this._types.has(roomType)
    const { where, key } = placement ?? {}
    const room = !known
      ? undefined
      : key !== undefined
        ? this._findKeyed(roomType, key)
        : this._findAvailable(roomType, [], where)
    if (room !== undefined) return this._whenReady(room)
    const cluster = this._deps.cluster()
    if (cluster !== undefined) {
      const found = await cluster.findAvailable(
        roomType,
        [],
        key !== undefined ? { key } : where !== undefined ? { where } : {},
      )
      if (found !== undefined) {
        return this._proxyFor(cluster, found.processId, found.roomId)
      }
    }
    if (!known) {
      return err(
        this._error(
          "ROOM_TYPE_NOT_DEFINED",
          `room type "${roomType}" is not defined`,
        ),
      )
    }
    return err(
      this._error("ROOM_NOT_FOUND", `no available room of type "${roomType}"`),
    )
  }

  /**
   * An available room of the type, or a new one. `options` are create
   * options, used only if a room is created (see `createRoom`).
   */
  public joinOrCreate<R extends Room>(
    roomType: RoomClass<R>,
    ...args: CreateRoomArgs<R>
  ): Promise<Result<Room, BungohanError>>
  public joinOrCreate(
    roomType: string,
    options?: unknown,
    placement?: ProcessSelector | Placement,
  ): Promise<Result<Room, BungohanError>>
  public async joinOrCreate(
    roomType: string | RoomConstructor,
    options?: unknown,
    placement?: ProcessSelector | Placement,
  ): Promise<Result<Room, BungohanError>> {
    const name = this._nameOf(roomType)
    if (name.isErr()) return name
    return this._findOrCreate(
      name.value,
      options,
      resolvePlacement(placement),
      (room) => Promise.resolve(ok(room)),
    )
  }

  /**
   * The room with this id, here or (in cluster mode) on any process, as a
   * `RoomProxy` if it runs elsewhere. Doesn't seat anyone.
   * `ROOM_NOT_FOUND` if there is no such room.
   */
  public async joinById(
    roomId: string,
    _options?: unknown,
  ): Promise<Result<Room, BungohanError>> {
    const room = this._deps.manager.getRoom(roomId)
    if (room !== undefined && !room.isDisposed) return this._whenReady(room)
    const cluster = this._deps.cluster()
    if (cluster !== undefined && room === undefined) {
      const owner = await cluster.locate("room", roomId)
      if (owner !== undefined) return this._proxyFor(cluster, owner, roomId)
    }
    return err(this._error("ROOM_NOT_FOUND", `room "${roomId}" not found`))
  }

  /**
   * Ready, undisposed rooms of the type, from this process and (in cluster
   * mode) every process that answers within the collection window. Custom
   * `filters` run here, over the merged list, since a filter is a function
   * this process holds; `metadata` is matched on each process. Rooms on
   * draining processes are left out unless `includeDraining` is set.
   */
  public async query(
    options: MatchMakerQueryOptions,
  ): Promise<Result<RoomListingInfo[], BungohanError>> {
    const includePrivate = options.includePrivate === true
    const includeDraining = options.includeDraining === true
    const listings = this._listLocal(
      options.type,
      options.metadata,
      includePrivate,
      includeDraining,
    )
    const cluster = this._deps.cluster()
    if (cluster !== undefined) {
      listings.push(
        ...(await cluster.query(
          options.type,
          options.metadata,
          includePrivate,
          includeDraining,
        )),
      )
    }
    const out: RoomListingInfo[] = []
    for (const listing of listings) {
      if (options.filters?.some((filter) => !filter(listing)) === true) continue
      out.push(listing)
      if (options.limit !== undefined && out.length >= options.limit) break
    }
    return ok(out)
  }

  /**
   * Holds a seat in an available (or new) room of the type under a new
   * `sessionId`, until `expiresAt` (the type's `reservationTimeout`). Hand
   * the `Reservation` to the player's client, which takes the seat with
   * `client.consumeReservation()` **on any process**: the reservation is
   * held where the room is, and whichever process the client connects to
   * locates it. The held seat counts against `maxClients`.
   *
   * `options` are the seat's join options (typed by the class's contract,
   * like `createRoom`'s); `createOptions` are used if a room has to be
   * created for it. Without typed options, `options` serve as both.
   */
  public reserve<R extends Room>(
    roomType: RoomClass<R>,
    ...args: ReserveArgs<R>
  ): Promise<Result<Reservation, BungohanError>>
  public reserve(
    roomType: string,
    options?: unknown,
    placement?: ProcessSelector | Placement,
    createOptions?: unknown,
  ): Promise<Result<Reservation, BungohanError>>
  public async reserve(
    roomType: string | RoomConstructor,
    options?: unknown,
    placement?: ProcessSelector | Placement,
    createOptions?: unknown,
  ): Promise<Result<Reservation, BungohanError>> {
    const name = this._nameOf(roomType)
    if (name.isErr()) return name
    const type = this._types.get(name.value)
    // Converted before any room is found or created, so options that don't
    // fit fail the call without side effects.
    if (type !== undefined) {
      const read = readServerOptions(type, "join", options)
      if (read.isErr()) {
        return err(this._error("INVALID_OPTIONS", read.error.message))
      }
    }
    const roomOptions =
      createOptions !== undefined || type?.createOptions !== undefined
        ? createOptions
        : options
    const place = resolvePlacement(placement)
    // A keyed room is the room: its seat is taken by joinById's rules.
    const byId = place.key !== undefined
    return this._findOrCreate(name.value, roomOptions, place, async (room) => {
      if (!(room instanceof RoomProxy)) {
        return this._reserveIn(room, options, byId)
      }
      const cluster = this._deps.cluster()
      if (cluster === undefined) {
        return err(this._error("INVALID_STATE", "cluster mode is not running"))
      }
      const packed = this._pack(name.value, "join", options)
      if (packed.isErr()) return packed
      return cluster.reserve(room.processId, room.id, packed.value, byId)
    })
  }

  /**
   * Holds a seat in **this** room, for a lobby that picked it (with
   * `query`, say) and must not lose it to a race with other players, as
   * a `joinById` sent to the client could. The seat, its `expiresAt` and
   * how the client consumes it are as for `reserve`.
   *
   * The room is found as `joinById` finds it, here or on any process:
   * private rooms are fine, and so is a room on a draining process. A
   * locked room is `ROOM_LOCKED`, a full one `ROOM_FULL`, and a missing
   * or disposing one `ROOM_NOT_FOUND`. `options` are the seat's join
   * options, checked against the room type's declaration where the room
   * runs.
   */
  public async reserveById(
    roomId: string,
    options?: unknown,
  ): Promise<Result<Reservation, BungohanError>> {
    const found = await this.joinById(roomId)
    if (found.isErr()) return found
    const room = found.value
    if (!(room instanceof RoomProxy))
      return this._reserveIn(room, options, true)
    const cluster = this._deps.cluster()
    if (cluster === undefined) {
      return err(this._error("INVALID_STATE", "cluster mode is not running"))
    }
    const packed = this._pack(room.roomType, "join", options)
    if (packed.isErr()) return packed
    return cluster.reserve(room.processId, room.id, packed.value, true)
  }

  /**
   * Consumes a reservation without seating anyone (the seat is freed).
   * Clients consume theirs with a `JOIN` frame instead. Local only: a
   * reservation is consumed where its room lives.
   */
  public consumeReservation(
    reservationId: string,
  ): Result<Reservation, BungohanError> {
    const taken = this._consume(reservationId)
    return taken.isErr() ? taken : ok(taken.value.reservation)
  }

  /** @internal Takes a reservation: the room and the reserve-time options. */
  public _consume(
    reservationId: string,
  ): Result<
    { reservation: Reservation; room: Room; options: unknown },
    BungohanError
  > {
    const entry = this._reservations.get(reservationId)
    if (entry === undefined) {
      return err(this._error("RESERVATION_NOT_FOUND", "unknown reservation"))
    }
    const { reservation, room } = entry
    if (entry.expired || this._deps.clock.now() > reservation.expiresAt) {
      entry.expired = true
      return err(this._error("RESERVATION_EXPIRED", "reservation expired"))
    }
    this._deps.clock.clearTimeout(entry.cleanup)
    this._reservations.delete(reservationId)
    const options = room._takeReservation(reservationId)
    if (room.isDisposed) {
      return err(this._error("ROOM_NOT_FOUND", "the room was disposed"))
    }
    return ok({ reservation, room, options })
  }

  /** @internal True while this process remembers that reservation. */
  public _hasReservation(reservationId: string): boolean {
    return this._reservations.has(reservationId)
  }

  /**
   * @internal Holds a seat in a room this process owns. Typed join options
   * are converted here, where the room is (spec §6.4.1).
   */
  public _reserveIn(
    room: Room,
    raw: unknown,
    byId = false,
  ): Result<Reservation, BungohanError> {
    if (byId) {
      const open = room._acceptsNewSeat()
      if (open.isErr()) return open
    } else if (!room.isAvailable()) {
      return err(this._error("ROOM_FULL", "the room filled up"))
    }
    const type = this._types.get(room.roomType)
    const read =
      type === undefined ? ok(raw) : readServerOptions(type, "join", raw)
    if (read.isErr()) {
      return err(this._error("INVALID_OPTIONS", read.error.message))
    }
    const options = read.value
    const seconds = type?.options.reservationTimeout ?? 60
    const { clock, createId } = this._deps
    const reservation: Reservation = {
      id: createId(21),
      roomId: room.id,
      roomType: room.roomType,
      sessionId: createId(12),
      expiresAt: clock.now() + seconds * 1000,
    }
    const entry: ReservationEntry = {
      reservation,
      room,
      expired: false,
      // Keep an expired entry around for another timeout, so a late client
      // hears RESERVATION_EXPIRED rather than RESERVATION_NOT_FOUND.
      cleanup: clock.setTimeout(
        () => this._reservations.delete(reservation.id),
        seconds * 2000,
      ),
    }
    this._reservations.set(reservation.id, entry)
    room._hold(reservation, options, seconds * 1000)
    return ok(reservation)
  }

  /** Rooms **this process** owns; a cluster's other rooms aren't here. */
  public getAllRooms(): Room[] {
    return this._deps.manager.getRooms()
  }

  /** A room **this process** owns; use `joinById` for a cluster-wide look. */
  public getRoom(id: string): Room | undefined {
    return this._deps.manager.getRoom(id)
  }

  /** Disposes the room (its clients get `LEAVE(4002)`), wherever it is. */
  public removeRoom(id: string): void {
    const room = this._deps.manager.getRoom(id)
    if (room !== undefined) {
      void room.dispose()
      return
    }
    const cluster = this._deps.cluster()
    if (cluster === undefined) return
    void cluster.locate("room", id).then((owner) => {
      if (owner !== undefined) void cluster.roomOp(owner, id, { op: "dispose" })
    })
  }

  /** This process's id (`server.processId`). */
  public getProcessId(): string {
    return this._deps.processId
  }

  /** Rooms on **this process**. */
  public getRoomCount(): number {
    return this._deps.manager.getRoomCount()
  }

  /** Seats taken across the rooms of **this process**. */
  public getClientCount(): number {
    let count = 0
    for (const room of this._deps.manager.getRooms()) {
      count += room.getClientCount()
    }
    return count
  }

  /**
   * Every process in the cluster: a request goes out on the backplane,
   * answers are collected for `cluster.gatherTimeout` ms, and this
   * process is included without a round trip. Outside cluster mode it is
   * this process alone.
   */
  public async getAllProcesses(): Promise<
    Result<ProcessInfo[], BungohanError>
  > {
    const cluster = this._deps.cluster()
    if (cluster === undefined) return ok([this._localProcess()])
    return ok(await cluster.processes())
  }

  /**
   * @internal The pending creation of a room of this type by a
   * find-or-create call, if there is one. A caller that sees one must wait
   * for it and look again rather than create a second room (spec §6.7.2).
   */
  public _creation(roomType: string): Promise<void> | undefined {
    return this._creating.get(roomType)
  }

  /**
   * @internal Registers a find-or-create of this pool (a type, or a type
   * with `where` or a key) as creating. Call it synchronously after
   * `_creation` returned nothing and the local look found no room, with
   * no await in between; await `granted` (the cluster-wide lock) before
   * looking across the cluster; release once the room is ready or won't
   * be created. Releasing twice is harmless.
   */
  public _claimCreation(pool: string): CreationClaim {
    const { promise, resolve } = Promise.withResolvers<void>()
    this._creating.set(pool, promise)
    // In a cluster, this process's one creator for the pool also takes the
    // pool's cluster-wide lock (spec §6.4.4).
    const unlock = this._deps.cluster()?.lock(pool)
    let released = false
    return {
      granted: unlock === undefined ? Promise.resolve() : unlock.then(noop),
      release: () => {
        if (released) return
        released = true
        if (this._creating.get(pool) === promise) this._creating.delete(pool)
        resolve()
        void unlock?.then((give) => give())
      },
    }
  }

  /**
   * `joinOrCreate` and `reserve`: an available room of the type, here or
   * in the cluster, or a new one, and then `take` on it. A room being
   * created by another find-or-create is waited for rather than doubled
   * (spec §6.7.2), whether that call came from here or from a client's
   * `JOIN_OR_CREATE`. When the room waited for fails to create, or fills up
   * before `take` gets a seat in it, the search starts again.
   */
  private async _findOrCreate<T>(
    name: string,
    options: unknown,
    place: ResolvedPlacement,
    take: (room: Room) => Promise<Result<T, BungohanError>>,
  ): Promise<Result<T, BungohanError>> {
    const bad = this._badKey(place.key)
    if (bad !== undefined) return err(bad)
    const known = this._types.has(name)
    const pool = poolOf(name, place)
    const { key, where } = place
    const match: PoolMatch =
      key !== undefined ? { key } : where !== undefined ? { where } : {}
    for (;;) {
      const creating = this._creating.get(pool)
      if (creating !== undefined) {
        await creating
        continue
      }
      const room = !known
        ? undefined
        : key !== undefined
          ? this._findKeyed(name, key)
          : this._findAvailable(name, [], where)
      if (room !== undefined) {
        // It failed to create, or filled up meanwhile: look again.
        if ((await this._whenReady(room)).isErr()) continue
        const taken = await take(room)
        // A keyed room is the only one: full is the answer, not a retry.
        if (isFull(taken) && key === undefined) continue
        return taken
      }
      // Nothing here: from now on this call is the one creating.
      const claim = this._claimCreation(pool)
      try {
        await claim.granted
        const cluster = this._deps.cluster()
        const found = await cluster?.findAvailable(name, [], match)
        if (cluster !== undefined && found !== undefined) {
          claim.release() // it creates nothing: let the others look too
          const proxy = await this._proxyFor(
            cluster,
            found.processId,
            found.roomId,
          )
          if (proxy.isErr()) {
            if (proxy.error.code === "ROOM_NOT_FOUND") continue
            return proxy
          }
          const taken = await take(proxy.value)
          // Filled up, or its process started draining since it answered.
          if (
            key === undefined &&
            (isFull(taken) ||
              (taken.isErr() && taken.error.code === "SERVER_SHUTTING_DOWN"))
          ) {
            continue
          }
          return taken
        }
        if (!known) {
          return err(
            this._error(
              "ROOM_TYPE_NOT_DEFINED",
              `room type "${name}" is not defined`,
            ),
          )
        }
        const created = await this._createPlaced(name, options, place)
        if (created.isErr()) return created
        // Taken before anyone waiting can look, so they can't fill it first.
        return await take(created.value)
      } finally {
        claim.release()
      }
    }
  }

  /**
   * @internal This process's room of the type with this key, ready or
   * still being created, and not being disposed. Draining doesn't hide
   * it: a key names one room, wherever it is.
   */
  public _findKeyed(roomType: string, key: string): Room | undefined {
    for (const room of this._deps.manager.getRooms()) {
      if (room.roomType === roomType && room.key === key && !room._closing) {
        return room
      }
    }
    return undefined
  }

  /**
   * A key crosses the backplane, whose serializer would replace a NUL or a
   * lone surrogate, and another process would then see another key.
   */
  private _badKey(key: string | undefined): BungohanError | undefined {
    if (key === undefined || (key.isWellFormed() && !key.includes("\0"))) {
      return undefined
    }
    return this._error(
      "INVALID_OPTIONS",
      "a room key can't contain NUL or a lone surrogate",
    )
  }

  /** The room with this key, here or on any process. */
  private async _lookupKeyed(
    roomType: string,
    key: string,
  ): Promise<Room | undefined> {
    const local = this._findKeyed(roomType, key)
    if (local !== undefined) return local
    const cluster = this._deps.cluster()
    const found = await cluster?.findAvailable(roomType, [], { key })
    if (cluster === undefined || found === undefined) return undefined
    const proxy = await this._proxyFor(cluster, found.processId, found.roomId)
    return proxy.isOk() ? proxy.value : undefined
  }

  /**
   * @internal An available room of the type, ready or still being created.
   * None while this process drains: matchmaking must stop feeding it.
   */
  public _findAvailable(
    roomType: string,
    exclude: readonly string[] = [],
    where?: Record<string, unknown>,
  ): Room | undefined {
    if (this._deps.draining()) return undefined
    for (const room of this._deps.manager.getRooms()) {
      if (room.roomType !== roomType || !room.isAvailable()) continue
      if (exclude.includes(room.id)) continue
      if (where !== undefined && !matches(room.metadata, where)) continue
      return room
    }
    return undefined
  }

  /**
   * @internal This process's listings, for a peer's `query`. None while it
   * drains, unless the caller asked for draining rooms: filtered here, at
   * the source, so they don't cross the backplane for nothing.
   */
  public _listLocal(
    roomType: string,
    metadata: Record<string, unknown> | undefined,
    includePrivate: boolean,
    includeDraining: boolean,
  ): RoomListingInfo[] {
    const out: RoomListingInfo[] = []
    if (this._deps.draining() && !includeDraining) return out
    for (const room of this._deps.manager.getRooms()) {
      if (room.roomType !== roomType || room.isDisposed) continue
      if (!room._isReady) continue
      if (room.visibility !== "public" && !includePrivate) continue
      if (metadata !== undefined && !matches(room.metadata, metadata)) continue
      out.push(this._listing(room))
    }
    return out
  }

  /** @internal How another process sees a room this one owns (spec §6.4). */
  public _roomInfo(room: Room): RoomInfo {
    return {
      id: room.id,
      roomType: room.roomType,
      processId: this._deps.processId,
      maxClients: room.maxClients,
      autoDispose: room.autoDispose,
      allowReconnection: room.allowReconnection,
      reconnectionTimeout: room.reconnectionTimeout,
      visibility: room.visibility,
      locked: room.locked,
      metadata: { ...room.metadata },
      ...(room.key === undefined ? {} : { key: room.key }),
      clientCount: room.getClientCount(),
      seatCount: room.getSeatCount(),
      disposed: room.isDisposed,
    }
  }

  /** @internal */
  public _localProcess(): ProcessInfo {
    return {
      id: this._deps.processId,
      roomCount: this.getRoomCount(),
      clientCount: this.getClientCount(),
      metadata: this._deps.metadata(),
      draining: this._deps.draining(),
    }
  }

  /** @internal Why a new room has nowhere to go. */
  public _noProcessLeft(): BungohanError {
    return this._error(
      "SERVER_SHUTTING_DOWN",
      this._deps.cluster() === undefined
        ? "this server is draining and creates no new rooms"
        : "no process can take a new room: every process is draining",
    )
  }

  /** @internal */
  public _error(code: ErrorCode, message: string): BungohanError {
    return new BungohanError(code, message, this._deps.clock.now())
  }

  /** @internal A handle on a room another process owns. */
  public _proxy(info: RoomInfo): RoomProxy {
    const cluster = this._deps.cluster()
    return new RoomProxy(
      {
        clock: this._deps.clock,
        logger: this._deps.logger,
        call: async (processId, roomId, op) => {
          if (cluster === undefined) {
            return err(
              this._error("INVALID_STATE", "cluster mode is not running"),
            )
          }
          return cluster.roomOp(processId, roomId, op)
        },
      },
      info,
    )
  }

  private async _proxyFor(
    cluster: ClusterNode,
    processId: string,
    roomId: string,
  ): Promise<Result<Room, BungohanError>> {
    const info = await cluster.roomOp(processId, roomId, { op: "info" })
    if (info.isErr()) return info
    // The owning process answered an `info` op with its own `RoomInfo`.
    return ok(this._proxy(info.value as RoomInfo))
  }

  /**
   * The room type name for a name or a registered class. A class
   * registered under several names is ambiguous, and one this process
   * never registered has no name here.
   */
  private _nameOf(
    roomType: string | RoomConstructor,
  ): Result<string, BungohanError> {
    if (typeof roomType === "string") return ok(roomType)
    const names = [...this._types.values()]
      .filter((type) => type.ctor === roomType)
      .map((type) => type.name)
    const [name] = names
    if (name === undefined) {
      return err(
        this._error(
          "ROOM_TYPE_NOT_DEFINED",
          `${roomType.name} is not a room type on this process; ` +
            "pass the room type's name instead",
        ),
      )
    }
    if (names.length > 1) {
      return err(
        this._error(
          "INVALID_OPTIONS",
          `${roomType.name} is registered as ${names
            .map((n) => `"${n}"`)
            .join(", ")}; pass the room type's name instead`,
        ),
      )
    }
    return ok(name)
  }

  /**
   * Server-built options bound for another process. Typed ones travel
   * encoded, so the owner decodes exactly what a local room would get;
   * a type this process doesn't define is sent as it is, for the owner to
   * convert.
   */
  private _pack(
    name: string,
    kind: "create" | "join",
    options: unknown,
  ): Result<unknown, BungohanError> {
    const type = this._types.get(name)
    const def = kind === "create" ? type?.createOptions : type?.joinOptions
    if (def === undefined) return ok(options)
    const packed = packOptions(def, kind, options)
    return packed.isErr()
      ? err(this._error("INVALID_OPTIONS", packed.error.message))
      : ok(packed.value)
  }

  private _type(name: string): Result<RoomTypeDef, BungohanError> {
    const type = this._types.get(name)
    return type === undefined
      ? err(
          this._error(
            "ROOM_TYPE_NOT_DEFINED",
            `room type "${name}" is not defined`,
          ),
        )
      : ok(type)
  }

  private async _whenReady(room: Room): Promise<Result<Room, BungohanError>> {
    const ready = await room._readyPromise
    if (ready?.isErr()) return ready
    return ok(room)
  }

  /**
   * Chooses the process a new room goes on, among those that aren't
   * draining, and creates it there if that isn't this process. `ok(undefined)`
   * means "here". The selector's choice is honoured; without one (this
   * process is draining) the least loaded wins. A chosen process that
   * refuses because it started draining meanwhile is struck off, and the
   * next choice is made from the same list, so the loop is bounded by the
   * cluster's size.
   */
  private async _place(
    cluster: ClusterNode,
    name: string,
    options: unknown,
    selector: ProcessSelector | undefined,
    placement: RoomPlacement,
  ): Promise<Result<Room | undefined, BungohanError>> {
    const all = await cluster.processes()
    const refused = new Set<string>()
    for (;;) {
      const offered = all.filter(
        (process) => !process.draining && !refused.has(process.id),
      )
      if (offered.length === 0) return err(this._noProcessLeft())
      const chosen =
        selector === undefined
          ? ok(leastLoaded(offered).id)
          : this._runSelector(selector, offered)
      if (chosen.isErr()) return chosen
      if (chosen.value === this._deps.processId) {
        // It may have started draining while the list was gathered.
        if (!this._deps.draining()) return ok(undefined)
        refused.add(chosen.value)
        continue
      }
      const packed = this._pack(name, "create", options)
      if (packed.isErr()) return packed
      const info = await cluster.createRoom(
        chosen.value,
        name,
        packed.value,
        placement,
      )
      if (info.isOk()) return ok(this._proxy(info.value))
      // Our own choice may land on a process without the type; a
      // selector's choice is the selector's to fix.
      const retry =
        info.error.code === "SERVER_SHUTTING_DOWN" ||
        (selector === undefined && info.error.code === "ROOM_TYPE_NOT_DEFINED")
      if (!retry) return info
      refused.add(chosen.value)
    }
  }

  /** Runs a selector over `offered` and checks what it picked. */
  private _runSelector(
    selector: ProcessSelector,
    offered: ProcessInfo[],
  ): Result<string, BungohanError> {
    let chosen: ProcessInfo
    try {
      chosen = selector(offered)
    } catch (error) {
      return err(
        this._error("INVALID_OPTIONS", `process selector threw: ${error}`),
      )
    }
    if (!offered.some((process) => process.id === chosen?.id)) {
      return err(
        this._error(
          "INVALID_OPTIONS",
          `the process selector picked "${chosen?.id}", which is not one of ` +
            `the ${offered.length} processes it was given`,
        ),
      )
    }
    return ok(chosen.id)
  }

  /** Without cluster mode there is only this process, and it must be picked. */
  private _selectLocal(
    selector: ProcessSelector | undefined,
  ): Result<void, BungohanError> {
    if (selector === undefined) return ok(undefined)
    const local = this._localProcess()
    let chosen: ProcessInfo
    try {
      chosen = selector([local])
    } catch (error) {
      return err(
        this._error("INVALID_OPTIONS", `process selector threw: ${error}`),
      )
    }
    return chosen.id === local.id
      ? ok(undefined)
      : err(
          this._error(
            "CLUSTER_NOT_IMPLEMENTED",
            "creating rooms on another process needs cluster mode " +
              "(ServerOptions.cluster.enabled)",
          ),
        )
  }

  private _listing(room: Room): RoomListingInfo {
    return {
      id: room.id,
      type: room.roomType,
      clients: room.getClientCount(),
      maxClients: room.maxClients,
      visibility: room.visibility,
      locked: room.locked,
      metadata: { ...room.metadata },
      ...(room.key === undefined ? {} : { key: room.key }),
      processId: this._deps.processId,
      draining: this._deps.draining(),
    }
  }
}

/** @internal A find-or-create's claim on creating a pool's room. */
export interface CreationClaim {
  /** Resolves once the cluster-wide lock is held (at once without one). */
  readonly granted: Promise<void>
  /** Ends the claim and gives the lock back; harmless twice. */
  readonly release: () => void
}

interface ResolvedPlacement {
  readonly selector?: ProcessSelector
  readonly where?: Record<string, MetadataValue>
  readonly key?: string
}

function resolvePlacement(
  placement: ProcessSelector | Placement | undefined,
): ResolvedPlacement {
  if (placement === undefined) return {}
  if (typeof placement === "function") return { selector: placement }
  return {
    ...(placement.process === undefined ? {} : { selector: placement.process }),
    ...(placement.where === undefined ? {} : { where: placement.where }),
    ...(placement.key === undefined ? {} : { key: placement.key }),
  }
}

/**
 * What a find-or-create creates for: the room type alone (shared with a
 * client's `JOIN_OR_CREATE`), a type plus a key, or a type plus `where`
 * values, in a form every process computes the same way. It crosses the
 * backplane in lock requests, so it's JSON: the serializer would replace
 * a NUL or a lone surrogate in a raw string, and the coordinator would
 * then file the request under another pool.
 */
export function poolOf(
  roomType: string,
  placement: { readonly where?: object; readonly key?: string },
): string {
  if (placement.key !== undefined) {
    return JSON.stringify([roomType, "key", placement.key])
  }
  if (placement.where === undefined) return roomType
  const entries = Object.entries(placement.where).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )
  return JSON.stringify([roomType, "where", entries])
}

/** True if `metadata` has every entry of `wanted` (`===`). */
function matches(
  metadata: Record<string, unknown>,
  wanted: Record<string, unknown>,
): boolean {
  for (const [key, value] of Object.entries(wanted)) {
    if (metadata[key] !== value) return false
  }
  return true
}

function isFull<T>(taken: Result<T, BungohanError>): boolean {
  return taken.isErr() && taken.error.code === "ROOM_FULL"
}

function noop(): void {}

/** Fewest rooms, then fewest seats; the first on a tie. */
function leastLoaded(processes: ProcessInfo[]): ProcessInfo {
  return processes.reduce((a, b) =>
    b.roomCount < a.roomCount ||
    (b.roomCount === a.roomCount && b.clientCount < a.clientCount)
      ? b
      : a,
  )
}
