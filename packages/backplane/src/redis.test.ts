import { describe, expect, test } from "bun:test"
import { fromBinaryString, toBinaryString } from "./binary"
import { RedisBackplane, type RedisPubSubClient } from "./redis"

const bytes = (...values: number[]): Uint8Array => new Uint8Array(values)

type Listener = (message: string, channel: string) => void

/** A fake Redis server: publish fans out to subscribed fake clients. */
class FakeServer {
  public readonly clients = new Set<FakeClient>()
  public subscribeCalls = 0

  public client(): FakeClient {
    const client = new FakeClient(this)
    this.clients.add(client)
    return client
  }
}

class FakeClient implements RedisPubSubClient {
  public connected = false
  public readonly listeners = new Map<string, Listener>()
  /** Next command rejects with this. */
  public failWith: Error | undefined
  /** Holds SUBSCRIBE replies until released. */
  public gate: Promise<void> | undefined
  private readonly _server: FakeServer

  public constructor(server: FakeServer) {
    this._server = server
  }

  public async connect(): Promise<void> {
    this._fail()
    this.connected = true
  }

  public close(): void {
    this.connected = false
    this.listeners.clear()
  }

  public async publish(channel: string, message: string): Promise<number> {
    this._fail()
    let count = 0
    for (const client of this._server.clients) {
      const listener = client.listeners.get(channel)
      if (listener !== undefined) {
        count++
        queueMicrotask(() => listener(message, channel))
      }
    }
    return count
  }

  public async subscribe(channel: string, listener: Listener): Promise<number> {
    this._server.subscribeCalls++
    await this.gate
    this._fail()
    this.listeners.set(channel, listener)
    return this.listeners.size
  }

  public async unsubscribe(channel: string): Promise<void> {
    this._fail()
    this.listeners.delete(channel)
  }

  private _fail(): void {
    const error = this.failWith
    this.failWith = undefined
    if (error !== undefined) throw error
  }
}

function backplane(server = new FakeServer()) {
  const publisher = server.client()
  const subscriber = server.client()
  return {
    server,
    subscriber,
    bp: new RedisBackplane({ clients: { publisher, subscriber } }),
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

describe("RedisBackplane", () => {
  test("publishes bytes between processes", async () => {
    const server = new FakeServer()
    const a = backplane(server).bp
    const b = backplane(server).bp
    const seen: number[][] = []
    await b.subscribe("ch", (m) => seen.push([...m]))
    expect((await a.publish("ch", bytes(1, 2, 3))).isOk()).toBe(true)
    await settle()
    expect(seen).toEqual([[1, 2, 3]])
  })

  test("every byte value survives the string hop", async () => {
    // Bun's client only publishes strings, so the bytes travel as latin1
    // (binary.ts). This pins the mapping; the real Redis is pinned by
    // redis.integration.test.ts.
    const server = new FakeServer()
    const a = backplane(server).bp
    const b = backplane(server).bp
    const seen: number[][] = []
    await b.subscribe("ch", (m) => seen.push([...m]))
    const all = Uint8Array.from({ length: 256 }, (_, i) => i)
    await a.publish("ch", all)
    await settle()
    expect(seen).toEqual([[...all]])
  })

  test("one Redis SUBSCRIBE per channel, however many callbacks", async () => {
    const { bp, server } = backplane()
    const seen: string[] = []
    await Promise.all([
      bp.subscribe("ch", () => seen.push("one")),
      bp.subscribe("ch", () => seen.push("two")),
    ])
    await bp.subscribe("ch", () => seen.push("three"))
    expect(server.subscribeCalls).toBe(1)
    await bp.publish("ch", bytes(1))
    await settle()
    expect(seen).toEqual(["one", "two", "three"])
  })

  test("a failed SUBSCRIBE rolls back and can be retried", async () => {
    const { bp, subscriber, server } = backplane()
    subscriber.failWith = new Error("NOPERM")
    const seen: number[][] = []
    const failed = await bp.subscribe("ch", (m) => seen.push([...m]))
    expect(failed.isErr() && failed.error).toMatchObject({
      code: "OPERATION_FAILED",
      message: 'subscribe to "ch" failed: NOPERM',
    })
    expect((await bp.subscribe("ch", (m) => seen.push([...m]))).isOk()).toBe(
      true,
    )
    expect(server.subscribeCalls).toBe(2)
    await bp.publish("ch", bytes(9))
    await settle()
    expect(seen).toEqual([[9]]) // the failed callback was dropped
  })

  test("unsubscribe while a SUBSCRIBE is in flight ends unsubscribed", async () => {
    const { bp, subscriber } = backplane()
    let release: () => void = () => {}
    subscriber.gate = new Promise((resolve) => (release = resolve))
    const seen: number[][] = []
    const subscribing = bp.subscribe("ch", (m) => seen.push([...m]))
    const unsubscribing = bp.unsubscribe("ch")
    release()
    await subscribing
    expect((await unsubscribing).isOk()).toBe(true)
    expect(subscriber.listeners.has("ch")).toBe(false)
    await bp.publish("ch", bytes(1))
    await settle()
    expect(seen).toEqual([])
  })

  test("a throwing callback doesn't stop the others", async () => {
    const { bp, subscriber } = backplane()
    const seen: number[][] = []
    await bp.subscribe("ch", () => {
      throw new Error("bug")
    })
    await bp.subscribe("ch", (m) => seen.push([...m]))
    const original = console.error
    console.error = () => {}
    try {
      subscriber.listeners.get("ch")?.(toBinaryString(bytes(5)), "ch")
    } finally {
      console.error = original
    }
    expect(seen).toEqual([[5]])
  })

  test("latin1 round-trips every byte", () => {
    const all = Uint8Array.from({ length: 256 }, (_, i) => i)
    expect([...fromBinaryString(toBinaryString(all))]).toEqual([...all])
    // Bytes that are valid UTF-8 must not be folded into one code point.
    expect(toBinaryString(bytes(0xc3, 0xa9)).length).toBe(2)
  })

  test("connection and command failures are error results", async () => {
    const { bp, subscriber, server } = backplane()
    subscriber.failWith = new Error("refused")
    const connect = await bp.connect()
    expect(connect.isErr() && connect.error).toMatchObject({
      code: "CONNECTION_FAILED",
    })
    expect(bp.isConnected()).toBe(false)
    expect((await bp.connect()).isOk()).toBe(true)
    expect(bp.isConnected()).toBe(true)
    const publisher = [...server.clients][0]
    if (publisher !== undefined) publisher.failWith = new Error("LOADING")
    const publish = await bp.publish("ch", bytes(1))
    expect(publish.isErr() && publish.error).toMatchObject({
      code: "OPERATION_FAILED",
    })
  })

  test("close ends everything; later calls are refused", async () => {
    const { bp, subscriber } = backplane()
    await bp.subscribe("ch", () => {})
    expect((await bp.close()).isOk()).toBe(true)
    expect((await bp.close()).isOk()).toBe(true)
    expect(subscriber.connected).toBe(false)
    const result = await bp.subscribe("ch", () => {})
    expect(result.isErr() && result.error).toMatchObject({
      code: "CONNECTION_FAILED",
    })
  })

  test("an invalid URL never throws; operations report it", async () => {
    const bp = new RedisBackplane({ url: "not a url" })
    const result = await bp.publish("ch", bytes(1))
    expect(result.isErr() && result.error).toMatchObject({
      code: "INVALID_OPTIONS",
    })
  })
})
