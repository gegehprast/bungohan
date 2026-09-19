import { err, ok, type Result } from "@bungohan/result"
import type { IBackplane } from "./backplane"
import { type Callback, Channels, toJson } from "./channels"
import { BackplaneError } from "./errors"

/**
 * A shared in-process "network" for {@link MemoryBackplane}s. Give several
 * backplanes the same bus to simulate a cluster in one process.
 */
export class MemoryBus {
  private readonly _members = new Set<MemoryBackplane>()

  /** @internal */
  public _join(member: MemoryBackplane): void {
    this._members.add(member)
  }

  /** @internal */
  public _leave(member: MemoryBackplane): void {
    this._members.delete(member)
  }

  /** @internal Delivers to every member, like a Redis PUBLISH. */
  public _publish(channel: string, json: string): void {
    for (const member of this._members) member._deliver(channel, json)
  }
}

/**
 * In-process `IBackplane`: the single-process default and a test double.
 * Messages go through JSON exactly like `RedisBackplane`, and are delivered
 * asynchronously (on a microtask, in publish order), as over a network.
 * Publishing also reaches the publisher's own subscriptions, as in Redis.
 */
export class MemoryBackplane implements IBackplane {
  private readonly _bus: MemoryBus
  private readonly _channels = new Channels()
  private _closed = false

  public constructor(bus = new MemoryBus()) {
    this._bus = bus
    bus._join(this)
  }

  public async publish<M>(
    channel: string,
    message: M,
  ): Promise<Result<void, Error>> {
    if (this._closed) return err(closed())
    const json = toJson(message)
    if (json.isErr()) return json
    this._bus._publish(channel, json.value)
    return ok(undefined)
  }

  public async subscribe<M>(
    channel: string,
    callback: (message: M) => void,
  ): Promise<Result<void, Error>> {
    if (this._closed) return err(closed())
    // Typed by the caller, unchecked at runtime (see Channels).
    this._channels.add(channel, callback as Callback)
    return ok(undefined)
  }

  public async unsubscribe(channel: string): Promise<Result<void, Error>> {
    this._channels.remove(channel)
    return ok(undefined)
  }

  public async close(): Promise<Result<void, Error>> {
    this._closed = true
    this._channels.clear()
    this._bus._leave(this)
    return ok(undefined)
  }

  /** @internal */
  public _deliver(channel: string, json: string): void {
    if (!this._channels.has(channel)) return
    queueMicrotask(() => this._channels.dispatch(channel, json))
  }
}

function closed(): BackplaneError {
  return new BackplaneError("CONNECTION_FAILED", "backplane is closed")
}
