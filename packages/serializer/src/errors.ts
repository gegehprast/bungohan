export type SerializerErrorCode =
  /** A value couldn't be encoded (unsupported type, or a contract violation
   * that got past the types, e.g. an enum value not in the list). */
  | "ENCODE_FAILED"
  /** Bytes couldn't be decoded, or decoded to the wrong shape. */
  | "DECODE_FAILED"

export class SerializerError<T = unknown> extends Error {
  public readonly code: SerializerErrorCode
  public readonly timestamp: number
  public readonly context?: T

  public constructor(code: SerializerErrorCode, message: string, context?: T) {
    super(message)
    this.name = "SerializerError"
    this.code = code
    this.timestamp = Date.now()
    this.context = context
  }
}

/** Message of an unknown thrown value. */
export function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
