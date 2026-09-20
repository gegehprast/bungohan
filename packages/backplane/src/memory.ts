import { err, ok, type Result } from "@bungohan/result"
import type { IBackplane } from "./backplane"
import { type Callback, Channels } from "./channels"
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
  public _publish(channel: string, data: Uint8Array): void {
    for (const member of this._members) member._deliver(channel, data)
  }
}

/**
 * In-process `IBackplane`: a test double, and how several processes share
 * a "network" in one `bun test` process. Bytes are **copied at publish
 * time**, like a socket write, so a publisher that reuses its buffer
 * afterwards can't corrupt what subscribers see, and delivery is
 * asynchronous (on a microtask, in publish order), as over a network.
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

  public async publish(
    channel: string,
    data: Uint8Array,
  ): Promise<Result<void, Error>> {
    if (this._closed) return err(closed())
    this._bus._publish(channel, data.slice())
    return ok(undefined)
  }

  public async subscribe(
    channel: string,
    callback: (data: Uint8Array) => void,
  ): Promise<Result<void, Error>> {
    if (this._closed) return err(closed())
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
  public _deliver(channel: string, data: Uint8Array): void {
    if (!this._channels.has(channel)) return
    queueMicrotask(() => this._channels.dispatch(channel, data))
  }
}

function closed(): BackplaneError {
  return new BackplaneError("CONNECTION_FAILED", "backplane is closed")
}
