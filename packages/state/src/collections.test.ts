import { describe, expect, mock, test } from "bun:test"
import { f } from "@bungohan/types"
import {
  createArray,
  createBoolean,
  createFixedPoint,
  createFloat32,
  createMap,
  createNumber,
  createSchemaArray,
  createSet,
  createString,
} from "./factories"
import { Item, item } from "./test-fixtures"

describe("primitive wrappers", () => {
  test("get / set / value, with defaults", () => {
    const n = createNumber()
    expect(n.get()).toBe(0)
    n.set(5)
    expect(n.value).toBe(5)
    n.value = 6
    expect(n.get()).toBe(6)
    expect(createString().get()).toBe("")
    expect(createBoolean().get()).toBe(false)
    expect(createNumber(3).get()).toBe(3)
  })

  test("string literal unions", () => {
    const status = createString<"idle" | "busy">("idle")
    status.set("busy")
    expect(status.get()).toBe("busy")
  })

  test("onChange gets (new, old); unsubscribe and offChange work", () => {
    const n = createNumber(1)
    const listener = mock((_n: number, _o: number) => {})
    const off = n.onChange(listener)
    n.set(2)
    n.set(2) // unchanged: no call
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith(2, 1)
    off()
    n.set(3)
    expect(listener).toHaveBeenCalledTimes(1)

    const again = mock(() => {})
    n.onChange(again)
    n.offChange(again)
    n.set(4)
    expect(again).not.toHaveBeenCalled()
  })

  test("NaN is not a change from NaN", () => {
    const n = createNumber(Number.NaN)
    const listener = mock(() => {})
    n.onChange(listener)
    n.set(Number.NaN)
    expect(listener).not.toHaveBeenCalled()
  })

  test("lossy numerics keep full precision on the server", () => {
    const fixed = createFixedPoint(2, 1.23456)
    expect(fixed.get()).toBe(1.23456)
    expect(fixed._toWire()).toBe(123)
    expect(fixed._type).toBe("fixed:2")

    const f32 = createFloat32(0.1)
    expect(f32.get()).toBe(0.1)
    expect(f32._toWire()).toBe(Math.fround(0.1))
  })
})

describe("MapState", () => {
  test("native-like API", () => {
    const m = createMap(f.string, f.float64, new Map([["a", 1]]))
    m.set("b", 2)
    expect(m.get("b")).toBe(2)
    expect(m.has("a")).toBe(true)
    expect(m.size).toBe(2)
    expect([...m.keys()]).toEqual(["a", "b"])
    expect([...m]).toEqual([
      ["a", 1],
      ["b", 2],
    ])
    expect(m.delete("a")).toBe(true)
    expect(m.delete("a")).toBe(false)
    m.clear()
    expect(m.size).toBe(0)
  })

  test("onAdd / onChange / onRemove: value first, then key", () => {
    const m = createMap(f.string, f.float64)
    const events: unknown[] = []
    m.onAdd((v, k) => events.push(["add", v, k]))
    m.onChange((v, old, k) => events.push(["change", v, old, k]))
    m.onRemove((v, k) => events.push(["remove", v, k]))
    m.set("a", 1)
    m.set("a", 2)
    m.set("a", 2)
    m.delete("a")
    m.set("b", 3)
    m.clear()
    expect(events).toEqual([
      ["add", 1, "a"],
      ["change", 2, 1, "a"],
      ["remove", 2, "a"],
      ["add", 3, "b"],
      ["remove", 3, "b"],
    ])
  })
})

describe("SetState", () => {
  test("add / delete / clear with (value, value) listeners", () => {
    const s = createSet(f.string)
    const events: unknown[] = []
    s.onAdd((v, k) => events.push(["add", v, k]))
    s.onRemove((v, k) => events.push(["remove", v, k]))
    s.add("x").add("x").add("y")
    expect(s.size).toBe(2)
    expect(s.delete("x")).toBe(true)
    expect(s.delete("x")).toBe(false)
    s.clear()
    expect(events).toEqual([
      ["add", "x", "x"],
      ["add", "y", "y"],
      ["remove", "x", "x"],
      ["remove", "y", "y"],
    ])
  })
})

describe("ArrayState", () => {
  test("mutators match native semantics", () => {
    const a = createArray(f.float64, [1, 2, 3])
    const native = [1, 2, 3]
    const both = (fn: (x: { push: (...i: number[]) => number }) => void) => {
      fn(a)
      fn(native)
    }
    both((x) => x.push(4, 5))
    expect(a.pop()).toBe(native.pop())
    expect(a.shift()).toBe(native.shift())
    expect(a.unshift(9, 8)).toBe(native.unshift(9, 8))
    expect(a.splice(1, 2, 7)).toEqual(native.splice(1, 2, 7))
    expect(a.splice(-1)).toEqual(native.splice(-1))
    expect(a.splice(1)).toEqual(native.splice(1))
    expect(a.value).toEqual(native)
  })

  test("set replaces in range only", () => {
    const a = createArray(f.float64, [1, 2])
    expect(a.set(1, 5)).toBe(true)
    expect(a.set(2, 5)).toBe(false)
    expect(a.set(-1, 5)).toBe(false)
    expect(a.value).toEqual([1, 5])
  })

  test("sort / reverse / fill report replaced indices", () => {
    const a = createArray(f.float64, [3, 1, 2])
    const changes: unknown[] = []
    a.onChange((v, old, i) => changes.push([i, old, v]))
    a.sort((x, y) => x - y)
    expect(a.value).toEqual([1, 2, 3])
    expect(changes).toEqual([
      [0, 3, 1],
      [1, 1, 2],
      [2, 2, 3],
    ])
    changes.length = 0
    a.reverse()
    expect(changes).toEqual([
      [0, 1, 3],
      [2, 3, 1],
    ])
    a.fill(0, 1)
    expect(a.value).toEqual([3, 0, 0])
  })

  test("add/remove listeners carry indices", () => {
    const a = createArray(f.string)
    const events: unknown[] = []
    a.onAdd((v, i) => events.push(["add", v, i]))
    a.onRemove((v, i) => events.push(["remove", v, i]))
    a.push("a", "b")
    a.shift()
    a.clear()
    expect(events).toEqual([
      ["add", "a", 0],
      ["add", "b", 1],
      ["remove", "a", 0],
      ["remove", "b", 0],
    ])
  })

  test("read-only helpers", () => {
    const a = createSchemaArray(Item, [item("a", 1), item("b", 2)])
    expect(a.length).toBe(2)
    expect(a.map((i) => i.name.get())).toEqual(["a", "b"])
    expect(a.find((i) => i.qty.get() === 2)?.name.get()).toBe("b")
    expect(a.reduce((sum, i) => sum + i.qty.get(), 0)).toBe(3)
    expect(a.at(-1)?.name.get()).toBe("b")
  })
})
