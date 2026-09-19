import type { Result } from "@bungohan/result"

/**
 * Key-value persistence (spec §8), used for room state snapshots and
 * reservations. Values are JSON: anything `JSON.stringify` accepts except a
 * bare `undefined`.
 */
export interface IStore {
  /** `ttl` is in whole seconds (> 0); omit it for no expiry. */
  set(key: string, value: unknown, ttl?: number): Promise<Result<void, Error>>
  /** A missing (or expired) key is `ok(undefined)`. */
  get(key: string): Promise<Result<unknown, Error>>
  /** Deleting a missing key is not an error. */
  delete(key: string): Promise<Result<void, Error>>
  exists(key: string): Promise<Result<boolean, Error>>
  close(): Promise<Result<void, Error>>
}
