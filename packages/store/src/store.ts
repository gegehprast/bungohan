import type { Result } from "@bungohan/result"

/**
 * Key-value persistence: where a room's `saveState` and `loadState` go.
 * Pass one as `ServerOptions.store.provider`; `MemoryStore` (one process,
 * development, tests) and `RedisStore` ship with Bungohan.
 *
 * What an implementation must do:
 *
 * - Round-trip values as JSON: `get` returns what `JSON.parse` of
 *   `JSON.stringify(value)` would, never the object that was `set` (so a
 *   later mutation of it can't change the stored copy). A value
 *   `JSON.stringify` rejects, or a bare `undefined`, fails `set` instead
 *   of storing something else.
 * - Report every failure (a lost connection, a bad value, a closed store)
 *   as an `err`, never by throwing or rejecting.
 * - Accept any string as a key. Core's keys look like
 *   `room:<type>:<id>:state`.
 *
 * Core only reads and writes; it closes a store it built from
 * `ServerOptions.store.config` on shutdown, never one passed as
 * `provider`.
 */
export interface IStore {
  /**
   * Stores `value`, replacing any previous one. `ttl` is in whole seconds
   * (> 0); omit it for no expiry. A non-integer or non-positive `ttl` is
   * an `err`.
   */
  set(key: string, value: unknown, ttl?: number): Promise<Result<void, Error>>
  /** The stored value; a missing (or expired) key is `ok(undefined)`. */
  get(key: string): Promise<Result<unknown, Error>>
  /** Deleting a missing key is not an error. */
  delete(key: string): Promise<Result<void, Error>>
  /** Whether `key` holds an unexpired value. */
  exists(key: string): Promise<Result<boolean, Error>>
  /**
   * Releases the store's resources (connections, memory). After it, every
   * other operation fails. Closing twice is not an error.
   */
  close(): Promise<Result<void, Error>>
}
