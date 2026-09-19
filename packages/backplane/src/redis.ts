import { err, ok, type Result } from "@bungohan/result"
import { RedisClient, type RedisOptions } from "bun"
import type { IBackplane } from "./backplane"
import { type Callback, Channels, toJson } from "./channels"
import { BackplaneError, reason } from "./errors"

/**
 * The part of Bun's `RedisClient` the backplane uses. Bun's client
 * satisfies it; tests pass an in-memory fake.
 */
export interface RedisPubSubClient {
  readonly connected: boolean
  connect(): Promise<void>
  close(): void
  publish(channel: string, message: string): Promise<number>
  subscribe(
    channel: string,
    listener: (message: string, channel: string) => void,
  ): Promise<number>
  unsubscribe(channel: string): Promise<void>
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

export interface RedisBackplaneOptions extends RedisConnectionOptions {
  /**
   * Use these clients instead of creating them (tests). They must be two
   * separate connections: a subscribed Redis connection can't publish.
   */
  clients?: { publisher: RedisPubSubClient; subscriber: RedisPubSubClient }
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

interface Clients {
  publisher: RedisPubSubClient
  subscriber: RedisPubSubClient
}

/**
 * `IBackplane` on Redis pub/sub with Bun's native `RedisClient`: one
 * connection publishes, one subscribes. Each channel is subscribed once in
 * Redis however many local callbacks it has. Construction never throws: a
 * bad URL makes every operation return `INVALID_OPTIONS`.
 */
export class RedisBackplane implements IBackplane {
  private readonly _clients: Result<Clients, BackplaneError>
  private readonly _channels = new Channels()
  /** In-flight or completed Redis SUBSCRIBEs, by channel. */
  private readonly _subscribed = new Map<
    string,
    Promise<Result<void, BackplaneError>>
  >()
  private _closed = false

  public constructor(options: RedisBackplaneOptions = {}) {
    if (options.clients !== undefined) {
      this._clients = ok(options.clients)
      return
    }
    const url = redisUrl(options)
    try {
      this._clients = ok({
        publisher: new RedisClient(url, options.redis),
        subscriber: new RedisClient(url, options.redis),
      })
    } catch (error) {
      this._clients = err(
        new BackplaneError(
          "INVALID_OPTIONS",
          `cannot create Redis clients: ${reason(error)}`,
        ),
      )
    }
  }

  /** Connects both connections eagerly. */
  public async connect(): Promise<Result<void, Error>> {
    const clients = this._use()
    if (clients.isErr()) return clients
    try {
      await Promise.all([
        clients.value.publisher.connect(),
        clients.value.subscriber.connect(),
      ])
      return ok(undefined)
    } catch (error) {
      return err(
        new BackplaneError(
          "CONNECTION_FAILED",
          `cannot connect to Redis: ${reason(error)}`,
        ),
      )
    }
  }

  public isConnected(): boolean {
    if (this._closed || this._clients.isErr()) return false
    const { publisher, subscriber } = this._clients.value
    return publisher.connected && subscriber.connected
  }

  public async publish<M>(
    channel: string,
    message: M,
  ): Promise<Result<void, Error>> {
    const clients = this._use()
    if (clients.isErr()) return clients
    const json = toJson(message)
    if (json.isErr()) return json
    try {
      await clients.value.publisher.publish(channel, json.value)
      return ok(undefined)
    } catch (error) {
      return err(
        new BackplaneError(
          "OPERATION_FAILED",
          `publish to "${channel}" failed: ${reason(error)}`,
        ),
      )
    }
  }

  public async subscribe<M>(
    channel: string,
    callback: (message: M) => void,
  ): Promise<Result<void, Error>> {
    const clients = this._use()
    if (clients.isErr()) return clients
    // Typed by the caller, unchecked at runtime (see Channels).
    const local = callback as Callback
    this._channels.add(channel, local)
    let pending = this._subscribed.get(channel)
    if (pending === undefined) {
      pending = this._redisSubscribe(clients.value.subscriber, channel)
      this._subscribed.set(channel, pending)
    }
    const result = await pending
    if (result.isErr()) {
      this._channels.removeCallback(channel, local)
      if (this._subscribed.get(channel) === pending) {
        this._subscribed.delete(channel)
      }
    }
    return result
  }

  public async unsubscribe(channel: string): Promise<Result<void, Error>> {
    const clients = this._use()
    if (clients.isErr()) return clients
    this._channels.remove(channel)
    const pending = this._subscribed.get(channel)
    if (pending === undefined) return ok(undefined)
    this._subscribed.delete(channel)
    // Let an in-flight SUBSCRIBE finish first, so the UNSUBSCRIBE wins.
    const subscribed = await pending
    if (subscribed.isErr()) return ok(undefined)
    try {
      await clients.value.subscriber.unsubscribe(channel)
      return ok(undefined)
    } catch (error) {
      return err(
        new BackplaneError(
          "OPERATION_FAILED",
          `unsubscribe from "${channel}" failed: ${reason(error)}`,
        ),
      )
    }
  }

  /** Closes both connections (which ends every subscription). */
  public async close(): Promise<Result<void, Error>> {
    if (this._closed) return ok(undefined)
    this._closed = true
    this._channels.clear()
    this._subscribed.clear()
    if (this._clients.isErr()) return ok(undefined)
    try {
      this._clients.value.publisher.close()
      this._clients.value.subscriber.close()
      return ok(undefined)
    } catch (error) {
      return err(
        new BackplaneError(
          "CONNECTION_FAILED",
          `cannot close the Redis connections: ${reason(error)}`,
        ),
      )
    }
  }

  private _use(): Result<Clients, BackplaneError> {
    if (this._closed) {
      return err(new BackplaneError("CONNECTION_FAILED", "backplane is closed"))
    }
    return this._clients
  }

  private async _redisSubscribe(
    subscriber: RedisPubSubClient,
    channel: string,
  ): Promise<Result<void, BackplaneError>> {
    try {
      await subscriber.subscribe(channel, (message) =>
        this._channels.dispatch(channel, message),
      )
      return ok(undefined)
    } catch (error) {
      return err(
        new BackplaneError(
          "OPERATION_FAILED",
          `subscribe to "${channel}" failed: ${reason(error)}`,
        ),
      )
    }
  }
}
