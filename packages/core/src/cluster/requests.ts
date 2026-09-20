/**
 * Request/response over the backplane (spec §6.4). Three shapes, all
 * bounded by the server's `Clock` so nothing can hang:
 *
 * - **single**: one directed request to one peer, one reply, or `timeout`.
 * - **first**: a broadcast where the first answer wins (only a process that
 *   has the thing answers), or `missing` when the window passes.
 * - **gather**: a broadcast where every answer within the window counts.
 *
 * A request waiting on a peer that dies fails at once with `peer-lost`,
 * rather than waiting out its timeout.
 */
import type { Clock, TimerId } from "@bungohan/types"

export type RequestFailure = "timeout" | "peer-lost" | "stopped"

export type Answer<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: RequestFailure }

interface Entry {
  /** The peer this request waits for; undefined for a broadcast. */
  readonly peer: string | undefined
  readonly timer: TimerId
  /** Called with each reply; true once the request is finished. */
  readonly deliver: (value: unknown) => boolean
  readonly fail: (reason: RequestFailure) => void
}

export class PendingRequests {
  private readonly _clock: Clock
  private readonly _entries = new Map<string, Entry>()
  private readonly _createId: () => string

  public constructor(clock: Clock, createId: () => string) {
    this._clock = clock
    this._createId = createId
  }

  /** One directed request, one reply. */
  public single<T>(
    peer: string,
    timeoutMs: number,
  ): { rid: string; answer: Promise<Answer<T>> } {
    const rid = this._createId()
    const answer = new Promise<Answer<T>>((resolve) => {
      this._open(rid, peer, timeoutMs, resolve, (value) => {
        resolve({ ok: true, value: value as T })
        return true
      })
    })
    return { rid, answer }
  }

  /**
   * A broadcast whose first answer wins. Resolves `{ ok: false, reason:
   * "timeout" }` if nobody answers within the window, which callers read as
   * "no process has it".
   */
  public first<T>(windowMs: number): {
    rid: string
    answer: Promise<Answer<T>>
  } {
    const rid = this._createId()
    const answer = new Promise<Answer<T>>((resolve) => {
      this._open(rid, undefined, windowMs, resolve, (value) => {
        resolve({ ok: true, value: value as T })
        return true
      })
    })
    return { rid, answer }
  }

  /** A broadcast that collects every answer within the window. */
  public gather<T>(windowMs: number): { rid: string; answer: Promise<T[]> } {
    const rid = this._createId()
    const collected: T[] = []
    const answer = new Promise<T[]>((resolve) => {
      this._open(
        rid,
        undefined,
        windowMs,
        () => resolve(collected),
        (value) => {
          collected.push(value as T)
          return false
        },
      )
    })
    return { rid, answer }
  }

  /** Routes a reply. Unknown ids (a late or duplicate answer) are ignored. */
  public deliver(rid: string, value: unknown): void {
    const entry = this._entries.get(rid)
    if (entry === undefined) return
    if (entry.deliver(value)) this._close(rid)
  }

  /** Fails every request waiting on `peer` (it died or said goodbye). */
  public failPeer(peer: string): void {
    for (const [rid, entry] of [...this._entries]) {
      if (entry.peer === peer) {
        this._close(rid)
        entry.fail("peer-lost")
      }
    }
  }

  /** Fails everything in flight (the process is stopping). */
  public stop(): void {
    for (const [rid, entry] of [...this._entries]) {
      this._close(rid)
      entry.fail("stopped")
    }
  }

  public size(): number {
    return this._entries.size
  }

  private _open(
    rid: string,
    peer: string | undefined,
    timeoutMs: number,
    onEnd: (answer: Answer<never>) => void,
    deliver: (value: unknown) => boolean,
  ): void {
    const timer = this._clock.setTimeout(() => {
      this._entries.delete(rid)
      onEnd({ ok: false, reason: "timeout" })
    }, timeoutMs)
    this._entries.set(rid, {
      peer,
      timer,
      deliver,
      fail: (reason) => onEnd({ ok: false, reason }),
    })
  }

  private _close(rid: string): void {
    const entry = this._entries.get(rid)
    if (entry === undefined) return
    this._clock.clearTimeout(entry.timer)
    this._entries.delete(rid)
  }
}
