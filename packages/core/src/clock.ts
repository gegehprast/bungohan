export type TimerId = number

/**
 * Time source and timers. Every loop, timeout and timestamp in core goes
 * through an injected `Clock` (`ServerOptions.clock`), so tests drive time
 * with `ManualClock` from `@bungohan/testing`. Nothing else in core reads
 * wall-clock time.
 */
export interface Clock {
  /** Milliseconds; only differences are meaningful. */
  now(): number
  setTimeout(callback: () => void, ms: number): TimerId
  clearTimeout(id: TimerId): void
  setInterval(callback: () => void, ms: number): TimerId
  clearInterval(id: TimerId): void
}

/**
 * The real clock: epoch milliseconds with sub-millisecond precision
 * (`performance.timeOrigin + performance.now()`, so tick durations in
 * metrics mean something) and the platform timers. Timer handles are
 * mapped to numbers, since Bun's are objects.
 */
export class SystemClock implements Clock {
  private readonly _timers = new Map<TimerId, ReturnType<typeof setTimeout>>()
  private _nextId = 1

  public now(): number {
    return performance.timeOrigin + performance.now()
  }

  public setTimeout(callback: () => void, ms: number): TimerId {
    const id = this._nextId++
    this._timers.set(
      id,
      setTimeout(() => {
        this._timers.delete(id)
        callback()
      }, ms),
    )
    return id
  }

  public clearTimeout(id: TimerId): void {
    const handle = this._timers.get(id)
    if (handle !== undefined) clearTimeout(handle)
    this._timers.delete(id)
  }

  public setInterval(callback: () => void, ms: number): TimerId {
    const id = this._nextId++
    this._timers.set(id, setInterval(callback, ms))
    return id
  }

  public clearInterval(id: TimerId): void {
    const handle = this._timers.get(id)
    if (handle !== undefined) clearInterval(handle)
    this._timers.delete(id)
  }
}
