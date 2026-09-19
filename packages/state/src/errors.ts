export type StateErrorCode =
  /** `encodeSnapshot` called while changes are pending (spec §5.7.10). */
  | "SNAPSHOT_DIRTY"
  /** An op had the wrong shape or an out-of-range value. */
  | "MALFORMED_OP"
  /** An op targeted a refId the receiver never saw. */
  | "UNKNOWN_REF"
  /** A `[classId, refId]` named a classId with no preceding DEFINE. */
  | "UNKNOWN_CLASS"
  /** A local class disagrees with the server's on a shared field's type. */
  | "SCHEMA_MISMATCH"
  /** `fromPlain` data doesn't fit the schema (spec §6.8). */
  | "INVALID_DATA"

export class StateError<T = unknown> extends Error {
  public readonly code: StateErrorCode
  public readonly timestamp: number
  public readonly context?: T

  public constructor(code: StateErrorCode, message: string, context?: T) {
    super(message)
    this.name = "StateError"
    this.code = code
    this.timestamp = Date.now()
    this.context = context
  }
}
