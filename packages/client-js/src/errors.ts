import type { JoinErrorCode } from "@bungohan/types"

/**
 * What went wrong, as `ClientError.code`. Switch on it to tell the
 * player something useful (see docs/guides/client.md#joining).
 */
export type ClientErrorCode =
  /**
   * A join the server refused: `ROOM_FULL`, `ROOM_NOT_FOUND`,
   * `AUTH_FAILED`, `CONTRACT_MISMATCH`, `INVALID_TOKEN`, …
   */
  | JoinErrorCode
  /** The connection couldn't be opened, or closed before it was usable. */
  | "CONNECTION_FAILED"
  /** The connection closed while an operation was waiting on it. */
  | "CONNECTION_LOST"
  /** Every reconnection attempt failed (`ReconnectionOptions.maxAttempts`). */
  | "RECONNECTION_FAILED"
  /** No open connection (not connected yet, or reconnecting). */
  | "NOT_CONNECTED"
  /** The server refused this client's protocol version (close 1002). */
  | "PROTOCOL_ERROR"
  /** The room's state codec is one this client has no decoder for. */
  | "CODEC_MISMATCH"
  /** A frame from the server couldn't be parsed. */
  | "INVALID_MESSAGE"
  /** A message name that isn't in the room's contract or tables. */
  | "UNKNOWN_MESSAGE"
  /** A payload couldn't be encoded (it got past the types). */
  | "ENCODE_FAILED"
  /** The room has been left. */
  | "NOT_JOINED"
  /** The server sent `LEAVE` before the join completed. */
  | "LEFT"
  /** The server didn't answer a join within `joinTimeout`. */
  | "TIMEOUT"
  /**
   * The state replica no longer matches the server's (a patch couldn't be
   * applied). The client re-syncs by reconnecting.
   */
  | "DESYNC"
  /** An `ERROR` frame from the server; its code is in the message. */
  | "SERVER_ERROR"
  /**
   * The server sent an instance of a Schema class this client has none
   * registered for; it was left out of the replica. Reported through
   * `room.onError`, not as a failed operation.
   */
  | "UNKNOWN_CLASS"

/**
 * Every error client-js reports: the `error` of a failed `Result`, and
 * what `client.onError` receives. Branch on `code`; `message` is for
 * logs.
 */
export class ClientError<T = unknown> extends Error {
  /** What went wrong; stable, unlike `message`. */
  public readonly code: ClientErrorCode
  /** When it happened, in epoch milliseconds (`Date.now()`). */
  public readonly timestamp: number
  /**
   * Extra detail, when there is any: the underlying error, or, for a join
   * the server refused, `{ code }` with the server's own code (which is
   * how you see a code this client doesn't know yet, reported as
   * `JOIN_FAILED`).
   */
  public readonly context?: T

  public constructor(code: ClientErrorCode, message: string, context?: T) {
    super(message)
    this.name = "ClientError"
    this.code = code
    this.timestamp = Date.now()
    this.context = context
  }
}

const JOIN_ERROR_CODES: ReadonlySet<string> = new Set<JoinErrorCode>([
  "INVALID_OPTIONS",
  "SERVER_SHUTTING_DOWN",
  "ROOM_TYPE_NOT_DEFINED",
  "CONTRACT_MISMATCH",
  "ROOM_NOT_FOUND",
  "ROOM_LOCKED",
  "ROOM_FULL",
  "ALREADY_JOINED",
  "AUTH_FAILED",
  "JOIN_FAILED",
  "INVALID_TOKEN",
  "RESERVATION_NOT_FOUND",
  "RESERVATION_EXPIRED",
])

/**
 * A `JOIN_ERROR` code as a `ClientErrorCode`. A code this client doesn't
 * know (a newer server) becomes `JOIN_FAILED`; the original stays in the
 * error's `context`.
 */
export function joinErrorCode(code: string): ClientErrorCode {
  return JOIN_ERROR_CODES.has(code) ? (code as JoinErrorCode) : "JOIN_FAILED"
}
