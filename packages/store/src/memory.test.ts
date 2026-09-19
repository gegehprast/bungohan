import { describe, expect, test } from "bun:test"
import { MemoryStore } from "./memory"

describe("MemoryStore", () => {
  test("stores JSON values by copy", async () => {
    const store = new MemoryStore()
    const value = { a: [1, 2], b: "x" }
    expect((await store.set("k", value)).isOk()).toBe(true)
    value.a.push(3)
    expect((await store.get("k")).unwrap()).toEqual({ a: [1, 2], b: "x" })
    expect((await store.exists("k")).unwrap()).toBe(true)
  })

  test("missing keys are ok(undefined); null is a value", async () => {
    const store = new MemoryStore()
    expect((await store.get("nope")).unwrap()).toBeUndefined()
    await store.set("n", null)
    expect((await store.get("n")).unwrap()).toBeNull()
    expect((await store.exists("n")).unwrap()).toBe(true)
  })

  test("TTLs follow the injected clock", async () => {
    let now = 1000
    const store = new MemoryStore({ now: () => now })
    await store.set("k", 1, 2)
    now += 1999
    expect((await store.get("k")).unwrap()).toBe(1)
    now += 1
    expect((await store.exists("k")).unwrap()).toBe(false)
    expect((await store.get("k")).unwrap()).toBeUndefined()
  })

  test("delete, and deleting a missing key", async () => {
    const store = new MemoryStore()
    await store.set("k", 1)
    expect((await store.delete("k")).isOk()).toBe(true)
    expect((await store.delete("k")).isOk()).toBe(true)
    expect((await store.exists("k")).unwrap()).toBe(false)
  })

  test("invalid input is an error, not a throw", async () => {
    const store = new MemoryStore()
    for (const ttl of [0, -1, 1.5, Number.NaN]) {
      const result = await store.set("k", 1, ttl)
      expect(result.isErr() && result.error).toMatchObject({
        code: "INVALID_OPTIONS",
      })
    }
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    for (const value of [undefined, cyclic, 10n]) {
      const result = await store.set("k", value)
      expect(result.isErr() && result.error).toMatchObject({
        code: "SERIALIZATION_FAILED",
      })
    }
  })

  test("a closed store refuses operations", async () => {
    const store = new MemoryStore()
    await store.set("k", 1)
    await store.close()
    const result = await store.get("k")
    expect(result.isErr() && result.error).toMatchObject({
      code: "CONNECTION_FAILED",
    })
  })
})
