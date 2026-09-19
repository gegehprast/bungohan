import { err, ok, type Result } from "@bungohan/result"
import { BackplaneError, reason } from "./errors"

/**
 * Local callback bookkeeping shared by the backplanes: many callbacks per
 * channel, dispatch that survives a throwing callback or a bad payload.
 *
 * Callbacks receive `unknown` JSON. `IBackplane.subscribe<M>` lets the
 * caller name the type it expects, but nothing checks it at runtime (the
 * same trust model as any JSON channel between your own processes).
 */
export type Callback = (message: unknown) => void

export class Channels {
  private readonly _callbacks = new Map<string, Set<Callback>>()

  public has(channel: string): boolean {
    return this._callbacks.has(channel)
  }

  /** Adds a callback; true if the channel is new. */
  public add(channel: string, callback: Callback): boolean {
    const existing = this._callbacks.get(channel)
    if (existing !== undefined) {
      existing.add(callback)
      return false
    }
    this._callbacks.set(channel, new Set([callback]))
    return true
  }

  public removeCallback(channel: string, callback: Callback): void {
    const callbacks = this._callbacks.get(channel)
    callbacks?.delete(callback)
    if (callbacks?.size === 0) this._callbacks.delete(channel)
  }

  public remove(channel: string): boolean {
    return this._callbacks.delete(channel)
  }

  public channels(): string[] {
    return [...this._callbacks.keys()]
  }

  public clear(): void {
    this._callbacks.clear()
  }

  /** Parses a raw message and hands it to each callback on `channel`. */
  public dispatch(channel: string, raw: string): void {
    const callbacks = this._callbacks.get(channel)
    if (callbacks === undefined) return
    let message: unknown
    try {
      message = JSON.parse(raw)
    } catch (error) {
      console.error(
        `[bungohan/backplane] dropped a non-JSON message on "${channel}"`,
        error,
      )
      return
    }
    for (const callback of [...callbacks]) {
      try {
        callback(message)
      } catch (error) {
        console.error(
          `[bungohan/backplane] callback on "${channel}" threw`,
          error,
        )
      }
    }
  }
}

export function toJson(message: unknown): Result<string, BackplaneError> {
  try {
    const json = JSON.stringify(message)
    if (json !== undefined) return ok(json)
  } catch (error) {
    return err(
      new BackplaneError(
        "SERIALIZATION_FAILED",
        `message is not JSON-serializable: ${reason(error)}`,
      ),
    )
  }
  return err(
    new BackplaneError("SERIALIZATION_FAILED", "cannot publish undefined"),
  )
}
