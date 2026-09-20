import { describe, expect, test } from "bun:test"
import { MemoryBackplane, MemoryBus } from "./memory"

const bytes = (...values: number[]): Uint8Array => new Uint8Array(values)

/** Resolves with the next message a subscription receives. */
function nextMessage(
  backplane: MemoryBackplane,
  channel: string,
): Promise<Uint8Array> {
  return new Promise((resolve) => {
    void backplane.subscribe(channel, resolve)
  })
}

describe("MemoryBackplane", () => {
  test("delivers across a shared bus, including to the publisher", async () => {
    const bus = new MemoryBus()
    const a = new MemoryBackplane(bus)
    const b = new MemoryBackplane(bus)
    const atA = nextMessage(a, "ch")
    const atB = nextMessage(b, "ch")
    expect((await a.publish("ch", bytes(1, 2, 3))).isOk()).toBe(true)
    expect([...(await atA)]).toEqual([1, 2, 3])
    expect([...(await atB)]).toEqual([1, 2, 3])
  })

  test("carries every byte value unchanged", async () => {
    const backplane = new MemoryBackplane()
    const got = nextMessage(backplane, "ch")
    const all = Uint8Array.from({ length: 256 }, (_, i) => i)
    await backplane.publish("ch", all)
    expect([...(await got)]).toEqual([...all])
  })

  test("delivery is asynchronous, in order, and by copy", async () => {
    const backplane = new MemoryBackplane()
    const seen: number[][] = []
    await backplane.subscribe("ch", (data) => seen.push([...data]))
    const payload = bytes(1)
    const first = backplane.publish("ch", payload)
    const second = backplane.publish("ch", bytes(2))
    payload[0] = 99 // after publish: not seen by subscribers
    expect(seen).toEqual([]) // never delivered re-entrantly
    await first
    await second
    await Promise.resolve()
    expect(seen).toEqual([[1], [2]])
  })

  test("each callback gets its own array", async () => {
    const backplane = new MemoryBackplane()
    const seen: Uint8Array[] = []
    await backplane.subscribe("ch", (data) => {
      seen.push(data)
      data[0] = 99 // a callback that mutates what it got
    })
    await backplane.subscribe("ch", (data) => seen.push(data))
    await backplane.publish("ch", bytes(1))
    await Promise.resolve()
    expect(seen.map((d) => [...d])).toEqual([[99], [1]])
    expect(seen[0]).not.toBe(seen[1])
  })

  test("several callbacks per channel; unsubscribe removes them all", async () => {
    const backplane = new MemoryBackplane()
    const seen: string[] = []
    await backplane.subscribe("ch", () => seen.push("one"))
    await backplane.subscribe("ch", () => seen.push("two"))
    await backplane.publish("ch", bytes(1))
    await Promise.resolve()
    expect(seen).toEqual(["one", "two"])
    await backplane.unsubscribe("ch")
    await backplane.publish("ch", bytes(2))
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
      await backplane.publish("ch", bytes(7))
      expect([...(await got)]).toEqual([7])
    } finally {
      console.error = original
    }
  })

  test("publishing on a closed backplane is a result, not a throw", async () => {
    const backplane = new MemoryBackplane()
    await backplane.close()
    const closed = await backplane.publish("ch", bytes(1))
    expect(closed.isErr() && closed.error).toMatchObject({
      code: "CONNECTION_FAILED",
    })
  })
})
