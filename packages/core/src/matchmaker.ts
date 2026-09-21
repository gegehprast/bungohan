import { err, ok, type Result } from "@bungohan/result"
import type { Clock, Reservation, TimerId } from "@bungohan/types"
import type { ClusterNode } from "./cluster/node"
import type { RoomInfo } from "./cluster/protocol"
import { RoomProxy } from "./cluster/proxy"
import { BungohanError, type ErrorCode } from "./errors"
import type { Logger } from "./logger"
import type { Room } from "./room"
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
  readonly createId: (size: number) => string
}

let current: MatchMaker | undefined

/**
 * The matchmaker of the most recently created server (spec §6.3). Throws if
 * no server exists yet: calling it before creating one is a setup error.
 */
export function getMatchMaker(): MatchMaker {
  if (current === undefined) {
    throw new Error("getMatchMaker(): no Bungohan server has been created")
  }
  return current
}

/** @internal */
export function setMatchMaker(matchMaker: MatchMaker): void {
  current = matchMaker
}

/**
 * Finds, creates and reserves rooms (spec §6.3).
 *
 * With cluster mode on (§6.4) every lookup is local first and cluster-wide
 * second: a room found on another process comes back as a {@link RoomProxy}
 * with the same `Room` type. Without it, a `ProcessSelector` that picks a
 * process other than this one is `CLUSTER_NOT_IMPLEMENTED`, since there is
 * no cluster to route to.
 */
export class MatchMaker {
  private readonly _deps: MatchMakerDeps
  private readonly _types = new Map<string, RoomTypeDef>()
  private readonly _reservations = new Map<string, ReservationEntry>()

  public constructor(deps: MatchMakerDeps) {
    this._deps = deps
  }

  /**
   * Registers a room type. Validates its contract and every Schema class
   * reachable from its state, and **throws** a `TypeError` listing every
   * problem, or if the name is taken. Definition time only (spec §6.8).
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
  }

  /** @internal */
  public _getType(name: string): RoomTypeDef | undefined {
    return this._types.get(name)
  }

  /**
   * Creates a room, here or (with a selector, in cluster mode) on another
   * process. Pass the room **class** to have its create options typed
   * (spec §4.1.2); a name takes anything, checked when it is converted.
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
    processSelector?: ProcessSelector,
  ): Promise<Result<Room, BungohanError>>
  public async createRoom(
    roomType: string | RoomConstructor,
    options?: unknown,
    processSelector?: ProcessSelector,
  ): Promise<Result<Room, BungohanError>> {
    const name = this._nameOf(roomType)
    if (name.isErr()) return name
    const cluster = this._deps.cluster()
    if (cluster !== undefined && processSelector !== undefined) {
      const chosen = await this._select(cluster, processSelector)
      if (chosen.isErr()) return chosen
      if (chosen.value !== this._deps.processId) {
        const packed = this._pack(name.value, "create", options)
        if (packed.isErr()) return packed
        const info = await cluster.createRoom(
          chosen.value,
          name.value,
          packed.value,
        )
        return info.isErr() ? info : ok(this._proxy(info.value))
      }
    } else {
      const local = this._selectLocal(processSelector)
      if (local.isErr()) return local
    }
    const type = this._type(name.value)
    if (type.isErr()) return type
    const read = readServerOptions(type.value, "create", options)
    if (read.isErr()) {
      return err(this._error("INVALID_OPTIONS", read.error.message))
    }
    return this._deps.manager._createReady(type.value, read.value)
  }

  /**
   * An available room of the type (public, unlocked, not full); doesn't
   * seat anyone. Looks on this process first, then across the cluster.
   */
  public async joinRoom(
    roomType: string,
    _options?: unknown,
  ): Promise<Result<Room, BungohanError>> {
    const known = this._types.has(roomType)
    const room = known ? this._findAvailable(roomType) : undefined
    if (room !== undefined) return this._whenReady(room)
    const cluster = this._deps.cluster()
    if (cluster !== undefined) {
      const found = await cluster.findAvailable(roomType)
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
    processSelector?: ProcessSelector,
  ): Promise<Result<Room, BungohanError>>
  public async joinOrCreate(
    roomType: string | RoomConstructor,
    options?: unknown,
    processSelector?: ProcessSelector,
  ): Promise<Result<Room, BungohanError>> {
    const name = this._nameOf(roomType)
    if (name.isErr()) return name
    const found = await this.joinRoom(name.value, options)
    if (found.isOk()) return found
    if (found.error.code !== "ROOM_NOT_FOUND") return found
    return this.createRoom(name.value, options, processSelector)
  }

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
   * this process holds; `metadata` is matched on each process.
   */
  public async query(
    options: MatchMakerQueryOptions,
  ): Promise<Result<RoomListingInfo[], BungohanError>> {
    const includePrivate = options.includePrivate === true
    const listings = this._listLocal(
      options.type,
      options.metadata,
      includePrivate,
    )
    const cluster = this._deps.cluster()
    if (cluster !== undefined) {
      listings.push(
        ...(await cluster.query(
          options.type,
          options.metadata,
          includePrivate,
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
   * `sessionId`, until `expiresAt`. A client takes it with a `JOIN` in mode
   * `CONSUME_RESERVATION` (spec §6.7.5), **on any process**: the reservation
   * is held where the room is, and whichever process the client connects to
   * locates it (spec §6.4).
   */
  public reserve<R extends Room>(
    roomType: RoomClass<R>,
    ...args: ReserveArgs<R>
  ): Promise<Result<Reservation, BungohanError>>
  public reserve(
    roomType: string,
    options?: unknown,
    processSelector?: ProcessSelector,
    createOptions?: unknown,
  ): Promise<Result<Reservation, BungohanError>>
  /**
   * `options` are the seat's join options (typed by the class's contract,
   * like `createRoom`'s); `createOptions` are used if a room has to be
   * created for it. Without typed options, `options` serve as both, as
   * they always did.
   */
  public async reserve(
    roomType: string | RoomConstructor,
    options?: unknown,
    processSelector?: ProcessSelector,
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
    const found = await this.joinOrCreate(
      name.value,
      roomOptions,
      processSelector,
    )
    if (found.isErr()) return found
    const room = found.value
    if (room instanceof RoomProxy) {
      const cluster = this._deps.cluster()
      if (cluster === undefined) {
        return err(this._error("INVALID_STATE", "cluster mode is not running"))
      }
      const packed = this._pack(name.value, "join", options)
      if (packed.isErr()) return packed
      return cluster.reserve(room.processId, room.id, packed.value)
    }
    return this._reserveIn(room, options)
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
  ): Result<Reservation, BungohanError> {
    if (!room.isAvailable()) {
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

  public getProcessId(): string {
    return this._deps.processId
  }

  public getRoomCount(): number {
    return this._deps.manager.getRoomCount()
  }

  public getClientCount(): number {
    let count = 0
    for (const room of this._deps.manager.getRooms()) {
      count += room.getClientCount()
    }
    return count
  }

  /**
   * Every process in the cluster (spec §6.4): a `PROCESS_INFO` request goes
   * out on the backplane, answers are collected for a short window, and
   * this process is included without a round trip. Outside cluster mode it
   * is this process alone.
   */
  public async getAllProcesses(): Promise<
    Result<ProcessInfo[], BungohanError>
  > {
    const cluster = this._deps.cluster()
    if (cluster === undefined) return ok([this._localProcess()])
    return ok(await cluster.processes())
  }

  /** @internal An available room of the type, ready or still being created. */
  public _findAvailable(
    roomType: string,
    exclude: readonly string[] = [],
  ): Room | undefined {
    for (const room of this._deps.manager.getRooms()) {
      if (room.roomType !== roomType || !room.isAvailable()) continue
      if (exclude.includes(room.id)) continue
      return room
    }
    return undefined
  }

  /** @internal This process's listings, for a peer's `query`. */
  public _listLocal(
    roomType: string,
    metadata: Record<string, unknown> | undefined,
    includePrivate: boolean,
  ): RoomListingInfo[] {
    const out: RoomListingInfo[] = []
    for (const room of this._deps.manager.getRooms()) {
      if (room.roomType !== roomType || room.isDisposed) continue
      if (!room._isReady) continue
      if (room.visibility !== "public" && !includePrivate) continue
      if (metadata !== undefined) {
        const wanted = Object.entries(metadata)
        if (wanted.some(([key, value]) => room.metadata[key] !== value)) {
          continue
        }
      }
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
    }
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

  /** Runs a selector over the real cluster list and checks what it picked. */
  private async _select(
    cluster: ClusterNode,
    selector: ProcessSelector,
  ): Promise<Result<string, BungohanError>> {
    const processes = await cluster.processes()
    let chosen: ProcessInfo
    try {
      chosen = selector(processes)
    } catch (error) {
      return err(
        this._error("INVALID_OPTIONS", `process selector threw: ${error}`),
      )
    }
    if (!processes.some((process) => process.id === chosen?.id)) {
      return err(
        this._error(
          "INVALID_OPTIONS",
          `the process selector picked "${chosen?.id}", which is not one of ` +
            `the ${processes.length} processes it was given`,
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
      processId: this._deps.processId,
    }
  }
}
