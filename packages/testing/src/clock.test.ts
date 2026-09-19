import { describe, expect, test } from "bun:test"
import { ManualClock } from "./clock"

describe("ManualClock", () => {
  test("time only moves when advanced", async () => {
    const clock = new ManualClock(1000)
    expect(clock.now()).toBe(1000)
    await clock.advance(16)
    expect(clock.now()).toBe(1016)
    await clock.advanceTo(1000) // in the past: no-op
    expect(clock.now()).toBe(1016)
  })

  test("timers fire in due order, ties in scheduling order, at their due time", async () => {
    const clock = new ManualClock()
    const fired: string[] = []
    clock.setTimeout(() => fired.push(`b@${clock.now()}`), 20)
    clock.setTimeout(() => fired.push(`a@${clock.now()}`), 10)
    clock.setTimeout(() => fired.push(`c@${clock.now()}`), 20)
    clock.setTimeout(() => fired.push(`late@${clock.now()}`), 31)
    await clock.advance(30)
    expect(fired).toEqual(["a@10", "b@20", "c@20"])
    expect(clock.now()).toBe(30)
    expect(clock.pendingTimers()).toBe(1)
  })

  test("intervals repeat; clearing one from inside stops it", async () => {
    const clock = new ManualClock()
    const ticks: number[] = []
    const id = clock.setInterval(() => {
      ticks.push(clock.now())
      if (ticks.length === 3) clock.clearInterval(id)
    }, 16)
    await clock.advance(100)
    expect(ticks).toEqual([16, 32, 48])
    expect(clock.pendingTimers()).toBe(0)
  })

  test("a 0ms timer set by a timer fires within the same advance", async () => {
    const clock = new ManualClock()
    const fired: string[] = []
    clock.setTimeout(() => {
      fired.push("outer")
      clock.setTimeout(() => fired.push(`inner@${clock.now()}`), 0)
    }, 5)
    await clock.advance(5)
    expect(fired).toEqual(["outer", "inner@5"])
  })

  test("async work a timer starts settles before the next timer", async () => {
    const clock = new ManualClock()
    const log: string[] = []
    clock.setTimeout(() => {
      void (async () => {
        await Promise.resolve()
        await Promise.resolve()
        log.push("async done")
      })()
    }, 1)
    clock.setTimeout(() => log.push("second timer"), 2)
    await clock.advance(2)
    expect(log).toEqual(["async done", "second timer"])
  })

  test("clearTimeout, and negative/NaN delays clamp to 0", async () => {
    const clock = new ManualClock()
    const fired: string[] = []
    const id = clock.setTimeout(() => fired.push("cleared"), 1)
    clock.clearTimeout(id)
    clock.setTimeout(() => fired.push("neg"), -5)
    clock.setTimeout(() => fired.push("nan"), Number.NaN)
    await clock.advance(0)
    expect(fired).toEqual(["neg", "nan"])
    await clock.advance(-10) // clamps: time never goes backwards
    expect(clock.now()).toBe(0)
  })

  test("advances requested from inside a timer run after the current one", async () => {
    const clock = new ManualClock()
    const log: string[] = []
    clock.setTimeout(() => {
      log.push(`t1@${clock.now()}`)
      void clock.advance(10)
    }, 5)
    clock.setTimeout(() => log.push(`t2@${clock.now()}`), 8)
    clock.setTimeout(() => log.push(`t3@${clock.now()}`), 12)
    await clock.advance(10)
    expect(log).toEqual(["t1@5", "t2@8"])
    await clock.advance(0) // queued behind the nested advance(10)
    expect(log).toEqual(["t1@5", "t2@8", "t3@12"])
    expect(clock.now()).toBe(20)
  })

  test("a throwing timer fails the advance; later advances still run", async () => {
    const clock = new ManualClock()
    clock.setTimeout(() => {
      throw new Error("assertion failed")
    }, 1)
    const fired: number[] = []
    clock.setTimeout(() => fired.push(clock.now()), 2)
    await expect(clock.advance(5)).rejects.toThrow("assertion failed")
    await clock.advance(5)
    expect(fired).toEqual([2])
  })
})
