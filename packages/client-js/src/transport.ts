/**
 * The client side of the transport seam. The client needs only this much
 * from a connection: open it offering protocol versions, send and receive
 * whole binary messages (one message = one frame, spec §6.7.1), and learn
 * when it closes. The default is the browser's `WebSocket`;
 * `@bungohan/testing` ships a loopback implementation.
 */
import { err, ok, type Result } from "@bungohan/result"
import { ClientError } from "./errors"

/** Callbacks a transport reports a connection's life through. */
export interface ClientSocketHandlers {
  /** The connection is open; `protocol` is the version the server chose. */
  onOpen(protocol: string): void
  /** One whole binary message (frame). */
  onMessage(data: Uint8Array): void
  /**
   * The connection closed (or never opened). Fires exactly once, and never
   * before `open()` has returned. No other handler fires after it.
   */
  onClose(code: number, reason: string): void
}

/** An open (or opening) connection. */
export interface ClientSocket {
  /** Sends one frame; false if the connection isn't open. */
  send(data: Uint8Array<ArrayBuffer>): boolean
  /** Closes the connection. `onClose` still fires. */
  close(code?: number, reason?: string): void
}

export interface IClientTransport {
  /**
   * Starts opening a connection to `url`, offering `protocols` (WebSocket
   * subprotocols, in preference order). Fails only if the connection
   * can't even be attempted (e.g. a malformed URL); a server that can't be
   * reached is reported later, through `onClose`.
   */
  open(
    url: string,
    protocols: readonly string[],
    handlers: ClientSocketHandlers,
  ): Result<ClientSocket, ClientError>
  getName(): string
}

/** Close code for a connection that dropped without a close frame. */
export const ABNORMAL_CLOSURE = 1006

/**
 * The default transport: the platform `WebSocket` (browsers, Bun, Deno,
 * Node ≥ 22), with binary frames as `ArrayBuffer`s.
 */
export class WebSocketClientTransport implements IClientTransport {
  private readonly _WebSocket: typeof WebSocket | undefined

  /** `WebSocketImpl` defaults to the global `WebSocket`. */
  public constructor(WebSocketImpl?: typeof WebSocket) {
    this._WebSocket =
      WebSocketImpl ??
      (typeof WebSocket === "undefined" ? undefined : WebSocket)
  }

  public open(
    url: string,
    protocols: readonly string[],
    handlers: ClientSocketHandlers,
  ): Result<ClientSocket, ClientError> {
    const WebSocketImpl = this._WebSocket
    if (WebSocketImpl === undefined) {
      return err(
        new ClientError("CONNECTION_FAILED", "no WebSocket in this runtime"),
      )
    }
    let ws: WebSocket
    try {
      ws = new WebSocketImpl(url, [...protocols])
    } catch (error) {
      // A malformed URL or protocol list throws synchronously.
      const message = error instanceof Error ? error.message : String(error)
      return err(new ClientError("CONNECTION_FAILED", message, error))
    }
    ws.binaryType = "arraybuffer"
    let closed = false
    ws.onopen = () => handlers.onOpen(ws.protocol)
    ws.onmessage = (event: MessageEvent) => {
      if (closed) return
      const data: unknown = event.data
      if (data instanceof ArrayBuffer) handlers.onMessage(new Uint8Array(data))
      else if (typeof data === "string") {
        // The protocol is binary. Pass text on as bytes: the frame parser
        // drops it as an unknown frame.
        handlers.onMessage(new TextEncoder().encode(data))
      }
    }
    // An error is always followed by a close event, which reports it.
    ws.onerror = () => {}
    ws.onclose = (event: CloseEvent) => {
      if (closed) return
      closed = true
      handlers.onClose(event.code, event.reason)
    }
    return ok({
      send(data: Uint8Array<ArrayBuffer>): boolean {
        if (ws.readyState !== WebSocketImpl.OPEN) return false
        ws.send(data)
        return true
      },
      close(code?: number, reason?: string): void {
        try {
          ws.close(code, reason)
        } catch {
          // An invalid code: close without one rather than stay open.
          ws.close()
        }
      },
    })
  }

  public getName(): string {
    return "websocket"
  }
}
