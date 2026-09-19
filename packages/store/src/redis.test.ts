import { describe, expect, test } from "bun:test"
import { RedisStore, type RedisStoreClient, redisUrl } from "./redis"

/** In-memory stand-in for Bun's RedisClient; records commands. */
class FakeRedis implements RedisStoreClient {
  public connected = false
  public readonly data = new Map<string, string>()
  public readonly log: string[] = []
  /** Next command rejects with this. */
  public failWith: Error | undefined
  public closed = false

  public async connect(): Promise<void> {
    this._fail()
    this.connected = true
  }

  public close(): void {
    this.closed = true
    this.connected = false
  }

  public async get(key: string): Promise<string | null> {
    this._fail()
    this.log.push(`GET ${key}`)
    return this.data.get(key) ?? null
  }

  public async set(key: string, value: string): Promise<unknown> {
    this._fail()
    this.log.push(`SET ${key} ${value}`)
    this.data.set(key, value)
    return "OK"
  }

  public async setex(key: string, seconds: number, value: string) {
    this._fail()
    this.log.push(`SETEX ${key} ${seconds} ${value}`)
    this.data.set(key, value)
    return "OK"
  }

  public async del(key: string): Promise<unknown> {
    this._fail()
    this.log.push(`DEL ${key}`)
    return this.data.delete(key) ? 1 : 0
  }

  public async exists(key: string): Promise<boolean> {
    this._fail()
    return this.data.has(key)
  }

  private _fail(): void {
    const error = this.failWith
    this.failWith = undefined
    if (error !== undefined) throw error
  }
}

function store(): [RedisStore, FakeRedis] {
  const client = new FakeRedis()
  return [new RedisStore({ client }), client]
}

describe("RedisStore", () => {
  test("JSON-encodes values; TTLs use SETEX", async () => {
    const [s, redis] = store()
    await s.set("a", { x: 1 })
    await s.set("b", [1, "two"], 30)
    expect(redis.log).toEqual(['SET a {"x":1}', 'SETEX b 30 [1,"two"]'])
    expect((await s.get("a")).unwrap()).toEqual({ x: 1 })
    expect((await s.get("b")).unwrap()).toEqual([1, "two"])
  })

  test("missing keys, exists and delete", async () => {
    const [s] = store()
    expect((await s.get("nope")).unwrap()).toBeUndefined()
    await s.set("k", false)
    expect((await s.exists("k")).unwrap()).toBe(true)
    expect((await s.get("k")).unwrap()).toBe(false)
    expect((await s.delete("k")).isOk()).toBe(true)
    expect((await s.exists("k")).unwrap()).toBe(false)
  })

  test("validation happens before any command is sent", async () => {
    const [s, redis] = store()
    const ttl = await s.set("k", 1, 0)
    expect(ttl.isErr() && ttl.error).toMatchObject({ code: "INVALID_OPTIONS" })
    const value = await s.set("k", undefined)
    expect(value.isErr() && value.error).toMatchObject({
      code: "SERIALIZATION_FAILED",
    })
    expect(redis.log).toEqual([])
  })

  test("a value that isn't JSON (written by someone else) is an error", async () => {
    const [s, redis] = store()
    redis.data.set("k", "{oops")
    const result = await s.get("k")
    expect(result.isErr() && result.error).toMatchObject({
      code: "SERIALIZATION_FAILED",
    })
  })

  test("failed commands and connections become error results", async () => {
    const [s, redis] = store()
    redis.failWith = new Error("ECONNRESET")
    const result = await s.get("k")
    expect(result.isErr() && result.error).toMatchObject({
      code: "OPERATION_FAILED",
      message: 'get "k" failed: ECONNRESET',
    })
    redis.failWith = new Error("refused")
    const connect = await s.connect()
    expect(connect.isErr() && connect.error).toMatchObject({
      code: "CONNECTION_FAILED",
    })
    expect(s.isConnected()).toBe(false)
    expect((await s.connect()).isOk()).toBe(true)
    expect(s.isConnected()).toBe(true)
  })

  test("close closes the client once; later calls are refused", async () => {
    const [s, redis] = store()
    expect((await s.close()).isOk()).toBe(true)
    expect((await s.close()).isOk()).toBe(true)
    expect(redis.closed).toBe(true)
    const result = await s.set("k", 1)
    expect(result.isErr() && result.error).toMatchObject({
      code: "CONNECTION_FAILED",
    })
  })

  test("an invalid URL never throws; operations report it", async () => {
    const s = new RedisStore({ url: "not a url" })
    const result = await s.get("k")
    expect(result.isErr() && result.error).toMatchObject({
      code: "INVALID_OPTIONS",
    })
    expect(s.isConnected()).toBe(false)
  })
})

describe("redisUrl", () => {
  test("prefers url, else builds one with an encoded password", () => {
    expect(redisUrl({ url: "rediss://x:1" })).toBe("rediss://x:1")
    expect(redisUrl({})).toBe("redis://localhost:6379")
    expect(redisUrl({ host: "db", port: 7000, password: "p@ss:w/rd" })).toBe(
      "redis://:p%40ss%3Aw%2Frd@db:7000",
    )
  })
})
