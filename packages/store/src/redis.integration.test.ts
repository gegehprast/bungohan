/**
 * Runs against a real Redis when REDIS_URL is set; skipped otherwise.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { RedisClient } from "bun"
import { RedisStore } from "./redis"

const url = process.env.REDIS_URL
const prefix = `bungohan-test:${crypto.randomUUID()}:`

describe.skipIf(url === undefined)("RedisStore (live Redis)", () => {
  const store = new RedisStore({ url })

  afterAll(async () => {
    for (const key of ["obj", "ttl", "gone"]) await store.delete(prefix + key)
    await store.close()
  })

  test("connects", async () => {
    expect((await store.connect()).isOk()).toBe(true)
    expect(store.isConnected()).toBe(true)
  })

  test("round-trips JSON values", async () => {
    const value = { players: [{ id: "a", hp: 100 }], round: 3 }
    expect((await store.set(`${prefix}obj`, value)).isOk()).toBe(true)
    expect((await store.get(`${prefix}obj`)).unwrap()).toEqual(value)
    expect((await store.exists(`${prefix}obj`)).unwrap()).toBe(true)
    expect((await store.get(`${prefix}missing`)).unwrap()).toBeUndefined()
  })

  test("sets a TTL", async () => {
    await store.set(`${prefix}ttl`, 1, 60)
    const raw = new RedisClient(url)
    const ttl = await raw.ttl(`${prefix}ttl`)
    raw.close()
    expect(ttl).toBeGreaterThan(0)
    expect(ttl).toBeLessThanOrEqual(60)
  })

  test("deletes", async () => {
    await store.set(`${prefix}gone`, 1)
    await store.delete(`${prefix}gone`)
    expect((await store.exists(`${prefix}gone`)).unwrap()).toBe(false)
  })
})
