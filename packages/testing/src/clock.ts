import type { Clock, TimerId } from "@bungohan/types"
import { settle } from "./settle"

export type { Clock, TimerId }

interface Timer {
  readonly id: TimerId
  readonly callback: () => void
  /** Repeat period for intervals; undefined for one-shot timers. */
  readonly every: number | undefined
  due: number
  /** Tie-break: timers due at the same time fire in scheduling order. */
  seq: number
}

/** Delays are clamped like the platform's: negative or NaN become 0. */
function delay(ms: number): number {
  return Number.isFinite(ms) && ms > 0 ? ms : 0
}

/**
 * A clock that only moves when told to. `advance(ms)` fires every timer
 * that falls due, in due-time order (ties in scheduling order), setting
 * `now()` to each timer's due time as it fires, and lets promise
 * continuations settle after each one, so async work a timer starts is done
 * before the next timer fires. Deterministic: no wall-clock time involved.
 *
 * A timer callback that throws rejects the `advance()` promise with that
 * error (so a failed assertion fails the test instead of vanishing); time
 * stays at that timer's due time and later `advance` calls still run.
 */
export class ManualClock implements Clock {
  private readonly _timers = new Map<TimerId, Timer>()
  private _now: number
  private _nextId = 1
  private _seq = 0
  /** Serializes `advance` calls (e.g. one made from inside a timer). */
  private _queue: Promise<void> = Promise.resolve()

  public constructor(start = 0) {
    this._now = start
  }

  public now(): number {
    return this._now
  }

  public setTimeout(callback: () => void, ms: number): TimerId {
    return this._schedule(callback, delay(ms), undefined)
  }

  public clearTimeout(id: TimerId): void {
    this._timers.delete(id)
  }

  /** Intervals repeat every `ms` (at least 1ms, so `advance` terminates). */
  public setInterval(callback: () => void, ms: number): TimerId {
    const every = Math.max(1, delay(ms))
    return this._schedule(callback, every, every)
  }

  public clearInterval(id: TimerId): void {
    this._timers.delete(id)
  }

  /** Timers still scheduled. */
  public pendingTimers(): number {
    return this._timers.size
  }

  /**
   * Moves time forward by `ms`, firing everything that falls due. Calls
   * made while an advance is running (including from a timer) run after
   * it, in order.
   */
  public advance(ms: number): Promise<void> {
    const run = this._queue.then(() => this._advanceTo(this._now + delay(ms)))
    this._queue = run.catch(() => {})
    return run
  }

  /** Moves time forward to `time` (no-op if it's in the past). */
  public advanceTo(time: number): Promise<void> {
    return this.advance(time - this._now)
  }

  private _schedule(
    callback: () => void,
    after: number,
    every: number | undefined,
  ): TimerId {
    const id = this._nextId++
    this._timers.set(id, {
      id,
      callback,
      every,
      due: this._now + after,
      seq: this._seq++,
    })
    return id
  }

  private async _advanceTo(target: number): Promise<void> {
    for (;;) {
      const timer = this._nextDue(target)
      if (timer === undefined) break
      this._now = timer.due
      if (timer.every === undefined) this._timers.delete(timer.id)
      else {
        timer.due += timer.every
        timer.seq = this._seq++
      }
      timer.callback()
      await settle()
    }
    this._now = Math.max(this._now, target)
  }

  private _nextDue(target: number): Timer | undefined {
    let next: Timer | undefined
    for (const timer of this._timers.values()) {
      if (timer.due > target) continue
      if (
        next === undefined ||
        timer.due < next.due ||
        (timer.due === next.due && timer.seq < next.seq)
      ) {
        next = timer
      }
    }
    return next
  }
}
