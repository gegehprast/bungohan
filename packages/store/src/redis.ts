import { err, ok, type Result } from "@bungohan/result"
import { RedisClient, type RedisOptions } from "bun"
import { reason, StoreError } from "./errors"
import { checkTtl, fromJson, toJson } from "./json"
import type { IStore } from "./store"

/**
 * The part of Bun's `RedisClient` the store uses. Bun's client satisfies it;
 * tests pass an in-memory fake.
 */
export interface RedisStoreClient {
  readonly connected: boolean
  connect(): Promise<void>
  close(): void
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<unknown>
  setex(key: string, seconds: number, value: string): Promise<unknown>
  del(key: string): Promise<unknown>
  exists(key: string): Promise<boolean>
}

export interface RedisConnectionOptions {
  /** `redis://…` / `rediss://…`; takes precedence over host/port/password. */
  url?: string
  host?: string
  port?: number
  password?: string
  /** Passed through to Bun's `RedisClient`. */
  redis?: RedisOptions
}

export interface RedisStoreOptions extends RedisConnectionOptions {
  /** Use this client instead of creating one (tests, shared connections). */
  client?: RedisStoreClient
}

/** Connection URL from options; the password is URL-encoded. */
export function redisUrl(options: RedisConnectionOptions): string {
  if (options.url !== undefined) return options.url
  const host = options.host ?? "localhost"
  const port = options.port ?? 6379
  const auth =
    options.password === undefined
      ? ""
      : `:${encodeURIComponent(options.password)}@`
  return `redis://${auth}${host}:${port}`
}

/**
 * `IStore` on Bun's native `RedisClient`. Values are JSON strings; TTLs use
 * `SETEX`. Construction never throws: a bad URL makes every operation
 * return `INVALID_OPTIONS`.
 */
export class RedisStore implements IStore {
  private readonly _client: Result<RedisStoreClient, StoreError>
  private _closed = false

  public constructor(options: RedisStoreOptions = {}) {
    if (options.client !== undefined) {
      this._client = ok(options.client)
      return
    }
    const url = redisUrl(options)
    try {
      this._client = ok(new RedisClient(url, options.redis))
    } catch (error) {
      this._client = err(
        new StoreError(
          "INVALID_OPTIONS",
          `cannot create a Redis client: ${reason(error)}`,
        ),
      )
    }
  }

  /** Connects eagerly (commands otherwise connect on first use). */
  public async connect(): Promise<Result<void, Error>> {
    const client = this._use()
    if (client.isErr()) return client
    try {
      await client.value.connect()
      return ok(undefined)
    } catch (error) {
      return err(
        new StoreError(
          "CONNECTION_FAILED",
          `cannot connect to Redis: ${reason(error)}`,
        ),
      )
    }
  }

  /** Whether the Redis connection is open right now (false once closed). */
  public isConnected(): boolean {
    return !this._closed && this._client.isOk() && this._client.value.connected
  }

  public async set(
    key: string,
    value: unknown,
    ttl?: number,
  ): Promise<Result<void, Error>> {
    const valid = checkTtl(ttl)
    if (valid.isErr()) return valid
    const json = toJson(value)
    if (json.isErr()) return json
    return this._run(`set "${key}"`, (client) =>
      ttl === undefined
        ? client.set(key, json.value)
        : client.setex(key, ttl, json.value),
    ).then((result) => result.map(() => undefined))
  }

  public async get(key: string): Promise<Result<unknown, Error>> {
    const result = await this._run(`get "${key}"`, (client) => client.get(key))
    if (result.isErr()) return result
    return result.value === null ? ok(undefined) : fromJson(key, result.value)
  }

  public async delete(key: string): Promise<Result<void, Error>> {
    const result = await this._run(`delete "${key}"`, (client) =>
      client.del(key),
    )
    return result.map(() => undefined)
  }

  public async exists(key: string): Promise<Result<boolean, Error>> {
    return this._run(`exists "${key}"`, (client) => client.exists(key))
  }

  public async close(): Promise<Result<void, Error>> {
    if (this._closed) return ok(undefined)
    this._closed = true
    if (this._client.isErr()) return ok(undefined)
    try {
      this._client.value.close()
      return ok(undefined)
    } catch (error) {
      return err(
        new StoreError(
          "CONNECTION_FAILED",
          `cannot close the Redis connection: ${reason(error)}`,
        ),
      )
    }
  }

  private _use(): Result<RedisStoreClient, StoreError> {
    if (this._closed) {
      return err(new StoreError("CONNECTION_FAILED", "store is closed"))
    }
    return this._client
  }

  private async _run<T>(
    what: string,
    command: (client: RedisStoreClient) => Promise<T>,
  ): Promise<Result<T, StoreError>> {
    const client = this._use()
    if (client.isErr()) return client
    try {
      return ok(await command(client.value))
    } catch (error) {
      return err(
        new StoreError("OPERATION_FAILED", `${what} failed: ${reason(error)}`),
      )
    }
  }
}
