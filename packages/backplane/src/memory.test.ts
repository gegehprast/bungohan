import { describe, expect, test } from "bun:test"
import { MemoryBackplane, MemoryBus } from "./memory"

/** Resolves with the next message a subscription receives. */
function nextMessage<M>(
  backplane: MemoryBackplane,
  channel: string,
): Promise<M> {
  return new Promise((resolve) => {
    backplane.subscribe<M>(channel, resolve)
  })
}

describe("MemoryBackplane", () => {
  test("delivers across a shared bus, including to the publisher", async () => {
    const bus = new MemoryBus()
    const a = new MemoryBackplane(bus)
    const b = new MemoryBackplane(bus)
    const atA = nextMessage<{ n: number }>(a, "ch")
    const atB = nextMessage<{ n: number }>(b, "ch")
    expect((await a.publish("ch", { n: 1 })).isOk()).toBe(true)
    expect(await atA).toEqual({ n: 1 })
    expect(await atB).toEqual({ n: 1 })
  })

  test("delivery is asynchronous, in order, and by JSON copy", async () => {
    const backplane = new MemoryBackplane()
    const seen: unknown[] = []
    await backplane.subscribe("ch", (m) => seen.push(m))
    const payload = { list: [1] }
    const first = backplane.publish("ch", payload)
    const second = backplane.publish("ch", "second")
    payload.list.push(2) // after publish: not seen by subscribers
    expect(seen).toEqual([]) // never delivered re-entrantly
    await first
    await second
    await Promise.resolve()
    expect(seen).toEqual([{ list: [1] }, "second"])
  })

  test("several callbacks per channel; unsubscribe removes them all", async () => {
    const backplane = new MemoryBackplane()
    const seen: string[] = []
    await backplane.subscribe("ch", () => seen.push("one"))
    await backplane.subscribe("ch", () => seen.push("two"))
    await backplane.publish("ch", 1)
    await Promise.resolve()
    expect(seen).toEqual(["one", "two"])
    await backplane.unsubscribe("ch")
    await backplane.publish("ch", 2)
    await Promise.resolve()
    expect(seen).toEqual(["one", "two"])
  })

  test("a throwing callback doesn't stop the others", async () => {
    const backplane = new MemoryBackplane()
    const original = console.error
    console.error = () => {}
    try {
      const got = nextMessage(backplane, "ch")
      await backplane.subscribe("ch", () => {
        throw new Error("bug")
      })
      await backplane.publish("ch", "x")
      expect(await got).toBe("x")
    } finally {
      console.error = original
    }
  })

  test("errors are results: unserializable messages, closed backplanes", async () => {
    const backplane = new MemoryBackplane()
    const bad = await backplane.publish("ch", 1n)
    expect(bad.isErr() && bad.error).toMatchObject({
      code: "SERIALIZATION_FAILED",
    })
    await backplane.close()
    const closed = await backplane.publish("ch", 1)
    expect(closed.isErr() && closed.error).toMatchObject({
      code: "CONNECTION_FAILED",
    })
  })
})
