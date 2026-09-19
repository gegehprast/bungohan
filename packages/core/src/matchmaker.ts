import { err, ok, type Result } from "@bungohan/result"
import type { Clock, Reservation, TimerId } from "@bungohan/types"
import { BungohanError, type ErrorCode } from "./errors"
import type { Room } from "./room"
import type { RoomManager } from "./room-manager"
import { createRoomType, type RoomTypeDef } from "./room-type"
import type {
  DefineRoomOptions,
  MatchMakerQueryOptions,
  ProcessInfo,
  ProcessSelector,
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
  readonly processId: string
  readonly clusterEnabled: boolean
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
 * Finds, creates and reserves rooms (spec §6.3). Single-process: the
 * cross-process paths (a `ProcessSelector` choosing another process) return
 * `CLUSTER_NOT_IMPLEMENTED` until cluster mode (§6.4) is built.
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

  public async createRoom(
    roomType: string,
    options?: unknown,
    processSelector?: ProcessSelector,
  ): Promise<Result<Room, BungohanError>> {
    const type = this._type(roomType)
    if (type.isErr()) return type
    const local = this._selectLocal(processSelector)
    if (local.isErr()) return local
    return this._deps.manager._createReady(type.value, options)
  }

  /** An available room of the type (public, unlocked, not full); doesn't seat anyone. */
  public async joinRoom(
    roomType: string,
    _options?: unknown,
  ): Promise<Result<Room, BungohanError>> {
    const type = this._type(roomType)
    if (type.isErr()) return type
    const room = this._findAvailable(roomType)
    if (room === undefined) {
      return err(
        this._error(
          "ROOM_NOT_FOUND",
          `no available room of type "${roomType}"`,
        ),
      )
    }
    return this._whenReady(room)
  }

  public async joinOrCreate(
    roomType: string,
    options?: unknown,
    processSelector?: ProcessSelector,
  ): Promise<Result<Room, BungohanError>> {
    const found = await this.joinRoom(roomType, options)
    if (found.isOk()) return found
    if (found.error.code !== "ROOM_NOT_FOUND") return found
    return this.createRoom(roomType, options, processSelector)
  }

  public async joinById(
    roomId: string,
    _options?: unknown,
  ): Promise<Result<Room, BungohanError>> {
    const room = this._deps.manager.getRoom(roomId)
    if (room === undefined || room.isDisposed) {
      return err(this._error("ROOM_NOT_FOUND", `room "${roomId}" not found`))
    }
    return this._whenReady(room)
  }

  public async query(
    options: MatchMakerQueryOptions,
  ): Promise<Result<RoomListingInfo[], BungohanError>> {
    const out: RoomListingInfo[] = []
    for (const room of this._deps.manager.getRooms()) {
      if (room.roomType !== options.type || room.isDisposed) continue
      if (!room._isReady) continue
      if (room.visibility !== "public" && options.includePrivate !== true) {
        continue
      }
      if (options.metadata !== undefined) {
        const wanted = Object.entries(options.metadata)
        if (wanted.some(([key, value]) => room.metadata[key] !== value)) {
          continue
        }
      }
      const listing = this._listing(room)
      if (options.filters?.some((filter) => !filter(listing)) === true) {
        continue
      }
      out.push(listing)
      if (options.limit !== undefined && out.length >= options.limit) break
    }
    return ok(out)
  }

  /**
   * Holds a seat in an available (or new) room of the type under a new
   * `sessionId`, until `expiresAt`. A client takes it with a `JOIN` in mode
   * `CONSUME_RESERVATION` (spec §6.7.5).
   */
  public async reserve(
    roomType: string,
    options?: unknown,
    processSelector?: ProcessSelector,
  ): Promise<Result<Reservation, BungohanError>> {
    const found = await this.joinOrCreate(roomType, options, processSelector)
    if (found.isErr()) return found
    const room = found.value
    if (!room.isAvailable()) {
      return err(this._error("ROOM_FULL", "the room filled up"))
    }
    const type = this._types.get(roomType)
    const seconds = type?.options.reservationTimeout ?? 60
    const { clock, createId } = this._deps
    const reservation: Reservation = {
      id: createId(21),
      roomId: room.id,
      roomType,
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

  /**
   * Consumes a reservation without seating anyone (the seat is freed).
   * Clients consume theirs with a `JOIN` frame instead.
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

  public getAllRooms(): Room[] {
    return this._deps.manager.getRooms()
  }

  public getRoom(id: string): Room | undefined {
    return this._deps.manager.getRoom(id)
  }

  /** Disposes the room (its clients get `LEAVE(4002)`). */
  public removeRoom(id: string): void {
    void this._deps.manager.getRoom(id)?.dispose()
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

  /** This process only; cluster aggregation (§6.4) is not built yet. */
  public async getAllProcesses(): Promise<
    Result<ProcessInfo[], BungohanError>
  > {
    if (this._deps.clusterEnabled) {
      return err(
        this._error(
          "CLUSTER_NOT_IMPLEMENTED",
          "cross-process aggregation is not implemented yet",
        ),
      )
    }
    return ok([this._localProcess()])
  }

  /** @internal An available room of the type, ready or still being created. */
  public _findAvailable(roomType: string): Room | undefined {
    for (const room of this._deps.manager.getRooms()) {
      if (room.roomType === roomType && room.isAvailable()) return room
    }
    return undefined
  }

  /** @internal */
  public _error(code: ErrorCode, message: string): BungohanError {
    return new BungohanError(code, message, this._deps.clock.now())
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

  /** Runs a selector over the (single-process) list; it must pick us. */
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
            "creating rooms on another process needs cluster mode",
          ),
        )
  }

  private _localProcess(): ProcessInfo {
    return {
      id: this._deps.processId,
      roomCount: this.getRoomCount(),
      clientCount: this.getClientCount(),
    }
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
