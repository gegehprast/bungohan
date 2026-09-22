import { err, ok, type Result } from "@bungohan/result"
import type { Server, ServerWebSocket } from "bun"
import { nanoid } from "nanoid"
import { reason, TransportError } from "./errors"
import { negotiateProtocol, PROTOCOL_ERROR, parseProtocols } from "./protocol"
import type { ConnectionContext, ITransport } from "./transport"

export interface WebSocketTransportOptions {
  /** Largest accepted inbound frame, in bytes. Default 16 MiB. */
  maxPayloadLength?: number
  /** Seconds without traffic before Bun closes a connection. Default 120. */
  idleTimeout?: number
  /**
   * Negotiate permessage-deflate and compress outbound frames of at least
   * `compressionThreshold` bytes. Default `true`.
   */
  compression?: boolean
  /**
   * Smallest outbound frame worth compressing, in bytes. Default 128.
   * Deflate adds ~6 bytes of framing, so it enlarges small frames: an 8-byte
   * position delta becomes 14 bytes. It breaks even around 60–85 bytes of
   * MessagePack and saves ~40% by 128 bytes (measured on Bun 1.3).
   */
  compressionThreshold?: number
}

export interface WebSocketListenOptions {
  /** Interface to bind. Default `"0.0.0.0"`. */
  hostname?: string
}

interface SocketData {
  clientId: string
  context: ConnectionContext
  /** Set when the protocol version was rejected: close on open. */
  rejection?: string
}

type Socket = ServerWebSocket<SocketData>

/** Close code for a server shutdown (`CloseCode.GOING_AWAY`). */
const GOING_AWAY = 1001

/** `Authorization: Bearer <token>` (scheme is case-insensitive). */
function bearerToken(headers: Headers): string | undefined {
  const match = /^bearer\s+(\S+)\s*$/i.exec(headers.get("authorization") ?? "")
  return match?.[1]
}

function isPort(port: number): boolean {
  return Number.isInteger(port) && port >= 0 && port <= 65535
}

/**
 * `ITransport` over Bun's native WebSocket server (`Bun.serve`).
 *
 * Clients connect to any path; the auth token is taken from `?token=` or an
 * `Authorization: Bearer` header and exposed on the connection context.
 * Non-upgrade HTTP requests get `426 Upgrade Required`.
 */
export class WebSocketTransport implements ITransport {
  private readonly _maxPayloadLength: number
  private _protocols: readonly string[] | undefined
  private readonly _idleTimeout: number
  private readonly _compression: boolean
  private readonly _compressionThreshold: number
  private readonly _clients = new Map<string, Socket>()
  private _server: Server<SocketData> | undefined = undefined
  private _onConnection:
    | ((clientId: string, context: ConnectionContext) => void)
    | undefined
  private _onMessage: ((clientId: string, data: Uint8Array) => void) | undefined
  private _onDisconnect:
    | ((clientId: string, code: number, reason: string) => void)
    | undefined
  private _onError: ((error: Error) => void) | undefined

  public constructor(options: WebSocketTransportOptions = {}) {
    this._maxPayloadLength = options.maxPayloadLength ?? 16 * 1024 * 1024
    this._idleTimeout = options.idleTimeout ?? 120
    this._compression = options.compression ?? true
    this._compressionThreshold = options.compressionThreshold ?? 128
  }

  public async listen(
    port: number,
    options: WebSocketListenOptions = {},
  ): Promise<Result<void, Error>> {
    if (this._server !== undefined) {
      return err(new TransportError("INVALID_OPTIONS", "already listening"))
    }
    if (!isPort(port)) {
      return err(new TransportError("INVALID_OPTIONS", `invalid port ${port}`))
    }
    try {
      this._server = Bun.serve({
        port,
        hostname: options.hostname ?? "0.0.0.0",
        fetch: (request, server) => this._upgrade(request, server),
        websocket: {
          data: {} as SocketData,
          maxPayloadLength: this._maxPayloadLength,
          idleTimeout: this._idleTimeout,
          perMessageDeflate: this._compression,
          open: (ws) => this._opened(ws),
          message: (ws, message) => this._received(ws, message),
          close: (ws, code, closeReason) => this._closed(ws, code, closeReason),
        },
      })
      return ok(undefined)
    } catch (error) {
      return err(
        new TransportError(
          "CONNECTION_FAILED",
          `failed to listen on port ${port}: ${reason(error)}`,
        ),
      )
    }
  }

  /**
   * Closes every client with 1001 ("Server shutting down"); the port is
   * released as soon as this resolves.
   */
  public async close(): Promise<Result<void, Error>> {
    const server = this._server
    if (server === undefined) {
      return err(new TransportError("INVALID_OPTIONS", "not listening"))
    }
    this._server = undefined
    try {
      for (const ws of [...this._clients.values()]) {
        ws.close(GOING_AWAY, "Server shutting down")
      }
      // Every socket is closing, so a graceful stop has nothing to wait for
      // and flushes what Bun still holds (e.g. the upgrade response to a
      // client that has only just connected); `stop(true)` would drop it.
      // Not awaited: on Bun 1.3.13 the promise returned by `stop()` never
      // settles once the server has initiated a WebSocket close, although
      // the port is released at once and the close frames are delivered.
      server.stop(false).catch((error: unknown) => {
        this._guard(() => {
          throw error
        })
      })
      return ok(undefined)
    } catch (error) {
      return err(
        new TransportError(
          "CONNECTION_FAILED",
          `failed to stop: ${reason(error)}`,
        ),
      )
    }
  }

  public send(clientId: string, data: Uint8Array): Result<void, Error> {
    const ws = this._clients.get(clientId)
    if (ws === undefined) return err(this._notFound(clientId))
    return this._sendTo(ws, data, this._shouldCompress(data))
  }

  public broadcast(clientIds: string[], data: Uint8Array): Result<void, Error> {
    const compress = this._shouldCompress(data)
    const failed: string[] = []
    for (const clientId of clientIds) {
      const ws = this._clients.get(clientId)
      if (ws === undefined || this._sendTo(ws, data, compress).isErr()) {
        failed.push(clientId)
      }
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

  public disconnect(
    clientId: string,
    code = 1000,
    closeReason = "",
  ): Result<void, Error> {
    const ws = this._clients.get(clientId)
    if (ws === undefined) return err(this._notFound(clientId))
    this._clients.delete(clientId)
    try {
      ws.close(code, closeReason)
      return ok(undefined)
    } catch (error) {
      return err(
        new TransportError(
          "INVALID_OPTIONS",
          `failed to close ${clientId}: ${reason(error)}`,
        ),
      )
    }
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

  public acceptProtocols(protocols: readonly string[]): void {
    this._protocols = [...protocols]
  }

  public getName(): string {
    return "websocket"
  }

  /** Open connections (not counting ones being rejected). */
  public getClientCount(): number {
    return this._clients.size
  }

  /** Whether `send` to this client would find it. */
  public isClientConnected(clientId: string): boolean {
    return this._clients.has(clientId)
  }

  /** Bun's own count: `ServerWebSocket.getBufferedAmount()`. */
  public bufferedAmount(clientId: string): number {
    return this._clients.get(clientId)?.getBufferedAmount() ?? 0
  }

  public getPort(): number | undefined {
    return this._server?.port
  }

  // --- Bun callbacks -------------------------------------------------------

  private _upgrade(
    request: Request,
    server: Server<SocketData>,
  ): Response | undefined {
    const url = new URL(request.url)
    const context: ConnectionContext = {
      ip: server.requestIP(request)?.address ?? "unknown",
      searchParams: url.searchParams,
      headers: request.headers,
    }
    const token = url.searchParams.get("token") ?? bearerToken(request.headers)
    if (token !== undefined && token !== "") context.token = token
    const negotiated = negotiateProtocol(
      parseProtocols(request.headers.get("sec-websocket-protocol")),
      this._protocols,
    )
    const data: SocketData = { clientId: nanoid(), context }
    // Answer with the chosen protocol, or (when rejecting) with the
    // client's own offer, so the upgrade succeeds and the client can read
    // the close reason. Browsers can't read an HTTP error body.
    const answer = negotiated.ok ? negotiated.protocol : negotiated.echo
    if (negotiated.ok && negotiated.protocol !== undefined) {
      context.protocol = negotiated.protocol
    }
    if (!negotiated.ok) data.rejection = negotiated.reason
    const headers =
      answer === undefined ? undefined : { "Sec-WebSocket-Protocol": answer }
    if (
      server.upgrade(
        request,
        headers === undefined ? { data } : { data, headers },
      )
    ) {
      return undefined
    }
    return new Response("Upgrade Required", { status: 426 })
  }

  private _opened(ws: Socket): void {
    const { clientId, context, rejection } = ws.data
    if (rejection !== undefined) {
      ws.close(PROTOCOL_ERROR, rejection)
      return
    }
    this._clients.set(clientId, ws)
    this._guard(() => this._onConnection?.(clientId, context))
  }

  private _received(ws: Socket, message: string | Uint8Array): void {
    // The protocol is binary; a text frame is passed on as its UTF-8 bytes
    // and left to the decoder to reject.
    const data =
      typeof message === "string" ? new TextEncoder().encode(message) : message
    this._guard(() => this._onMessage?.(ws.data.clientId, data))
  }

  private _closed(ws: Socket, code: number, closeReason: string): void {
    const { clientId } = ws.data
    // A rejected connection never reached onConnection: no onDisconnect.
    if (ws.data.rejection !== undefined) return
    if (this._clients.get(clientId) === ws) this._clients.delete(clientId)
    this._guard(() => this._onDisconnect?.(clientId, code, closeReason))
  }

  // --- helpers -------------------------------------------------------------

  private _shouldCompress(data: Uint8Array): boolean {
    return this._compression && data.byteLength >= this._compressionThreshold
  }

  private _sendTo(
    ws: Socket,
    data: Uint8Array,
    compress: boolean,
  ): Result<void, Error> {
    // -1: queued under backpressure (still delivered); 0: dropped.
    const status = ws.send(data, compress)
    if (status !== 0) return ok(undefined)
    return err(
      new TransportError(
        "CONNECTION_LOST",
        `frame to ${ws.data.clientId} was dropped`,
      ),
    )
  }

  private _notFound(clientId: string): TransportError {
    return new TransportError(
      "CLIENT_NOT_FOUND",
      `client ${clientId} not connected`,
    )
  }

  /** Runs a handler; a throw goes to `onError` (or the console). */
  private _guard(run: () => void): void {
    try {
      run()
    } catch (error) {
      const wrapped = error instanceof Error ? error : new Error(String(error))
      try {
        if (this._onError !== undefined) this._onError(wrapped)
        else console.error("[bungohan/transport] handler threw", wrapped)
      } catch (inner) {
        console.error("[bungohan/transport] onError threw", inner)
      }
    }
  }
}
