/**
 * Cluster-wide creation locks (spec §6.4.4). Matchmaking that finds no
 * room anywhere creates one, and two processes doing that at once used to
 * create two. Now each pool (a room type, a type plus `where` values, or a
 * type plus a key) has one **coordinator** process, picked from the live
 * members by rendezvous hashing, and a process creates a room for a pool
 * only while it holds that pool's lock there.
 *
 * Every process computes the same coordinator from the same membership.
 * While membership changes (a process just joined, or was just dropped)
 * two processes can briefly disagree, and so both create: the lock narrows
 * the race to those moments, it doesn't claim to close it.
 */
import type { Clock, TimerId } from "@bungohan/types"

/** The coordinator of `pool` among `members` (process ids, any order). */
export function coordinatorOf(
  pool: string,
  members: readonly string[],
): string | undefined {
  let best: string | undefined
  let bestScore = -1
  for (const member of members) {
    const score = fnv1a(`${pool}\u0000${member}`)
    // A tie (vanishingly rare) goes to the smaller id, the same everywhere.
    if (
      score > bestScore ||
      (score === bestScore && best !== undefined && member < best)
    ) {
      best = member
      bestScore = score
    }
  }
  return best
}

/** 32-bit FNV-1a over UTF-16 code units: stable across processes. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash
}

interface Lease {
  readonly process: string
  readonly id: string
  readonly expiry: TimerId
}

interface Waiter {
  readonly process: string
  readonly id: string
  readonly grant: () => void
}

interface Pool {
  holder: Lease | undefined
  readonly queue: Waiter[]
}

/**
 * The locks this process coordinates. One holder per pool, the rest queued
 * in arrival order. A lease that outlives `leaseMs` is taken back, so a
 * holder that hangs can't block its pool forever; a holder or waiter whose
 * process is dropped is removed at once.
 */
export class LockTable {
  private readonly _clock: Clock
  private readonly _leaseMs: number
  private readonly _pools = new Map<string, Pool>()

  public constructor(clock: Clock, leaseMs: number) {
    this._clock = clock
    this._leaseMs = leaseMs
  }

  /** Resolves once `process`'s request `id` holds the pool's lock. */
  public acquire(pool: string, process: string, id: string): Promise<void> {
    return new Promise((grant) => {
      let entry = this._pools.get(pool)
      if (entry === undefined) {
        entry = { holder: undefined, queue: [] }
        this._pools.set(pool, entry)
      }
      entry.queue.push({ process, id, grant })
      this._next(pool, entry)
    })
  }

  /** Ends lease `id` (a no-op if it isn't the holder any more). */
  public release(pool: string, id: string): void {
    const entry = this._pools.get(pool)
    if (entry === undefined) return
    if (entry.holder?.id === id) {
      this._clock.clearTimeout(entry.holder.expiry)
      entry.holder = undefined
      this._next(pool, entry)
      return
    }
    // Given up before it was granted.
    const index = entry.queue.findIndex((waiter) => waiter.id === id)
    if (index >= 0) entry.queue.splice(index, 1)
    this._forgetIfIdle(pool, entry)
  }

  /** A process is gone: its leases end and its waiters leave the queue. */
  public processLost(process: string): void {
    for (const [pool, entry] of [...this._pools]) {
      for (let i = entry.queue.length - 1; i >= 0; i--) {
        if (entry.queue[i]?.process === process) entry.queue.splice(i, 1)
      }
      if (entry.holder?.process === process) {
        this.release(pool, entry.holder.id)
      } else {
        this._forgetIfIdle(pool, entry)
      }
    }
  }

  /** Ends everything (this process is stopping); nobody is granted. */
  public stop(): void {
    for (const entry of this._pools.values()) {
      if (entry.holder !== undefined) {
        this._clock.clearTimeout(entry.holder.expiry)
      }
    }
    this._pools.clear()
  }

  /** Locks held or awaited, for tests. */
  public size(): number {
    return this._pools.size
  }

  private _next(pool: string, entry: Pool): void {
    if (entry.holder !== undefined) return
    const waiter = entry.queue.shift()
    if (waiter === undefined) {
      this._forgetIfIdle(pool, entry)
      return
    }
    const expiry = this._clock.setTimeout(
      () => this.release(pool, waiter.id),
      this._leaseMs,
    )
    entry.holder = { process: waiter.process, id: waiter.id, expiry }
    waiter.grant()
  }

  private _forgetIfIdle(pool: string, entry: Pool): void {
    if (entry.holder === undefined && entry.queue.length === 0) {
      this._pools.delete(pool)
    }
  }
}
