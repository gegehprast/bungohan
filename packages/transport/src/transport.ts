import type { Result } from "@bungohan/result"

/**
 * What the transport knows about a connection when it opens. Core passes
 * it to `onAuth` as the room's `context` argument, so anything a transport
 * puts here reaches game code.
 */
export interface ConnectionContext {
  /** Remote address (or `"unknown"`). */
  ip: string
  /** The query string of the URL the client connected to. */
  searchParams: URLSearchParams
  /** The request headers of the connection's opening handshake. */
  headers: Headers
  /** From `?token=` or an `Authorization: Bearer` header, if present. */
  token?: string
  /**
   * The negotiated protocol version (WebSocket subprotocol). Every
   * transport must set it (see `ITransport.acceptProtocols`); core closes
   * a connection without an accepted one with 1002.
   */
  protocol?: string
  /** Transport-specific extras. */
  [key: string]: unknown
}

/**
 * Moves opaque byte frames between the server and its clients. Framing,
 * encoding and routing live above it, in core; a transport never looks
 * inside a frame. Pass one as `ServerOptions.transport.provider` to serve
 * something other than Bun's WebSocket server (`@bungohan/testing`'s
 * loopback transport is a complete in-memory example).
 *
 * What an implementation must do:
 *
 * - Give each connection an id that is unique for the transport's
 *   lifetime, and use it in every call and callback for that connection.
 * - Call `onConnection` exactly once per accepted connection, before any
 *   `onMessage` for it, and `onDisconnect` exactly once when it closes,
 *   whichever side closed it. A connection rejected by `acceptProtocols`
 *   gets neither.
 * - Deliver each inbound binary frame whole, in order, to `onMessage`.
 *   Core may keep `data` (or views into it) after the callback returns, so
 *   never reuse or overwrite a buffer you have handed over.
 * - Never modify a buffer passed to `send`/`broadcast`; it may be the same
 *   buffer for many clients. Keep it until written if you queue.
 * - Not throw. Every operation that can fail returns a `Result`, and an
 *   exception thrown by one of core's handlers goes to the `onError`
 *   handler instead of escaping into the socket loop.
 *
 * The `on*` methods register the single handler for that event (a later
 * call replaces it); core registers them all before `listen`.
 */
export interface ITransport {
  /**
   * Starts accepting connections on `port` (`0` picks a free one; report
   * it through `getPort`). `options` are transport-specific: core calls
   * `listen(port)` with none. Fails if already listening or the port
   * can't be bound.
   */
  listen(port: number, options?: unknown): Promise<Result<void, Error>>
  /**
   * Stops listening and closes every open connection, each of which still
   * gets its `onDisconnect`. Core calls it once, on shutdown. Fails when
   * not listening.
   */
  close(): Promise<Result<void, Error>>
  /**
   * Queues one frame to one client. Fails for an unknown or closed
   * client, or when the frame was dropped rather than queued. Core only
   * logs the failure: a lost connection is handled when `onDisconnect`
   * fires.
   */
  send(clientId: string, data: Uint8Array): Result<void, Error>
  /**
   * Sends the same frame to every listed client: core encodes a state
   * patch or broadcast once and hands the one buffer here. Delivers to
   * every reachable client even if some fail; the error lists the
   * failures.
   */
  broadcast(clientIds: string[], data: Uint8Array): Result<void, Error>
  /**
   * Closes one connection with a close code (default 1000) and reason.
   * From this call on the client no longer counts as connected (`send` to
   * it fails), and `onDisconnect` still fires once the close completes.
   * Fails for an unknown client.
   */
  disconnect(
    clientId: string,
    code?: number,
    reason?: string,
  ): Result<void, Error>
  /**
   * Registers the handler for a newly accepted connection, called with its
   * id and what the transport knows about it.
   */
  onConnection?(
    cb: (clientId: string, context: ConnectionContext) => void,
  ): void
  /** Registers the handler for one inbound frame. */
  onMessage?(cb: (clientId: string, data: Uint8Array) => void): void
  /**
   * Registers the handler for a closed connection. It must fire for every
   * close, including ones the server initiated with `disconnect` or
   * `close`: core releases the connection's seats only then.
   */
  onDisconnect?(
    cb: (clientId: string, code: number, reason: string) => void,
  ): void
  /**
   * Registers the handler for errors that have no caller to return to: a
   * failure inside the socket loop, or an exception thrown by one of the
   * other handlers. Core reports them through `server.onError`.
   */
  onError?(cb: (error: Error) => void): void
  /**
   * Requires every connection to offer one of `protocols` (the WebSocket
   * subprotocol), checked when the connection opens, before any frame. A
   * connection that doesn't is opened only to be closed at once with 1002
   * and a reason naming the expected versions; it never reaches
   * `onConnection`. Core calls this before `listen`.
   *
   * Required, not optional: the transport **must** set
   * `ConnectionContext.protocol` to the negotiated version on every
   * connection it accepts, because core rejects (closes with 1002) any
   * connection without one. `negotiateProtocol` does the choosing.
   */
  acceptProtocols(protocols: readonly string[]): void
  /**
   * Bytes accepted for this client but not yet written to its socket, so
   * core can tell a client that has stopped reading from one that is
   * keeping up, and pause its state patches (see
   * `LimitOptions.backpressure`). `0` for an unknown or disconnected
   * client, and for a transport that delivers synchronously and never
   * queues.
   *
   * Required, not optional: a transport that always answered `0` while
   * queueing without limit would let one slow client grow the server's
   * memory until it died, which is what this guards against. Core reads it
   * after every send, so keep it cheap.
   */
  bufferedAmount(clientId: string): number
  /**
   * The port this transport is listening on (useful after `listen(0)`), or
   * `undefined` when it isn't listening or has no ports at all (an
   * in-memory transport). Optional: `server.getPort()` reads it.
   */
  getPort?(): number | undefined
  /** A short name for logs and diagnostics, such as `"websocket"`. */
  getName(): string
}
