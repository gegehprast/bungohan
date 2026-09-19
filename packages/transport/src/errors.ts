export type TransportErrorCode =
  /** A send or close on a connection failed (dropped, or already gone). */
  | "CONNECTION_LOST"
  /** No connected client has this id. */
  | "CLIENT_NOT_FOUND"
  /** Bad arguments, or an operation invalid in the current state. */
  | "INVALID_OPTIONS"
  /** The server couldn't start or stop (e.g. the port is in use). */
  | "CONNECTION_FAILED"

export class TransportError<T = unknown> extends Error {
  public readonly code: TransportErrorCode
  public readonly timestamp: number
  public readonly context?: T

  public constructor(code: TransportErrorCode, message: string, context?: T) {
    super(message)
    this.name = "TransportError"
    this.code = code
    this.timestamp = Date.now()
    this.context = context
  }
}

/** Message of an unknown thrown value. */
export function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
