import { describe, expect, test } from "bun:test"
import type { Clock, TimerId } from "./clock"
import { IntervalLoop, SimulationLoop } from "./loop"

/**
 * A clock whose `now()` the test sets directly, and whose interval fires
 * only when `fire()` is called: enough to model a late or slow wake.
 */
class StepClock implements Clock {
  public time = 0
  private readonly _intervals = new Map<TimerId, () => void>()
  private _next = 1

  public now(): number {
    return this.time
  }

  public setTimeout(): TimerId {
    return this._next++
  }

  public clearTimeout(): void {}

  public setInterval(callback: () => void): TimerId {
    const id = this._next++
    this._intervals.set(id, callback)
    return id
  }

  public clearInterval(id: TimerId): void {
    this._intervals.delete(id)
  }

  /** Moves time to `at` and wakes every interval once. */
  public fire(at: number): void {
    this.time = at
    for (const callback of [...this._intervals.values()]) callback()
  }

  public get intervals(): number {
    return this._intervals.size
  }
}

describe("SimulationLoop", () => {
  test("runs whole fixed steps from the accumulated real time", () => {
    const clock = new StepClock()
    const steps: number[] = []
    const loop = new SimulationLoop(clock, 50, (dt) => steps.push(dt))
    loop.start()
    clock.fire(20) // one step, 0 ms carried
    clock.fire(35) // 15 ms: not a whole step yet
    clock.fire(62) // 42 ms accumulated: two steps, 2 ms carried
    expect(steps).toEqual([20, 20, 20])
    expect(loop.steps).toBe(3)
    expect(loop.droppedMs).toBe(0)
  })

  test("a late wake catches up, but never more than the cap", () => {
    const clock = new StepClock()
    let steps = 0
    const loop = new SimulationLoop(clock, 100, () => steps++, 3)
    loop.start()
    clock.fire(25) // 2.5 steps behind: 2 steps
    expect(steps).toBe(2)
    clock.fire(1_000) // 98 steps behind: 3 steps, the other 95 dropped
    expect(steps).toBe(5)
    expect(loop.droppedMs).toBe(950)
    clock.fire(1_010) // back on schedule: exactly one step
    expect(steps).toBe(6)
  })

  test("one slow step doesn't snowball into more slow steps", () => {
    const clock = new StepClock()
    let steps = 0
    // Each 20 ms step costs 100 ms of real time (a pathological onTick).
    // Uncapped, every wake would owe five times the steps of the last one
    // (1, 6, 36, …); capped, it settles at the cap and time is dropped.
    const loop = new SimulationLoop(
      clock,
      50,
      () => {
        steps++
        clock.time += 100
      },
      4,
    )
    loop.start()
    const perWake: number[] = []
    for (let wake = 0; wake < 6; wake++) {
      const before = steps
      clock.fire(clock.time + 20)
      perWake.push(steps - before)
    }
    expect(perWake).toEqual([1, 4, 4, 4, 4, 4])
    expect(loop.droppedMs).toBeGreaterThan(0)
  })

  test("float error on the step doesn't skip or double a step", () => {
    const clock = new StepClock()
    let steps = 0
    const loop = new SimulationLoop(clock, 60, () => steps++)
    loop.start()
    let due = 0
    for (let i = 0; i < 600; i++) {
      due += 1000 / 60
      clock.fire(due)
    }
    expect(steps).toBe(600)
  })

  test("stop, restart and rate changes", () => {
    const clock = new StepClock()
    const steps: number[] = []
    const loop = new SimulationLoop(clock, 10, (dt) => steps.push(dt))
    loop.start()
    loop.start() // idempotent
    expect(clock.intervals).toBe(1)
    loop.stop()
    expect(clock.intervals).toBe(0)
    clock.fire(500) // stopped: nothing
    loop.start() // restarting doesn't replay the pause
    clock.fire(600)
    expect(steps).toEqual([100])
    loop.setTickRate(20)
    expect(loop.running).toBe(true)
    clock.fire(650)
    expect(steps).toEqual([100, 50])
  })

  test("a step may stop its own loop", () => {
    const clock = new StepClock()
    let steps = 0
    const loop = new SimulationLoop(clock, 100, () => {
      steps++
      loop.stop()
    })
    loop.start()
    clock.fire(50)
    expect(steps).toBe(1)
  })
})

describe("IntervalLoop", () => {
  test("runs on every wake; setRate restarts at the new period", () => {
    const clock = new StepClock()
    let runs = 0
    const loop = new IntervalLoop(clock, 20, () => runs++)
    expect(loop.periodMs).toBe(50)
    loop.start()
    clock.fire(50)
    clock.fire(100)
    expect(runs).toBe(2)
    loop.setRate(10)
    expect(loop.periodMs).toBe(100)
    expect(loop.running).toBe(true)
    loop.stop()
    clock.fire(200)
    expect(runs).toBe(2)
  })
})
