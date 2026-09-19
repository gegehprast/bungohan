import type { Result } from "@bungohan/result"

/** What the transport knows about a connection when it opens. */
export interface ConnectionContext {
  /** Remote address (or `"unknown"`). */
  ip: string
  searchParams: URLSearchParams
  headers: Headers
  /** From `?token=` or an `Authorization: Bearer` header, if present. */
  token?: string
  /** Transport-specific extras. */
  [key: string]: unknown
}

/**
 * Moves opaque byte frames between the server and its clients (spec §8).
 * Framing, encoding and routing live above it, in core.
 *
 * The `on*` methods register the single handler for that event (a later
 * call replaces it); core is the only consumer. Every operation that can
 * fail returns a `Result`, and exceptions thrown by handlers are routed to
 * the `onError` handler instead of escaping into the socket loop.
 */
export interface ITransport {
  listen(port: number, options?: unknown): Promise<Result<void, Error>>
  close(): Promise<Result<void, Error>>
  send(clientId: string, data: Uint8Array): Result<void, Error>
  /**
   * Sends the same frame to every listed client. Encode once, broadcast the
   * one buffer (spec §8.1.1). Delivers to every reachable client even if
   * some fail; the error lists the failures.
   */
  broadcast(clientIds: string[], data: Uint8Array): Result<void, Error>
  disconnect(
    clientId: string,
    code?: number,
    reason?: string,
  ): Result<void, Error>
  onConnection?(
    cb: (clientId: string, context: ConnectionContext) => void,
  ): void
  onMessage?(cb: (clientId: string, data: Uint8Array) => void): void
  /** Fires for every close, including ones the server initiated. */
  onDisconnect?(
    cb: (clientId: string, code: number, reason: string) => void,
  ): void
  onError?(cb: (error: Error) => void): void
  getName(): string
}
