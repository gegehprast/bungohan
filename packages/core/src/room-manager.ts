import { err, ok, type Result } from "@bungohan/result"
import type { BungohanError } from "./errors"
import type { Room, RoomHost, RoomPlacement } from "./room"
import type { RoomTypeDef } from "./room-type"

type RoomCallback = (room: Room) => void

/**
 * The rooms of this process (`server.getRoomManager()`). Creates them
 * (registering each at once, so a concurrent `joinOrCreate` finds the room
 * being created instead of making a second one) and announces creation
 * and disposal. In cluster mode, other processes' rooms aren't here; use
 * the matchmaker to look across the cluster.
 */
export class RoomManager {
  private readonly _host: RoomHost
  private readonly _rooms = new Map<string, Room>()
  private readonly _created = new Set<RoomCallback>()
  private readonly _disposed = new Set<RoomCallback>()
  private readonly _report: (error: unknown) => void

  public constructor(host: RoomHost, report: (error: unknown) => void) {
    this._host = host
    this._report = report
  }

  /**
   * A room finished `onCreate` successfully (one whose `onCreate` failed
   * never fires either event). Returns a function that removes the
   * listener; a throw is reported to `server.onError`.
   */
  public onRoomCreated(cb: RoomCallback): () => void {
    this._created.add(cb)
    return () => this._created.delete(cb)
  }

  /**
   * A room finished disposing (after its `onDispose`) and is gone from
   * this manager. Returns a function that removes the listener.
   */
  public onRoomDisposed(cb: RoomCallback): () => void {
    this._disposed.add(cb)
    return () => this._disposed.delete(cb)
  }

  /** A room of this process by id, including one still being created. */
  public getRoom(id: string): Room | undefined {
    return this._rooms.get(id)
  }

  /**
   * Every room of this process (a copy), including ones still being
   * created or disposed; check `room.isDisposed` if that matters.
   */
  public getRooms(): Room[] {
    return [...this._rooms.values()]
  }

  /** How many rooms `getRooms()` would return. */
  public getRoomCount(): number {
    return this._rooms.size
  }

  /**
   * @internal Instantiates and registers a room synchronously, then runs
   * `onCreate` in the background. The returned room is findable at once;
   * await `room._readyPromise` before using it.
   */
  public _create(
    type: RoomTypeDef,
    options: unknown,
    placement?: RoomPlacement,
  ): Room {
    const room = new type.ctor()
    room._setup(this._host, type, this._host.createId(10))
    this._rooms.set(room.id, room)
    room._readyPromise = room._create(options, placement).then((created) => {
      if (created.isErr()) {
        void room.dispose()
        return created
      }
      if (this._host.metrics !== undefined) {
        this._host.metrics.totalRoomsCreated++
      }
      this._emit(this._created, room)
      return created
    })
    return room
  }

  /** @internal Creates a room and waits for `onCreate`. */
  public async _createReady(
    type: RoomTypeDef,
    options: unknown,
    placement?: RoomPlacement,
  ): Promise<Result<Room, BungohanError>> {
    const room = this._create(type, options, placement)
    const ready = await room._readyPromise
    if (ready === undefined || ready.isOk()) return ok(room)
    return err(ready.error)
  }

  /** @internal From the host, once a room finished disposing. */
  public _removed(room: Room): void {
    if (this._rooms.get(room.id) !== room) return
    this._rooms.delete(room.id)
    if (room._isReady) {
      if (this._host.metrics !== undefined) {
        this._host.metrics.totalRoomsDisposed++
      }
      this._emit(this._disposed, room)
    }
  }

  private _emit(callbacks: Set<RoomCallback>, room: Room): void {
    for (const cb of [...callbacks]) {
      try {
        cb(room)
      } catch (error) {
        this._report(error)
      }
    }
  }
}
