import type { JoinErrorCode } from "@bungohan/types"

export type ClientErrorCode =
  /** A `JOIN_ERROR` code from the server (spec §6.7.6). */
  | JoinErrorCode
  /** The connection couldn't be opened, or closed before it was usable. */
  | "CONNECTION_FAILED"
  /** The connection closed while an operation was waiting on it. */
  | "CONNECTION_LOST"
  /** Every reconnection attempt failed (`ReconnectionOptions.maxAttempts`). */
  | "RECONNECTION_FAILED"
  /** No open connection (not connected yet, or reconnecting). */
  | "NOT_CONNECTED"
  /** The server refused the protocol version (close 1002, spec §6.7.7). */
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
  /** The state replica no longer matches the server's (spec §5.7.9). */
  | "DESYNC"
  /** An `ERROR` frame from the server; its code is in the message. */
  | "SERVER_ERROR"
  /**
   * The server sent an instance of a Schema class this client has none
   * registered for; it was left out of the replica. Reported through
   * `room.onError`, not as a failed operation.
   */
  | "UNKNOWN_CLASS"

/** Every error client-js reports, in the §6.5 shape. */
export class ClientError<T = unknown> extends Error {
  public readonly code: ClientErrorCode
  public readonly timestamp: number
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
