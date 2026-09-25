/**
 * Request/response over the backplane (spec §6.4). Three shapes, all
 * bounded by the server's `Clock` so nothing can hang:
 *
 * - **single**: one directed request to one peer, one reply, or `timeout`.
 * - **first**: a broadcast where the first answer wins (only a process that
 *   has the thing answers), or `missing` when the window passes.
 * - **gather**: a broadcast where every answer within the window counts.
 *
 * A broadcast can name the peers it waits for (the live ones, as the
 * registry sees them): it then ends as soon as each of them has answered
 * (for **first**, with a `miss` when it has nothing) or died, and the
 * window only bounds the peers that stay silent. With no peer to wait for
 * it ends at once. Without a list it waits out the whole window.
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
  /**
   * A broadcast's peers that have yet to answer; it ends when none are
   * left. Undefined: it waits out its window.
   */
  readonly waiting: Set<string> | undefined
  /** Called with each reply; true once the request is finished. */
  readonly deliver: (value: unknown) => boolean
  /** Every peer waited for has answered or died. */
  readonly complete: () => void
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
      this._open(rid, {
        peer,
        timeoutMs,
        onEnd: resolve,
        complete: noop,
        deliver: (value) => {
          resolve({ ok: true, value: value as T })
          return true
        },
      })
    })
    return { rid, answer }
  }

  /**
   * A broadcast whose first answer wins. Resolves `{ ok: false, reason:
   * "timeout" }` if nobody has it: every peer in `peers` sent a `miss`
   * (see {@link miss}) or died, or the window passed. Callers read that as
   * "no process has it".
   */
  public first<T>(
    windowMs: number,
    peers?: readonly string[],
  ): {
    rid: string
    answer: Promise<Answer<T>>
  } {
    const rid = this._createId()
    const answer = new Promise<Answer<T>>((resolve) => {
      this._open(rid, {
        peers,
        timeoutMs: windowMs,
        onEnd: resolve,
        complete: () => resolve({ ok: false, reason: "timeout" }),
        deliver: (value) => {
          resolve({ ok: true, value: value as T })
          return true
        },
      })
    })
    return { rid, answer }
  }

  /**
   * A broadcast that collects every answer within the window, or until
   * every peer in `peers` has answered or died.
   */
  public gather<T>(
    windowMs: number,
    peers?: readonly string[],
  ): { rid: string; answer: Promise<T[]> } {
    const rid = this._createId()
    const collected: T[] = []
    const answer = new Promise<T[]>((resolve) => {
      this._open(rid, {
        peers,
        timeoutMs: windowMs,
        onEnd: () => resolve(collected),
        complete: () => resolve(collected),
        deliver: (value) => {
          collected.push(value as T)
          return false
        },
      })
    })
    return { rid, answer }
  }

  /**
   * Routes a reply from `from`. Unknown ids (a late or duplicate answer)
   * are ignored.
   */
  public deliver(rid: string, value: unknown, from: string): void {
    const entry = this._entries.get(rid)
    if (entry === undefined) return
    if (entry.deliver(value)) this._close(rid)
    else this._answered(rid, entry, from)
  }

  /** `from` has nothing for a `first` broadcast. */
  public miss(rid: string, from: string): void {
    const entry = this._entries.get(rid)
    if (entry !== undefined) this._answered(rid, entry, from)
  }

  /**
   * `peer` died or said goodbye: requests addressed to it fail, and
   * broadcasts stop waiting for it.
   */
  public failPeer(peer: string): void {
    for (const [rid, entry] of [...this._entries]) {
      if (entry.peer === peer) {
        this._close(rid)
        entry.fail("peer-lost")
      } else {
        this._answered(rid, entry, peer)
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

  /** True while request `rid` is waiting for its answer. */
  public has(rid: string): boolean {
    return this._entries.has(rid)
  }

  /** Broadcasts in flight: each waits out a window on the clock. */
  public windows(): number {
    let open = 0
    for (const entry of this._entries.values()) {
      if (entry.peer === undefined) open++
    }
    return open
  }

  private _open(
    rid: string,
    request: {
      readonly peer?: string
      readonly peers?: readonly string[] | undefined
      readonly timeoutMs: number
      readonly onEnd: (answer: Answer<never>) => void
      readonly complete: () => void
      readonly deliver: (value: unknown) => boolean
    },
  ): void {
    const { peers, onEnd, complete } = request
    // Nobody to wait for: done before anything is sent.
    if (peers !== undefined && peers.length === 0) {
      complete()
      return
    }
    const timer = this._clock.setTimeout(() => {
      this._entries.delete(rid)
      onEnd({ ok: false, reason: "timeout" })
    }, request.timeoutMs)
    this._entries.set(rid, {
      peer: request.peer,
      timer,
      waiting: peers === undefined ? undefined : new Set(peers),
      deliver: request.deliver,
      complete,
      fail: (reason) => onEnd({ ok: false, reason }),
    })
  }

  /** `from` answered a broadcast: it ends once nobody is left to wait for. */
  private _answered(rid: string, entry: Entry, from: string): void {
    const { waiting } = entry
    if (waiting === undefined || !waiting.delete(from)) return
    if (waiting.size > 0) return
    this._close(rid)
    entry.complete()
  }

  private _close(rid: string): void {
    const entry = this._entries.get(rid)
    if (entry === undefined) return
    this._clock.clearTimeout(entry.timer)
    this._entries.delete(rid)
  }
}

function noop(): void {}
