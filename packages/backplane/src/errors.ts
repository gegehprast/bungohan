export type BackplaneErrorCode =
  /** Couldn't reach the backing service, or the backplane is closed. */
  | "CONNECTION_FAILED"
  /** Bad configuration (e.g. an invalid URL). */
  | "INVALID_OPTIONS"
  /** The backing service rejected or failed a command. */
  | "OPERATION_FAILED"

export class BackplaneError<T = unknown> extends Error {
  public readonly code: BackplaneErrorCode
  public readonly timestamp: number
  public readonly context?: T

  public constructor(code: BackplaneErrorCode, message: string, context?: T) {
    super(message)
    this.name = "BackplaneError"
    this.code = code
    this.timestamp = Date.now()
    this.context = context
  }
}

/** Message of an unknown thrown value. */
export function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
