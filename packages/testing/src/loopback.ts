import { err, ok, type Result } from "@bungohan/result"
import {
  type ConnectionContext,
  type ITransport,
  TransportError,
} from "@bungohan/transport"
import { settle } from "./settle"

/** `CloseCode.GOING_AWAY`, sent to every client by `close()`. */
const GOING_AWAY = 1001
/** Close code for an inbound frame over `maxPayloadLength` (RFC 6455). */
const MESSAGE_TOO_BIG = 1009

export interface LoopbackTransportOptions {
  /** Largest accepted client → server frame. Default 16 MiB, like WebSocketTransport. */
  maxPayloadLength?: number
  /**
   * `flush()` gives up after delivering this many events in one call
   * (a client and server replying to each other forever). Default 100,000.
   */
  maxFlushEvents?: number
}

export interface LoopbackConnectOptions {
  /** Exposed as `context.token`, as if sent via `?token=`. */
  token?: string
  searchParams?: Record<string, string>
  headers?: Record<string, string>
  ip?: string
}

/** Bytes and frames that crossed the loopback, per direction. */
export interface LoopbackStats {
  bytesToClients: number
  framesToClients: number
  bytesFromClients: number
  framesFromClients: number
}

type Event =
  | { to: "server"; kind: "message"; socket: LoopbackSocket; data: Uint8Array }
  | {
      to: "server"
      kind: "close"
      socket: LoopbackSocket
      code: number
      reason: string
    }
  | { to: "client"; kind: "message"; socket: LoopbackSocket; data: Uint8Array }
  | {
      to: "client"
      kind: "close"
      socket: LoopbackSocket
      code: number
      reason: string
    }

/**
 * An in-process `ITransport` (spec §11.2): no sockets, but a real transport
 * all the same. Only bytes cross it, so core and the client must encode and
 * decode every frame exactly as they would over WebSocket. Each frame is
 * copied at send time, like a socket write, so a sender that reuses its
 * buffer afterwards can't corrupt what the other side receives.
 *
 * Nothing is delivered until `flush()`, so tests decide exactly when frames
 * arrive. Frames and closes keep their order per direction: a close queued
 * after a frame arrives after it.
 *
 * Server handlers follow `ITransport` semantics: a throw goes to `onError`,
 * as it would in production. A throw from a *client* listener (typically a
 * failed `expect`) propagates out of `flush()`, so it fails the test.
 */
export class LoopbackTransport implements ITransport {
  private readonly _maxPayloadLength: number
  private readonly _maxFlushEvents: number
  private readonly _sockets = new Map<string, LoopbackSocket>()
  private readonly _queue: Event[] = []
  private readonly _stats: LoopbackStats = {
    bytesToClients: 0,
    framesToClients: 0,
    bytesFromClients: 0,
    framesFromClients: 0,
  }
  private _listening = false
  private _nextId = 1
  private _onConnection:
    | ((clientId: string, context: ConnectionContext) => void)
    | undefined
  private _onMessage: ((clientId: string, data: Uint8Array) => void) | undefined
  private _onDisconnect:
    | ((clientId: string, code: number, reason: string) => void)
    | undefined
  private _onError: ((error: Error) => void) | undefined

  public constructor(options: LoopbackTransportOptions = {}) {
    this._maxPayloadLength = options.maxPayloadLength ?? 16 * 1024 * 1024
    this._maxFlushEvents = options.maxFlushEvents ?? 100_000
  }

  // --- ITransport ----------------------------------------------------------

  /** The port is ignored; there is no network. */
  public async listen(_port: number): Promise<Result<void, Error>> {
    if (this._listening) {
      return err(new TransportError("INVALID_OPTIONS", "already listening"))
    }
    this._listening = true
    return ok(undefined)
  }

  /** Closes every connection with 1001, like WebSocketTransport. */
  public async close(): Promise<Result<void, Error>> {
    if (!this._listening) {
      return err(new TransportError("INVALID_OPTIONS", "not listening"))
    }
    this._listening = false
    for (const clientId of [...this._sockets.keys()]) {
      this.disconnect(clientId, GOING_AWAY, "Server shutting down")
    }
    return ok(undefined)
  }

  public send(clientId: string, data: Uint8Array): Result<void, Error> {
    const socket = this._sockets.get(clientId)
    if (socket === undefined) return err(notFound(clientId))
    this._toClient(socket, data)
    return ok(undefined)
  }

  public broadcast(clientIds: string[], data: Uint8Array): Result<void, Error> {
    const failed: string[] = []
    for (const clientId of clientIds) {
      const socket = this._sockets.get(clientId)
      if (socket === undefined) failed.push(clientId)
      else this._toClient(socket, data)
    }
    if (failed.length === 0) return ok(undefined)
    return err(
      new TransportError(
        "CONNECTION_LOST",
        `broadcast failed for ${failed.length} of ${clientIds.length} clients`,
        failed,
      ),
    )
  }

  /**
   * Stops counting the client as connected at once. The client sees the
   * close after any frames already sent to it; `onDisconnect` fires on
   * the next `flush()`.
   */
  public disconnect(
    clientId: string,
    code = 1000,
    reason = "",
  ): Result<void, Error> {
    const socket = this._sockets.get(clientId)
    if (socket === undefined) return err(notFound(clientId))
    this._sockets.delete(clientId)
    // Frames the client sent before this never reach the server now.
    socket._droppedByServer = true
    socket._closing()
    this._queue.push({ to: "client", kind: "close", socket, code, reason })
    this._queue.push({ to: "server", kind: "close", socket, code, reason })
    return ok(undefined)
  }

  public onConnection(
    cb: (clientId: string, context: ConnectionContext) => void,
  ): void {
    this._onConnection = cb
  }

  public onMessage(cb: (clientId: string, data: Uint8Array) => void): void {
    this._onMessage = cb
  }

  public onDisconnect(
    cb: (clientId: string, code: number, reason: string) => void,
  ): void {
    this._onDisconnect = cb
  }

  public onError(cb: (error: Error) => void): void {
    this._onError = cb
  }

  public getName(): string {
    return "loopback"
  }

  // --- test controls -------------------------------------------------------

  /**
   * Opens a client connection. The server's `onConnection` runs before this
   * returns. Fails if the transport isn't listening.
   */
  public connect(
    options: LoopbackConnectOptions = {},
  ): Result<LoopbackSocket, TransportError> {
    if (!this._listening) {
      return err(new TransportError("CONNECTION_FAILED", "not listening"))
    }
    const clientId = `loopback-${this._nextId++}`
    const socket = new LoopbackSocket(clientId, this)
    this._sockets.set(clientId, socket)
    const context: ConnectionContext = {
      ip: options.ip ?? "127.0.0.1",
      searchParams: new URLSearchParams(options.searchParams),
      headers: new Headers(options.headers),
    }
    if (options.token !== undefined) context.token = options.token
    this._guard(() => this._onConnection?.(clientId, context))
    return ok(socket)
  }

  /**
   * Delivers queued frames and closes, in order, until nothing is left,
   * letting async handlers settle in between (so their replies are
   * delivered too). Resolves with the number of events delivered; fails
   * with `INVALID_OPTIONS` if `maxFlushEvents` is exceeded.
   */
  public async flush(): Promise<Result<number, TransportError>> {
    let delivered = 0
    for (;;) {
      const event = this._queue.shift()
      if (event === undefined) {
        await settle()
        if (this._queue.length === 0) return ok(delivered)
        continue
      }
      if (++delivered > this._maxFlushEvents) {
        return err(
          new TransportError(
            "INVALID_OPTIONS",
            `flush delivered over ${this._maxFlushEvents} events; ` +
              "client and server may be replying to each other forever",
          ),
        )
      }
      this._deliver(event)
    }
  }

  /** Events waiting for `flush()`. */
  public pending(): number {
    return this._queue.length
  }

  public stats(): LoopbackStats {
    return { ...this._stats }
  }

  public resetStats(): void {
    this._stats.bytesToClients = 0
    this._stats.framesToClients = 0
    this._stats.bytesFromClients = 0
    this._stats.framesFromClients = 0
  }

  public getClientCount(): number {
    return this._sockets.size
  }

  public isClientConnected(clientId: string): boolean {
    return this._sockets.has(clientId)
  }

  // --- internals -----------------------------------------------------------

  /** @internal Client → server frame. */
  public _fromClient(socket: LoopbackSocket, data: Uint8Array): void {
    if (data.byteLength > this._maxPayloadLength) {
      this.disconnect(socket.clientId, MESSAGE_TOO_BIG, "Message too big")
      return
    }
    this._stats.bytesFromClients += data.byteLength
    this._stats.framesFromClients++
    this._queue.push({
      to: "server",
      kind: "message",
      socket,
      data: data.slice(),
    })
  }

  /** @internal Client-initiated close. */
  public _clientClose(socket: LoopbackSocket, code: number, reason: string) {
    if (this._sockets.get(socket.clientId) !== socket) return
    this._sockets.delete(socket.clientId)
    this._queue.push({ to: "server", kind: "close", socket, code, reason })
    this._queue.push({ to: "client", kind: "close", socket, code, reason })
  }

  private _toClient(socket: LoopbackSocket, data: Uint8Array): void {
    this._stats.bytesToClients += data.byteLength
    this._stats.framesToClients++
    this._queue.push({
      to: "client",
      kind: "message",
      socket,
      data: data.slice(),
    })
  }

  private _deliver(event: Event): void {
    if (event.to === "client") {
      if (event.kind === "message") event.socket._receive(event.data)
      else event.socket._closed(event.code, event.reason)
      return
    }
    const { clientId } = event.socket
    if (event.kind === "message") {
      if (event.socket._droppedByServer) return
      this._guard(() => this._onMessage?.(clientId, event.data))
    } else {
      this._guard(() =>
        this._onDisconnect?.(clientId, event.code, event.reason),
      )
    }
  }

  /** Runs a server handler; a throw goes to `onError` (or the console). */
  private _guard(run: () => void): void {
    try {
      run()
    } catch (error) {
      const wrapped = error instanceof Error ? error : new Error(String(error))
      try {
        if (this._onError !== undefined) this._onError(wrapped)
        else console.error("[bungohan/testing] handler threw", wrapped)
      } catch (inner) {
        console.error("[bungohan/testing] onError threw", inner)
      }
    }
  }
}

export type LoopbackReadyState = "open" | "closing" | "closed"

/**
 * The client end of a loopback connection: a minimal WebSocket-like
 * surface for client implementations to run on.
 */
export class LoopbackSocket {
  public readonly clientId: string
  /** @internal Set when the server disconnects this client. */
  public _droppedByServer = false
  private readonly _transport: LoopbackTransport
  private _state: LoopbackReadyState = "open"
  private readonly _messageListeners = new Set<(data: Uint8Array) => void>()
  private readonly _closeListeners = new Set<
    (code: number, reason: string) => void
  >()

  public constructor(clientId: string, transport: LoopbackTransport) {
    this.clientId = clientId
    this._transport = transport
  }

  public get readyState(): LoopbackReadyState {
    return this._state
  }

  /** Queues a frame to the server; false once the socket is closing. */
  public send(data: Uint8Array): boolean {
    if (this._state !== "open") return false
    this._transport._fromClient(this, data)
    return true
  }

  public close(code = 1000, reason = ""): void {
    if (this._state !== "open") return
    this._state = "closing"
    this._transport._clientClose(this, code, reason)
  }

  public onMessage(listener: (data: Uint8Array) => void): () => void {
    this._messageListeners.add(listener)
    return () => this._messageListeners.delete(listener)
  }

  public onClose(listener: (code: number, reason: string) => void): () => void {
    this._closeListeners.add(listener)
    return () => this._closeListeners.delete(listener)
  }

  /** @internal */
  public _closing(): void {
    if (this._state === "open") this._state = "closing"
  }

  /** @internal */
  public _receive(data: Uint8Array): void {
    if (this._state === "closed") return
    for (const listener of [...this._messageListeners]) listener(data)
  }

  /** @internal */
  public _closed(code: number, reason: string): void {
    if (this._state === "closed") return
    this._state = "closed"
    for (const listener of [...this._closeListeners]) listener(code, reason)
  }
}

function notFound(clientId: string): TransportError {
  return new TransportError(
    "CLIENT_NOT_FOUND",
    `client ${clientId} not connected`,
  )
}
