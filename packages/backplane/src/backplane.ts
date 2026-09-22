import type { Result } from "@bungohan/result"

/**
 * Cross-process pub/sub for cluster mode (see docs/guides/scaling.md):
 * the processes of a cluster announce themselves, look up rooms and relay
 * client frames over it. Pass one as
 * `ServerOptions.cluster.backplane.provider`; `RedisBackplane` and the
 * in-process `MemoryBackplane` ship with Bungohan.
 *
 * It carries **bytes**, like `ITransport`, and doesn't decide what they
 * mean. The encoding belongs to whoever publishes: core uses the server's
 * `ISerializer` (MessagePack by default), so a value that arrived from a
 * client re-encodes to itself and a handler on another process receives
 * exactly what a handler on this one would. An `IBackplane` that imposed
 * JSON would quietly flatten `Uint8Array`, `NaN`, `±Infinity` and `Date`
 * on the way, and only for rooms that happen to live elsewhere.
 *
 * What an implementation must do:
 *
 * - Deliver byte-exact: what a callback receives equals what was
 *   published, whatever the bytes (not only valid UTF-8).
 * - Deliver a channel's publications in the order they were published:
 *   core relays state patches this way, and a patch is a delta.
 * - Deliver a publication to every subscriber of its channel on every
 *   process, including the publishing process's own subscribers, as in
 *   Redis.
 * - Not keep the array passed to `publish`: the caller may reuse it once
 *   the call returns, so copy it if delivery is deferred.
 * - Report failures as an `err`, never by throwing or rejecting.
 */
export interface IBackplane {
  /**
   * Sends `data` to every subscriber of `channel`, cluster-wide.
   * Resolving means the backplane accepted it, not that anyone received
   * it (there may be no subscribers). Fails once closed.
   */
  publish(channel: string, data: Uint8Array): Promise<Result<void, Error>>
  /**
   * Adds a callback. Several callbacks may share a channel; it is
   * subscribed once. Resolves when the subscription is live, so a
   * publication made after that reaches it.
   *
   * The bytes a callback receives are its own: the backplane never hands
   * the same array to two callbacks, or reuses one after delivery.
   */
  subscribe(
    channel: string,
    callback: (data: Uint8Array) => void,
  ): Promise<Result<void, Error>>
  /**
   * Removes every callback on the channel. Unsubscribing from a channel
   * with none is not an error.
   */
  unsubscribe(channel: string): Promise<Result<void, Error>>
  /**
   * Ends every subscription and releases the connections. After it,
   * `publish` and `subscribe` fail. Closing twice is not an error.
   */
  close(): Promise<Result<void, Error>>
}
