import type { Result } from "@bungohan/result"

/**
 * Cross-process pub/sub for cluster mode (spec §6.4, §8).
 *
 * It carries **bytes**, like `ITransport`, and doesn't decide what they
 * mean. The encoding belongs to whoever publishes: core uses the server's
 * `ISerializer` (MessagePack by default), so a value that arrived from a
 * client re-encodes to itself and a handler on another process receives
 * exactly what a handler on this one would. An `IBackplane` that imposed
 * JSON would quietly flatten `Uint8Array`, `NaN`, `±Infinity` and `Date`
 * on the way, and only for rooms that happen to live elsewhere.
 *
 * A process that subscribes to a channel also receives its own
 * publications on it, as in Redis.
 */
export interface IBackplane {
  publish(channel: string, data: Uint8Array): Promise<Result<void, Error>>
  /**
   * Adds a callback. Several callbacks may share a channel; it is
   * subscribed once. Resolves when the subscription is live.
   *
   * The bytes a callback receives are its own: the backplane never hands
   * the same array to two callbacks, or reuses one after delivery.
   */
  subscribe(
    channel: string,
    callback: (data: Uint8Array) => void,
  ): Promise<Result<void, Error>>
  /** Removes every callback on the channel. */
  unsubscribe(channel: string): Promise<Result<void, Error>>
  close(): Promise<Result<void, Error>>
}
