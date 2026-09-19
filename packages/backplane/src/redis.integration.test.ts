/**
 * Runs against a real Redis when REDIS_URL is set; skipped otherwise.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { RedisBackplane } from "./redis"

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
    const atB = new Promise((resolve) => b.subscribe(channel, resolve))
    const atA = new Promise((resolve) => a.subscribe(channel, resolve))
    // subscribe() resolves once the SUBSCRIBE is live; wait for both.
    await b.subscribe(channel, () => {})
    await a.subscribe(channel, () => {})
    const message = { type: "PROCESS_INFO_REQUEST", requestId: "r1" }
    expect((await a.publish(channel, message)).isOk()).toBe(true)
    expect(await atB).toEqual(message)
    expect(await atA).toEqual(message)
  })

  test("unsubscribe stops delivery", async () => {
    await b.unsubscribe(channel)
    const seen: unknown[] = []
    await b.subscribe(`${channel}:other`, (m) => seen.push(m))
    const marker = new Promise((resolve) => a.subscribe(channel, resolve))
    // Publish to the old channel, then wait for a round trip on `a`.
    await a.publish(channel, "after")
    await marker
    await a.publish(`${channel}:other`, "sync")
    await new Promise((resolve) => b.subscribe(`${channel}:other`, resolve))
    expect(seen).not.toContain("after")
  })
})
