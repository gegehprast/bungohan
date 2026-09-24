/**
 * Metrics (spec §6.6, §5.7.8). Off by default. When off, the server holds
 * no collector and rooms/clients hold no stats objects, so every recording
 * site is an optional call on `undefined`: nothing is counted, nothing is
 * allocated.
 */
import type { Clock } from "@bungohan/types"

/**
 * Process-wide numbers, from `server.getServerMetrics()`, and the `server`
 * field of `GET /metrics`'s body (`MetricsResponse`; see
 * docs/guides/production.md#metrics). Totals count
 * since `start()`; rates are averages over the whole uptime, not recent
 * windows.
 */
export interface ServerMetrics {
  /** This process's id. */
  processId: string
  /** Seconds since `start()`. */
  uptime: number
  /** Connections open now. */
  activeConnections: number
  /** Connections ever opened. */
  totalConnections: number
  /** Connections ever closed. */
  totalDisconnections: number
  /** Rooms on this process now. */
  activeRooms: number
  /** Rooms created (whose `onCreate` succeeded). */
  totalRoomsCreated: number
  /** Rooms disposed. */
  totalRoomsDisposed: number
  /** Frames received from clients. */
  totalMessages: number
  /** `totalMessages / uptime`. */
  messagesPerSecond: number
  /** Bytes of every frame received from clients. */
  bytesReceived: number
  /** Bytes of every frame sent, counted once per recipient. */
  bytesSent: number
  /** Errors reported to `server.onError`. */
  totalErrors: number
  /** Connections closed with 1013 for passing a limit. */
  totalShed: number
  /** The process's memory, in bytes, as `process.memoryUsage()` reports it. */
  memoryUsage: {
    /** JavaScript heap in use. */
    heapUsed: number
    /** JavaScript heap reserved. */
    heapTotal: number
    /** Memory held outside the heap (buffers). */
    external: number
    /** Resident set size: everything the process holds in RAM. */
    rss: number
  }
  /** When these were read, on the server's clock. */
  timestamp: number
}

/**
 * One room's numbers, from `server.getAllRoomMetrics()`. The byte sizes
 * are what to watch when tuning a state for bandwidth.
 */
export interface RoomMetrics {
  /** The room's id. */
  roomId: string
  /** Its room type. */
  roomType: string
  /** Seats taken now. */
  clientCount: number
  /** Seconds since the room was created. */
  uptime: number
  /** Room messages received from clients. */
  totalMessages: number
  /** `totalMessages / uptime`. */
  messagesPerSecond: number
  /** Sync ticks run. */
  stateSyncCount: number
  /** Simulation steps run (`onTick` calls). */
  simulationTicks: number
  /** Mean `onTick` duration in milliseconds, on the server's clock. */
  averageTickDuration: number
  /** Mean sync duration (diffing and encoding) in milliseconds. */
  averageSyncDuration: number
  /** Mean size of a patch frame's state payload, over the frames sent. */
  avgStateDeltaBytes: number
  /** Mean size of a snapshot frame's state payload. */
  avgStateSnapshotBytes: number
  /**
   * Simulated time discarded because the loop fell too far behind to
   * catch up (see `simulation.maxCatchUpSteps`). Growing means `onTick`
   * is too slow for the tick rate.
   */
  droppedSimulationMs: number
  /**
   * Times a seat's state sync was paused because it stopped reading
   * (see `LimitOptions.backpressure`). Each pause ends in a full re-sync.
   */
  syncPauses: number
  /** When these were read, on the server's clock. */
  timestamp: number
}

/** One seat's numbers, from `server.getAllClientMetrics()`. */
export interface ClientMetrics {
  /** The client's `sessionId`. */
  clientId: string
  /** The room the seat is in. */
  roomId: string
  /** False while the seat is held for reconnection. */
  connected: boolean
  /** Seconds since the seat was taken. */
  uptime: number
  /** Frames sent to this client for its room. */
  totalMessagesSent: number
  /** Room messages received from this client. */
  totalMessagesReceived: number
  /** Bytes of the frames sent to this client for its room. */
  bytesSent: number
  /** Bytes of the room messages received from this client. */
  bytesReceived: number
  /** Mean of the round trips the client reported in `PING` (ms). */
  avgLatency?: number
  /** When its last room message arrived, on the server's clock. */
  lastMessageAt?: number
  /** When these were read, on the server's clock. */
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

/**
 * The server-wide counters behind {@link ServerMetrics}, updated in place
 * as things happen (`server.getMetricsCollector()`). Read
 * `server.getServerMetrics()` for a finished snapshot; the fields here
 * mean the same as the ones there.
 */
export class MetricsCollector {
  /** The server's clock. */
  public readonly clock: Clock
  /** When the server started, on that clock. */
  public startedAt: number
  /** See {@link ServerMetrics.totalConnections}. */
  public totalConnections = 0
  /** See {@link ServerMetrics.totalDisconnections}. */
  public totalDisconnections = 0
  /** See {@link ServerMetrics.totalRoomsCreated}. */
  public totalRoomsCreated = 0
  /** See {@link ServerMetrics.totalRoomsDisposed}. */
  public totalRoomsDisposed = 0
  /** See {@link ServerMetrics.totalMessages}. */
  public totalMessages = 0
  /** See {@link ServerMetrics.bytesReceived}. */
  public bytesReceived = 0
  /** See {@link ServerMetrics.bytesSent}. */
  public bytesSent = 0
  /** See {@link ServerMetrics.totalErrors}. */
  public totalErrors = 0
  /** See {@link ServerMetrics.totalShed}. */
  public totalShed = 0

  public constructor(clock: Clock) {
    this.clock = clock
    this.startedAt = clock.now()
  }

  /** A connection was shed for passing a limit. */
  public countShed(): void {
    this.totalShed++
  }

  /** Seconds elapsed on the clock since `since` (default: the start). */
  public uptimeSeconds(since = this.startedAt): number {
    return (this.clock.now() - since) / 1000
  }
}
