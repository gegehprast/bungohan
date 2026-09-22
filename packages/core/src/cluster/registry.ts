/**
 * Which other processes are alive (spec §6.4). Liveness is a heartbeat and
 * a deadline, both on the server's `Clock` (`@bungohan/types`) — never
 * wall-clock time — so a test can advance a process to its death.
 *
 * The registry is deliberately *not* an `IStore`: a store has no way to
 * list keys, and store and backplane stay independent (spec §6.4).
 */
import type { Clock, TimerId } from "@bungohan/types"

export interface Peer {
  readonly id: string
  roomCount: number
  clientCount: number
  /** From its last heartbeat. */
  draining: boolean
  /** From its last heartbeat. */
  metadata: Record<string, unknown>
  /** This process's clock reading when its last message arrived. */
  lastSeenAt: number
}

/** What a heartbeat says about its process. */
export interface PeerBeat {
  rooms: number
  clients: number
  draining: boolean
  meta: Record<string, unknown>
}

export interface PeerRegistryOptions {
  readonly clock: Clock
  /** How often this process announces itself. */
  readonly heartbeatInterval: number
  /** How long a peer may be silent before it is dropped. */
  readonly peerTimeout: number
  /** A peer was dropped: it stopped heartbeating, or said goodbye. */
  readonly onLost: (processId: string) => void
  /** A peer was seen for the first time (or after being dropped). */
  readonly onFound?: (processId: string) => void
  /** Publishes this process's own heartbeat. */
  readonly beat: () => void
}

/**
 * Peers this process has heard from. A peer that goes silent for
 * `peerTimeout` is dropped, which is what ends the seats and requests that
 * depended on it (spec §6.4, failure).
 */
export class PeerRegistry {
  private readonly _options: PeerRegistryOptions
  private readonly _peers = new Map<string, Peer>()
  private _timer: TimerId | undefined

  public constructor(options: PeerRegistryOptions) {
    this._options = options
  }

  /** Starts heartbeating and sweeping. */
  public start(): void {
    if (this._timer !== undefined) return
    const { clock, heartbeatInterval } = this._options
    this._timer = clock.setInterval(() => {
      this._options.beat()
      this.sweep()
    }, heartbeatInterval)
  }

  public stop(): void {
    if (this._timer === undefined) return
    this._options.clock.clearInterval(this._timer)
    this._timer = undefined
    this._peers.clear()
  }

  /** Records a peer's heartbeat (or any message: it proves it is alive). */
  public seen(processId: string, beat?: PeerBeat) {
    const now = this._options.clock.now()
    const existing = this._peers.get(processId)
    if (existing === undefined) {
      this._peers.set(processId, {
        id: processId,
        roomCount: beat?.rooms ?? 0,
        clientCount: beat?.clients ?? 0,
        draining: beat?.draining ?? false,
        metadata: beat?.meta ?? {},
        lastSeenAt: now,
      })
      this._options.onFound?.(processId)
      return
    }
    existing.lastSeenAt = now
    if (beat !== undefined) {
      existing.roomCount = beat.rooms
      existing.clientCount = beat.clients
      existing.draining = beat.draining
      existing.metadata = beat.meta
    }
  }

  /** A peer stopped on purpose: drop it now rather than after a timeout. */
  public gone(processId: string): void {
    if (this._peers.delete(processId)) this._options.onLost(processId)
  }

  /** Drops every peer that has been silent for longer than `peerTimeout`. */
  public sweep(): void {
    const deadline = this._options.clock.now() - this._options.peerTimeout
    for (const peer of [...this._peers.values()]) {
      if (peer.lastSeenAt <= deadline) this.gone(peer.id)
    }
  }

  public has(processId: string): boolean {
    return this._peers.has(processId)
  }

  public list(): Peer[] {
    return [...this._peers.values()]
  }

  public size(): number {
    return this._peers.size
  }
}
