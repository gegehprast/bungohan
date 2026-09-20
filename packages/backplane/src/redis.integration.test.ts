/**
 * Runs against a real Redis when REDIS_URL is set; skipped otherwise.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { RedisBackplane } from "./redis"

const bytes = (...values: number[]): Uint8Array => new Uint8Array(values)

const url = process.env.REDIS_URL
const channel = `bungohan-test:${crypto.randomUUID()}`

describe.skipIf(url === undefined)("RedisBackplane (live Redis)", () => {
  const a = new RedisBackplane({ url })
  const b = new RedisBackplane({ url })

  afterAll(async () => {
    await a.close()
    await b.close()
  })

  test("connects", async () => {
    expect((await a.connect()).isOk()).toBe(true)
    expect((await b.connect()).isOk()).toBe(true)
    expect(a.isConnected() && b.isConnected()).toBe(true)
  })

  test("delivers between two backplanes, and back to the publisher", async () => {
    const atB = new Promise<Uint8Array>((resolve) => {
      void b.subscribe(channel, resolve)
    })
    const atA = new Promise<Uint8Array>((resolve) => {
      void a.subscribe(channel, resolve)
    })
    // subscribe() resolves once the SUBSCRIBE is live; wait for both.
    await b.subscribe(channel, () => {})
    await a.subscribe(channel, () => {})
    const message = bytes(0x92, 0x01, 0x02)
    expect((await a.publish(channel, message)).isOk()).toBe(true)
    expect([...(await atB)]).toEqual([...message])
    expect([...(await atA)]).toEqual([...message])
  })

  test("every byte value survives a real Redis, unchanged", async () => {
    // Bun's `RedisClient` only publishes strings and only hands a
    // subscriber a string ("buffer subscriptions are not yet implemented"
    // in its own typings), so `RedisBackplane` sends the bytes as latin1.
    // That it is byte-exact is Bun's behaviour, not a documented promise —
    // this test is what pins it. If Bun ever decodes a pub/sub payload as
    // UTF-8 instead, this fails here rather than corrupting cluster
    // traffic in production.
    const binary = `${channel}:binary`
    const got = new Promise<Uint8Array>((resolve) => {
      void b.subscribe(binary, resolve)
    })
    await b.subscribe(binary, () => {})
    const all = Uint8Array.from({ length: 256 }, (_, i) => i)
    expect((await a.publish(binary, all)).isOk()).toBe(true)
    expect([...(await got)]).toEqual([...all])
  })

  test("a payload that is valid UTF-8 is not folded into code points", async () => {
    const utf8 = `${channel}:utf8`
    const got = new Promise<Uint8Array>((resolve) => {
      void b.subscribe(utf8, resolve)
    })
    await b.subscribe(utf8, () => {})
    // "é" and "€" as UTF-8: a UTF-8 decode would give 1 code point each.
    const message = bytes(0xc3, 0xa9, 0xe2, 0x82, 0xac)
    await a.publish(utf8, message)
    expect([...(await got)]).toEqual([...message])
  })

  test("unsubscribe stops delivery", async () => {
    await b.unsubscribe(channel)
    const seen: number[][] = []
    await b.subscribe(`${channel}:other`, (m) => seen.push([...m]))
    const marker = new Promise((resolve) => {
      void a.subscribe(channel, resolve)
    })
    // Publish to the old channel, then wait for a round trip on `a`.
    await a.publish(channel, bytes(0xaa))
    await marker
    await a.publish(`${channel}:other`, bytes(0xbb))
    await new Promise((resolve) => {
      void b.subscribe(`${channel}:other`, resolve)
    })
    expect(seen).not.toContainEqual([0xaa])
  })
})
