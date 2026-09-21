/**
 * Per-connection rate limiting (spec §6.9). One {@link ConnectionLimiter}
 * per connection, asked before a frame is decoded, so a flood costs the
 * server a clock read rather than a parse.
 */
import type { ResolvedLimits } from "./types"

/**
 * A token bucket: `capacity` tokens, refilled at `rate` per second. A rate
 * of `0` means "no limit" and every take succeeds.
 */
class Bucket {
  private readonly _rate: number
  private readonly _capacity: number
  private _tokens: number
  private _last: number

  public constructor(rate: number, capacity: number, now: number) {
    this._rate = rate
    this._capacity = capacity
    this._tokens = capacity
    this._last = now
  }

  /** Spends `cost` tokens; false when the bucket is short. */
  public take(cost: number, now: number): boolean {
    if (this._rate <= 0) return true
    const elapsed = Math.max(0, now - this._last) / 1000
    this._tokens = Math.min(this._capacity, this._tokens + elapsed * this._rate)
    this._last = now
    if (this._tokens < cost) return false
    this._tokens -= cost
    return true
  }
}

/**
 * The inbound limits for one connection. Allowing a burst above the
 * sustained rate matters: clients legitimately send several frames in one
 * tick (an input plus a chat message plus a ping), and a strict per-second
 * cap would shed them for it.
 */
export class ConnectionLimiter {
  private readonly _frames: Bucket
  private readonly _bytes: Bucket
  private readonly _joins: Bucket

  public constructor(limits: ResolvedLimits, now: number) {
    this._frames = new Bucket(
      limits.messagesPerSecond,
      limits.messagesPerSecond + limits.messageBurst,
      now,
    )
    this._bytes = new Bucket(limits.bytesPerSecond, limits.bytesPerSecond, now)
    this._joins = new Bucket(
      limits.joinsPerMinute / 60,
      limits.joinsPerMinute,
      now,
    )
  }

  /**
   * Why this frame is over the limit, or `undefined` to accept it. Both
   * buckets are charged, so a connection can't dodge the byte limit by
   * staying under the frame limit.
   */
  public frameProblem(bytes: number, now: number): string | undefined {
    const frames = this._frames.take(1, now)
    const volume = this._bytes.take(bytes, now)
    if (!frames) return "too many frames"
    if (!volume) return "too many bytes"
    return undefined
  }

  /** Whether another `JOIN` is allowed right now. */
  public allowJoin(now: number): boolean {
    return this._joins.take(1, now)
  }
}
