import type { JoinErrorCode } from "@bungohan/types"

/** Error codes of core's API (spec §6.5, plus the §6.7.6 join codes). */
export type ErrorCode =
  | JoinErrorCode
  | "ROOM_NOT_FOUND_ON_LOCAL_BUT_FOUND_ON_REMOTE"
  | "UNAUTHORIZED"
  | "CONNECTION_FAILED"
  | "CONNECTION_LOST"
  | "RECONNECTION_FAILED"
  | "INVALID_MESSAGE"
  | "TIMEOUT"
  | "METRICS_DISABLED"
  | "CLIENT_NOT_FOUND"
  /** `onCreate` threw, or the room's state is invalid. */
  | "ROOM_CREATE_FAILED"
  /** A store operation behind `loadState`/`saveState` failed. */
  | "STORE_FAILED"
  /**
   * An operation that needs a cluster on a server without one, e.g. a
   * `ProcessSelector` picking another process while `cluster.enabled` is
   * off (spec §6.4).
   */
  | "CLUSTER_NOT_IMPLEMENTED"
  /** A lifecycle call made in the wrong state (e.g. `start()` twice). */
  | "INVALID_STATE"

/**
 * Core's error type. `timestamp` comes from the server's `Clock` (core never
 * reads wall-clock time itself), so it is passed in by whoever creates it.
 */
export class BungohanError<T = unknown> extends Error {
  public readonly code: ErrorCode
  public readonly timestamp: number
  public readonly context?: T

  public constructor(
    code: ErrorCode,
    message: string,
    timestamp: number,
    context?: T,
  ) {
    super(message)
    this.name = "BungohanError"
    this.code = code
    this.timestamp = timestamp
    this.context = context
  }
}
