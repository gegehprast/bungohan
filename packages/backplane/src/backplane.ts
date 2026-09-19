import type { Result } from "@bungohan/result"

/**
 * Cross-process pub/sub for cluster mode (spec §6.4, §8). Messages are
 * JSON. A process that subscribes to a channel also receives its own
 * publications on it.
 */
export interface IBackplane {
  publish<M>(channel: string, message: M): Promise<Result<void, Error>>
  /**
   * Adds a callback. Several callbacks may share a channel; it is
   * subscribed once. Resolves when the subscription is live.
   */
  subscribe<M>(
    channel: string,
    callback: (message: M) => void,
  ): Promise<Result<void, Error>>
  /** Removes every callback on the channel. */
  unsubscribe(channel: string): Promise<Result<void, Error>>
  close(): Promise<Result<void, Error>>
}
