/**
 * client-js's transport seam over a `LoopbackTransport`: a real
 * `BungohanClient` talks to a real server in one process, with only bytes
 * crossing, delivered when the test flushes.
 */
import {
  ABNORMAL_CLOSURE,
  ClientError,
  type ClientSocket,
  type ClientSocketHandlers,
  type IClientTransport,
} from "@bungohan/client-js"
import { err, ok, type Result } from "@bungohan/result"
import type {
  LoopbackConnectOptions,
  LoopbackSocket,
  LoopbackTransport,
} from "./loopback"

export interface LoopbackClientTransportOptions
  extends Omit<LoopbackConnectOptions, "protocols" | "token"> {
  /**
   * While it returns true, connections fail the way an unreachable server
   * does: they never open, and close with 1006. For reconnection tests.
   */
  offline?: () => boolean
  /** Called with every frame the client sends, before it is queued. */
  onSend?: (data: Uint8Array) => void
  /** Called with every frame delivered to the client. */
  onReceive?: (data: Uint8Array) => void
  /** Called when a connection this transport opened closes. */
  onClose?: () => void
}

export class LoopbackClientTransport implements IClientTransport {
  private readonly _server: LoopbackTransport
  private readonly _options: LoopbackClientTransportOptions
  private _socket: LoopbackSocket | undefined

  public constructor(
    server: LoopbackTransport,
    options: LoopbackClientTransportOptions = {},
  ) {
    this._server = server
    this._options = options
  }

  /** The socket of the most recent connection (to act on it server-side). */
  public get socket(): LoopbackSocket | undefined {
    return this._socket
  }

  /**
   * The URL's `?token=` becomes `context.token`, as `WebSocketTransport`
   * does; the rest of its query becomes `context.searchParams`.
   */
  public open(
    url: string,
    protocols: readonly string[],
    handlers: ClientSocketHandlers,
  ): Result<ClientSocket, ClientError> {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return err(new ClientError("CONNECTION_FAILED", `bad URL ${url}`))
    }
    const searchParams = Object.fromEntries(parsed.searchParams)
    const token = parsed.searchParams.get("token") ?? undefined
    const { offline, onSend, onReceive, onClose, ...connect } = this._options
    const connected =
      offline?.() === true
        ? undefined
        : this._server.connect({
            ...connect,
            searchParams: { ...connect.searchParams, ...searchParams },
            protocols: [...protocols],
            ...(token === undefined ? {} : { token }),
          })
    if (connected === undefined || connected.isErr()) {
      // Unreachable: like a WebSocket, report it asynchronously, as a close.
      let closed = false
      queueMicrotask(() => {
        if (closed) return
        closed = true
        handlers.onClose(ABNORMAL_CLOSURE, "server unreachable")
      })
      return ok({
        send: () => false,
        close: () => {
          if (closed) return
          closed = true
          queueMicrotask(() => handlers.onClose(ABNORMAL_CLOSURE, ""))
        },
      })
    }
    const socket = connected.value
    this._socket = socket
    let open = false
    // The upgrade completed (a rejected version is closed right after,
    // spec §6.7.7), so the client sees open, then any close.
    queueMicrotask(() => {
      if (socket.readyState === "closed") return
      open = true
      handlers.onOpen(socket.protocol)
    })
    socket.onMessage((data) => {
      if (!open) return
      onReceive?.(data)
      handlers.onMessage(data)
    })
    socket.onClose((code, reason) => {
      onClose?.()
      handlers.onClose(code, reason)
    })
    return ok({
      send: (data) => {
        if (!open) return false
        onSend?.(data)
        return socket.send(data)
      },
      close: (code, reason) => socket.close(code, reason),
    })
  }

  public getName(): string {
    return "loopback"
  }
}
