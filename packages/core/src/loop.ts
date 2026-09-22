import type { Clock, TimerId } from "@bungohan/types"

/** Timers fire late by float error; this much short of a step still counts. */
const EPSILON = 1e-6

/**
 * Fixed-timestep simulation loop with an accumulator: what drives each
 * room's `onTick`. Exported for games that want the same stepping outside
 * a room.
 *
 * A timer wakes the loop roughly every step. Each wake adds the real
 * elapsed time (from the injected clock) to an accumulator and runs as
 * many whole steps as fit, each with the same `deltaTime`, so simulation
 * results don't depend on timer jitter.
 *
 * A wake runs at most `maxCatchUpSteps` steps. If the loop has fallen
 * further behind (a slow tick, a GC pause, a suspended laptop), the rest of
 * the backlog is dropped rather than simulated: catching up with more slow
 * steps would only make the next wake later still. Dropped time is counted
 * in `droppedMs`.
 */
export class SimulationLoop {
  private readonly _clock: Clock
  private readonly _step: (deltaTime: number) => void
  private readonly _maxCatchUpSteps: number
  private _stepMs: number
  private _timer: TimerId | undefined
  private _last = 0
  private _accumulator = 0
  private _droppedMs = 0
  private _steps = 0

  public constructor(
    clock: Clock,
    tickRate: number,
    step: (deltaTime: number) => void,
    maxCatchUpSteps = 5,
  ) {
    this._clock = clock
    this._step = step
    this._stepMs = 1000 / tickRate
    this._maxCatchUpSteps = Math.max(1, maxCatchUpSteps)
  }

  /** True between `start()` and `stop()`. */
  public get running(): boolean {
    return this._timer !== undefined
  }

  /** Milliseconds per step. */
  public get stepMs(): number {
    return this._stepMs
  }

  /** Simulated time discarded because the loop fell too far behind. */
  public get droppedMs(): number {
    return this._droppedMs
  }

  /** Steps run since construction. */
  public get steps(): number {
    return this._steps
  }

  /**
   * Starts stepping, measuring from now (time before this call is never
   * simulated). Starting a running loop does nothing.
   */
  public start(): void {
    if (this._timer !== undefined) return
    this._last = this._clock.now()
    this._accumulator = 0
    this._timer = this._clock.setInterval(() => this._wake(), this._stepMs)
  }

  /** Stops stepping; a step in progress finishes. Safe to call twice. */
  public stop(): void {
    if (this._timer === undefined) return
    this._clock.clearInterval(this._timer)
    this._timer = undefined
  }

  /** Changes the rate; a running loop restarts at the new rate. */
  public setTickRate(tickRate: number): void {
    const running = this.running
    this.stop()
    this._stepMs = 1000 / tickRate
    if (running) this.start()
  }

  private _wake(): void {
    const now = this._clock.now()
    this._accumulator += now - this._last
    this._last = now
    let steps = 0
    while (
      this._accumulator + EPSILON >= this._stepMs &&
      steps < this._maxCatchUpSteps
    ) {
      this._accumulator -= this._stepMs
      steps++
      this._steps++
      this._step(this._stepMs)
      // A step may stop the loop (e.g. the room was disposed).
      if (this._timer === undefined) return
    }
    if (this._accumulator + EPSILON >= this._stepMs) {
      const backlog = this._accumulator - (this._accumulator % this._stepMs)
      this._droppedMs += backlog
      this._accumulator -= backlog
    }
  }
}

/**
 * Runs a callback at a fixed rate: what drives each room's state sync.
 * No accumulator and no catch-up, since a sync is not time-integrated: a
 * late one simply sends everything that changed.
 */
export class IntervalLoop {
  private readonly _clock: Clock
  private readonly _run: () => void
  private _periodMs: number
  private _timer: TimerId | undefined

  public constructor(clock: Clock, rate: number, run: () => void) {
    this._clock = clock
    this._run = run
    this._periodMs = 1000 / rate
  }

  /** True between `start()` and `stop()`. */
  public get running(): boolean {
    return this._timer !== undefined
  }

  /** Milliseconds between runs (`1000 / rate`). */
  public get periodMs(): number {
    return this._periodMs
  }

  /** Starts running; the first run is one period from now. */
  public start(): void {
    if (this._timer !== undefined) return
    this._timer = this._clock.setInterval(this._run, this._periodMs)
  }

  /** Stops running. Safe to call twice. */
  public stop(): void {
    if (this._timer === undefined) return
    this._clock.clearInterval(this._timer)
    this._timer = undefined
  }

  /** Changes the rate (runs per second); a running loop restarts at it. */
  public setRate(rate: number): void {
    const running = this.running
    this.stop()
    this._periodMs = 1000 / rate
    if (running) this.start()
  }
}
