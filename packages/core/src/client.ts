import type { ConnectionContext } from "@bungohan/transport"
import type { ClientStats } from "./metrics"
import type { Room } from "./room"

/**
 * A seat this connection holds in a room owned by **another** process, in
 * cluster mode. There is no local `Client` for it: the owning process
 * holds that, and this process only relays bytes.
 */
export interface RemoteSeat {
  /** The process the room runs on. */
  readonly processId: string
  /** The room's id. */
  readonly roomId: string
  /** The seat's `sessionId` in that room. */
  readonly sessionId: string
}

/**
 * One client connection (a browser tab, say), as `server.onConnect`
 * reports it. A connection can hold seats in several rooms at once, each
 * a {@link Client}. A seat outlives its connection while it is held for
 * reconnection, and then moves to the new one.
 */
export class Connection {
  /** Transport client id. */
  public readonly id: string
  /**
   * What the transport knew when the connection opened: address,
   * headers, query and `token`. `onAuth` receives it too.
   */
  public readonly context: ConnectionContext
  /** When it opened, on the server's clock. */
  public readonly connectedAt: number
  /** @internal Seats of this connection by roomRef. */
  public readonly _seats = new Map<number, Client>()
  /** @internal Seats in rooms on other processes, by roomRef (spec §6.4). */
  public readonly _remoteSeats = new Map<number, RemoteSeat>()
  /**
   * @internal Every process this connection has ever taken a seat on. Kept
   * after the seats end, so the close is still reported and the owning
   * process can forget the connection (spec §6.4).
   */
  public readonly _remoteOwners = new Set<string>()
  /** @internal Next roomRef; handles are never reused (spec §6.7.1). */
  public _nextRoomRef = 1
  /** @internal */
  public _open = true

  public constructor(id: string, context: ConnectionContext, now: number) {
    this.id = id
    this.context = context
    this.connectedAt = now
  }

  /** False once the transport reported the close. */
  public get open(): boolean {
    return this._open
  }

  /** Clients (room seats) this connection currently holds. */
  public getClients(): Client[] {
    return [...this._seats.values()]
  }
}

/** Where a seat is in its life (`client.status`). */
export type ClientStatus =
  /** Seated; `onAuth`/`onJoin` still running. Frames to it are queued. */
  | "joining"
  /** Joined and connected. */
  | "joined"
  /** Connection lost; the seat is held for reconnection. */
  | "reconnecting"
  /** The seat is released. */
  | "left"

/**
 * A client's seat in one room: what the room's hooks and message handlers
 * receive. The same object survives a reconnection: `sessionId` is
 * stable, only `connection` changes. Use `sessionId` (or `id`, the same
 * value) to key per-player state.
 */
export class Client {
  /** Stable for the life of the seat, across reconnections. */
  public readonly sessionId: string
  /** Data returned by `onAuth` (`{}` when it returned `true`). */
  public auth: Record<string, unknown> = {}
  /** Free for game code. */
  public userData: unknown = undefined
  /** @internal */
  public _status: ClientStatus = "joining"
  /** @internal The current connection; undefined while disconnected. */
  public _connection: Connection | undefined
  /** @internal Handle of this seat on `_connection`. */
  public _roomRef = 0
  /** @internal Frames queued while joining (sent after JOIN_SUCCESS). */
  public _queue: Uint8Array[] | undefined = []
  /** @internal True once a snapshot was sent on the current connection. */
  public _synced = false
  /**
   * @internal When this seat's socket fell behind and state sync was
   * paused (spec §6.9), by the server's clock; undefined when keeping up.
   * A paused seat is sent no patches, and gets a fresh snapshot once its
   * queue drains, because patches are deltas and can't be skipped.
   */
  public _pausedSince: number | undefined
  /** @internal */
  public _reconnectionToken: string | undefined
  /** @internal The room this seat belongs to. */
  public _room: Room | undefined
  /** @internal Metrics; undefined when metrics are off. */
  public _stats: ClientStats | undefined

  public constructor(sessionId: string, connection?: Connection) {
    this.sessionId = sessionId
    this._connection = connection
  }

  /** Same as `sessionId`; what `createFiltered` filters receive (`client.id`). */
  public get id(): string {
    return this.sessionId
  }

  /**
   * `"joining"` while `onAuth`/`onJoin` run, `"joined"`, `"reconnecting"`
   * while the seat is held, and `"left"` once released.
   */
  public get status(): ClientStatus {
    return this._status
  }

  /** True while the client has a live connection to its room. */
  public get connected(): boolean {
    return this._connection !== undefined && this._status !== "left"
  }

  /** The room this seat is in (until it leaves). */
  public get room(): Room | undefined {
    return this._status === "left" ? undefined : this._room
  }

  /** The connection this seat is on, if it is currently connected. */
  public get connection(): Connection | undefined {
    return this._connection
  }
}
