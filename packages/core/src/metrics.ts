/**
 * Metrics (spec §6.6, §5.7.8). Off by default. When off, the server holds
 * no collector and rooms/clients hold no stats objects, so every recording
 * site is an optional call on `undefined`: nothing is counted, nothing is
 * allocated.
 */
import type { Clock } from "@bungohan/types"

export interface ServerMetrics {
  processId: string
  /** Seconds since `start()`. */
  uptime: number
  activeConnections: number
  totalConnections: number
  totalDisconnections: number
  activeRooms: number
  totalRoomsCreated: number
  totalRoomsDisposed: number
  /** Frames received from clients. */
  totalMessages: number
  messagesPerSecond: number
  bytesReceived: number
  bytesSent: number
  totalErrors: number
  /** Connections closed with 1013 for passing a limit (spec §6.9). */
  totalShed: number
  memoryUsage: {
    heapUsed: number
    heapTotal: number
    external: number
    rss: number
  }
  timestamp: number
}

export interface RoomMetrics {
  roomId: string
  roomType: string
  clientCount: number
  uptime: number
  /** Room messages received from clients. */
  totalMessages: number
  messagesPerSecond: number
  /** Sync ticks run. */
  stateSyncCount: number
  simulationTicks: number
  /** Milliseconds, measured with the server's clock. */
  averageTickDuration: number
  averageSyncDuration: number
  /** Mean size of a patch frame's state payload, over the frames sent. */
  avgStateDeltaBytes: number
  /** Mean size of a snapshot frame's state payload. */
  avgStateSnapshotBytes: number
  /** Simulated time discarded by the catch-up cap (spec §6.8). */
  droppedSimulationMs: number
  timestamp: number
}

export interface ClientMetrics {
  /** The client's `sessionId`. */
  clientId: string
  roomId: string
  connected: boolean
  /** Seconds since the seat was taken. */
  uptime: number
  /** Frames sent to this client for its room. */
  totalMessagesSent: number
  /** Room messages received from this client. */
  totalMessagesReceived: number
  bytesSent: number
  bytesReceived: number
  /** Mean of the round trips the client reported in `PING` (ms). */
  avgLatency?: number
  lastMessageAt?: number
  timestamp: number
}

/** Running mean without storing samples. */
export class Average {
  private _count = 0
  private _total = 0

  public add(value: number): void {
    this._count++
    this._total += value
  }

  public get count(): number {
    return this._count
  }

  public get value(): number {
    return this._count === 0 ? 0 : this._total / this._count
  }
}

/** Per-room counters; only allocated when metrics are on. */
export class RoomStats {
  public readonly createdAt: number
  public messages = 0
  public syncs = 0
  public ticks = 0
  public readonly tickDuration = new Average()
  public readonly syncDuration = new Average()
  public readonly deltaBytes = new Average()
  public readonly snapshotBytes = new Average()
  /** Times a seat's state sync was paused for backpressure (spec §6.9). */
  public syncPauses = 0

  public constructor(now: number) {
    this.createdAt = now
  }
}

/** Per-seat counters; only allocated when metrics are on. */
export class ClientStats {
  public readonly joinedAt: number
  public framesSent = 0
  public bytesSent = 0
  public messagesReceived = 0
  public bytesReceived = 0
  public readonly latency = new Average()
  public lastMessageAt: number | undefined

  public constructor(now: number) {
    this.joinedAt = now
  }
}

/** Server-wide counters. */
export class MetricsCollector {
  public readonly clock: Clock
  public startedAt: number
  public totalConnections = 0
  public totalDisconnections = 0
  public totalRoomsCreated = 0
  public totalRoomsDisposed = 0
  public totalMessages = 0
  public bytesReceived = 0
  public bytesSent = 0
  public totalErrors = 0
  public totalShed = 0

  public constructor(clock: Clock) {
    this.clock = clock
    this.startedAt = clock.now()
  }

  /** A connection was shed for passing a limit (spec §6.9). */
  public countShed(): void {
    this.totalShed++
  }

  public uptimeSeconds(since = this.startedAt): number {
    return (this.clock.now() - since) / 1000
  }
}
