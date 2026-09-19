export type StoreErrorCode =
  /** Couldn't reach the backing service, or the store is closed. */
  | "CONNECTION_FAILED"
  /** Bad configuration or arguments (e.g. an invalid URL or TTL). */
  | "INVALID_OPTIONS"
  /** The backing service rejected or failed a command. */
  | "OPERATION_FAILED"
  /** A value couldn't be stored as JSON, or a stored value isn't JSON. */
  | "SERIALIZATION_FAILED"

export class StoreError<T = unknown> extends Error {
  public readonly code: StoreErrorCode
  public readonly timestamp: number
  public readonly context?: T

  public constructor(code: StoreErrorCode, message: string, context?: T) {
    super(message)
    this.name = "StoreError"
    this.code = code
    this.timestamp = Date.now()
    this.context = context
  }
}

/** Message of an unknown thrown value. */
export function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
