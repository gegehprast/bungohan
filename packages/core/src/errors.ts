import type { JoinErrorCode } from "@bungohan/types"

/**
 * What went wrong, as `BungohanError.code`. Includes every code a client
 * can be refused a join with (`ROOM_FULL`, `AUTH_FAILED`, …), which is
 * what the server sends it.
 */
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
   * off.
   */
  | "CLUSTER_NOT_IMPLEMENTED"
  /** A lifecycle call made in the wrong state (e.g. `start()` twice). */
  | "INVALID_STATE"
  /**
   * `matchMaker.createRoom` with a `key` that a room of the type already
   * has, on any process.
   */
  | "ROOM_EXISTS"

/**
 * Core's error type: the `error` of every failed server-side `Result`,
 * and what `server.onError` receives for failures core detects itself.
 * Branch on `code`; `message` is for logs.
 */
export class BungohanError<T = unknown> extends Error {
  /** What went wrong; stable, unlike `message`. */
  public readonly code: ErrorCode
  /**
   * When it happened, on the server's `Clock` (core never reads wall-clock
   * time itself): epoch milliseconds by default, the manual clock's time
   * in tests.
   */
  public readonly timestamp: number
  /** The underlying error, when this one wraps another. */
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
