/**
 * Local callback bookkeeping shared by the backplanes: many callbacks per
 * channel, and dispatch that survives a throwing callback.
 *
 * Callbacks receive raw bytes; decoding them is the publisher's and the
 * subscriber's business, not the backplane's (see `IBackplane`).
 */
export type Callback = (data: Uint8Array) => void

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

  /**
   * Hands `data` to each callback on `channel`. Every callback gets its
   * own copy, so one that keeps or mutates the array can't affect the
   * next (`IBackplane`).
   */
  public dispatch(channel: string, data: Uint8Array): void {
    const callbacks = this._callbacks.get(channel)
    if (callbacks === undefined) return
    for (const callback of [...callbacks]) {
      try {
        callback(data.slice())
      } catch (error) {
        console.error(
          `[bungohan/backplane] callback on "${channel}" threw`,
          error,
        )
      }
    }
  }
}
