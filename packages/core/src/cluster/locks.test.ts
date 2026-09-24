import { describe, expect, test } from "bun:test"
import type { Clock, TimerId } from "@bungohan/types"
import { coordinatorOf, LockTable } from "./locks"

/** Timeouts that fire only when the test says so. */
class TimerClock implements Clock {
  private readonly _timers = new Map<TimerId, () => void>()
  private _next = 1

  public now(): number {
    return 0
  }

  public setTimeout(callback: () => void): TimerId {
    const id = this._next++
    this._timers.set(id, callback)
    return id
  }

  public clearTimeout(id: TimerId): void {
    this._timers.delete(id)
  }

  public setInterval(): TimerId {
    return this._next++
  }

  public clearInterval(): void {}

  /** Fires every pending timeout once. */
  public fireAll(): void {
    const due = [...this._timers.values()]
    this._timers.clear()
    for (const callback of due) callback()
  }
}

/** Resolves (on a microtask) to which of the grants happened. */
async function granted(...locks: Promise<void>[]): Promise<boolean[]> {
  const done = locks.map(() => false)
  locks.forEach((lock, i) => {
    void lock.then(() => {
      done[i] = true
    })
  })
  await Promise.resolve()
  await Promise.resolve()
  return done
}

describe("LockTable", () => {
  test("one holder per pool, the rest in arrival order", async () => {
    const table = new LockTable(new TimerClock(), 1000)
    const a = table.acquire("p", "x", "a")
    const b = table.acquire("p", "y", "b")
    const other = table.acquire("q", "y", "c")
    expect(await granted(a, b, other)).toEqual([true, false, true])
    table.release("p", "a")
    expect(await granted(b)).toEqual([true])
    table.release("p", "b")
    table.release("q", "c")
    expect(table.size()).toBe(0)
  })

  test("a queued request can give up before its turn", async () => {
    const table = new LockTable(new TimerClock(), 1000)
    void table.acquire("p", "x", "a")
    const b = table.acquire("p", "y", "b")
    const c = table.acquire("p", "z", "c")
    table.release("p", "b") // b gives up
    table.release("p", "a")
    expect(await granted(b, c)).toEqual([false, true])
  })

  test("a lease that outlives its time is taken back", async () => {
    const clock = new TimerClock()
    const table = new LockTable(clock, 1000)
    void table.acquire("p", "x", "a")
    const b = table.acquire("p", "y", "b")
    clock.fireAll() // a's lease expires
    expect(await granted(b)).toEqual([true])
  })

  test("a lost process's lease ends and its waiters leave", async () => {
    const table = new LockTable(new TimerClock(), 1000)
    void table.acquire("p", "gone", "a")
    const b = table.acquire("p", "gone", "b")
    const c = table.acquire("p", "here", "c")
    table.processLost("gone")
    expect(await granted(b, c)).toEqual([false, true])
  })
})

describe("coordinatorOf", () => {
  test("every member order gives the same coordinator", () => {
    const members = ["p0", "p1", "p2", "p3"]
    for (const pool of ["game", '["game","key","m1"]', "lobby"]) {
      const one = coordinatorOf(pool, members)
      expect(coordinatorOf(pool, [...members].reverse())).toBe(one)
      expect(members).toContain(one ?? "none")
    }
  })

  test("losing a member moves only the pools it coordinated", () => {
    const members = ["p0", "p1", "p2", "p3"]
    const pools = Array.from({ length: 200 }, (_, i) => `pool-${i}`)
    const before = pools.map((pool) => coordinatorOf(pool, members))
    const after = pools.map((pool) =>
      coordinatorOf(
        pool,
        members.filter((member) => member !== "p2"),
      ),
    )
    pools.forEach((_, i) => {
      if (before[i] !== "p2") expect(after[i]).toBe(before[i])
    })
    expect(before).toContain("p2")
  })
})
