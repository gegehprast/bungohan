import type { IBackplane } from "@bungohan/backplane"
import type { ISerializer, IStateCodec } from "@bungohan/serializer"
import type { IStore } from "@bungohan/store"
import type { ITransport } from "@bungohan/transport"
import type { Clock, Contract, EmptyContract } from "@bungohan/types"
import type { Client, Connection } from "./client"
import type { LoggerOptions } from "./logger"
import type { Room } from "./room"

export interface ServerOptions {
  /** Port only ever lives at `transport.config.port` (spec §6.1 [FIX]). */
  transport?: {
    provider?: ITransport
    config?: {
      /** Default 6060. */
      port?: number
      maxPayloadLength?: number
      idleTimeout?: number
      compression?: boolean
      /** Smallest frame worth deflating, in bytes. Default 128 (spec §5.7.7). */
      compressionThreshold?: number
    }
  }
  store?: {
    provider?: IStore
    config?: { url?: string; host?: string; port?: number; password?: string }
  }
  /**
   * Cluster mode (spec §6.4). With `enabled`, rooms may live on any
   * process: matchmaking looks across the cluster, and a client connected
   * here can sit in a room that runs elsewhere. It needs a backplane.
   *
   * Every timing is measured on {@link ServerOptions.clock}, never on
   * wall-clock time, so tests drive them with a manual clock.
   */
  cluster?: {
    enabled?: boolean
    /** This process's id in the cluster. Default: a random nanoid. */
    processId?: string
    /**
     * Channel prefix, so unrelated clusters (or test runs) can share one
     * Redis. Default `"bungohan"`.
     */
    namespace?: string
    /** How often this process announces itself. Default 2,000 ms. */
    heartbeatInterval?: number
    /**
     * How long a process may be silent before peers drop it and end what
     * depended on it. Default 6,000 ms (three heartbeats).
     */
    peerTimeout?: number
    /** How long a directed request waits for its reply. Default 5,000 ms. */
    requestTimeout?: number
    /**
     * How long a broadcast (process info, room lookup, query) collects
     * answers. Default 200 ms.
     */
    gatherTimeout?: number
    backplane?: {
      provider?: IBackplane
      config?: { url?: string; host?: string; port?: number; password?: string }
    }
  }
  /** Room messages and envelope bodies. Default `MessagePackSerializer`. */
  serializer?: ISerializer
  /**
   * The rooms' codec: state sync and contract messages (PROTOCOL.md §13).
   * Default `SchemaCodec`; `MessagePackStateCodec` is inspectable, for
   * debugging.
   */
  stateCodec?: IStateCodec
  /** Off by default; when off, metrics cost nothing (spec §6.6). */
  metrics?: { enabled?: boolean }
  http?: {
    enabled?: boolean
    /** Default 8080. */
    port?: number
    /** Default `"0.0.0.0"`. */
    hostname?: string
    /** Default true. */
    cors?: boolean
    /** Default true. */
    enableMetrics?: boolean
    /** Default true. */
    enableHealthCheck?: boolean
    /** Default true. */
    enableRoomsList?: boolean
  }
  /** Default 60 steps per second. */
  simulation?: { tickRate?: number; maxCatchUpSteps?: number }
  /** Default 20 Hz. */
  sync?: { tickRate?: number }
  gracefulShutdown?: {
    /** Milliseconds before a stuck shutdown exits with code 1. Default 30,000. */
    timeout?: number
    onShutdown?: () => Promise<void>
    /** Install SIGTERM/SIGINT handlers in `start()`. Default true. */
    handleSignals?: boolean
  }
  logger?: LoggerOptions
  /** Time source for every loop and timeout. Default `SystemClock`. */
  clock?: Clock
  /**
   * Per-connection limits (spec §6.9). On by default, with headroom a
   * normal game never reaches. `false` turns every limit off.
   */
  limits?: LimitOptions | false
}

/**
 * Per-connection limits (spec §6.9). Every number is a maximum, and `0`
 * means "no limit" for that one.
 */
export interface LimitOptions {
  /**
   * Outgoing bytes a connection may have queued. A client that stops
   * reading (a backgrounded tab, a stalled link) would otherwise grow the
   * server's memory without bound, because state patches can't simply be
   * dropped: they are deltas, so a skipped one desyncs that client for
   * good.
   */
  backpressure?: {
    /**
     * Above this, the client stops being sent state patches and gets a
     * fresh snapshot once it drains. Default 262,144 (256 KiB).
     */
    pauseBytes?: number
    /** Resume at or below this. Default 65,536 (64 KiB). */
    resumeBytes?: number
    /** Close (1013) above this, however briefly. Default 4,194,304 (4 MiB). */
    disconnectBytes?: number
    /** Close (1013) after this long paused. Default 15,000 ms. */
    maxPausedMs?: number
  }
  /** Incoming frames, counted per connection. */
  messages?: {
    /** Sustained frames per second. Default 200. */
    perSecond?: number
    /** Frames a burst may add on top of the sustained rate. Default 400. */
    burst?: number
    /** Sustained bytes per second. Default 1,048,576 (1 MiB). */
    bytesPerSecond?: number
  }
  /** `JOIN` frames, which are also what create rooms. */
  joins?: {
    /** Attempts per connection per minute. Default 60. */
    perMinute?: number
  }
}

/** {@link LimitOptions} with every default filled in; `0` means no limit. */
export interface ResolvedLimits {
  readonly pauseBytes: number
  readonly resumeBytes: number
  readonly disconnectBytes: number
  readonly maxPausedMs: number
  readonly messagesPerSecond: number
  readonly messageBurst: number
  readonly bytesPerSecond: number
  readonly joinsPerMinute: number
}

const NO_LIMITS: ResolvedLimits = {
  pauseBytes: 0,
  resumeBytes: 0,
  disconnectBytes: 0,
  maxPausedMs: 0,
  messagesPerSecond: 0,
  messageBurst: 0,
  bytesPerSecond: 0,
  joinsPerMinute: 0,
}

/** Fills in {@link LimitOptions}; `false` disables every limit. */
export function resolveLimits(
  options: LimitOptions | false | undefined,
): ResolvedLimits {
  if (options === false) return NO_LIMITS
  const backpressure = options?.backpressure
  const messages = options?.messages
  return {
    pauseBytes: backpressure?.pauseBytes ?? 256 * 1024,
    resumeBytes: backpressure?.resumeBytes ?? 64 * 1024,
    disconnectBytes: backpressure?.disconnectBytes ?? 4 * 1024 * 1024,
    maxPausedMs: backpressure?.maxPausedMs ?? 15_000,
    messagesPerSecond: messages?.perSecond ?? 200,
    messageBurst: messages?.burst ?? 400,
    bytesPerSecond: messages?.bytesPerSecond ?? 1024 * 1024,
    joinsPerMinute: options?.joins?.perMinute ?? 60,
  }
}

/** Per room type (`defineRoomType`); every field is optional. */
export interface DefineRoomOptions {
  /** Default unlimited. */
  maxClients?: number
  /** Dispose when the last seat is released. Default true. */
  autoDispose?: boolean
  /** Hold a disconnected client's seat for reconnection. Default true. */
  allowReconnection?: boolean
  /** Seconds a held seat waits. Default 30. */
  reconnectionTimeout?: number
  /** Default `"public"`. */
  visibility?: "public" | "private"
  /** Default false. */
  locked?: boolean
  metadata?: Record<string, unknown>
  /** Seconds a reservation holds its seat. Default 60. */
  reservationTimeout?: number
}

export interface ResolvedRoomOptions {
  maxClients: number
  autoDispose: boolean
  allowReconnection: boolean
  reconnectionTimeout: number
  visibility: "public" | "private"
  locked: boolean
  metadata: Record<string, unknown>
  reservationTimeout: number
}

/** What `onCreate` receives, merged with the user's options. */
export interface RoomOnCreateOptions {
  roomId: string
  roomType: string
  maxClients: number
  autoDispose: boolean
  allowReconnection: boolean
  reconnectionTimeout: number
  visibility: "public" | "private"
  locked: boolean
  metadata: Record<string, unknown>
}

export type UserDefinedRoomOnCreateOptions = Record<string, unknown>
export type UserDefinedRoomOnJoinOptions = Record<string, unknown>

/** Room classes have no constructor arguments; core wires them up after `new`. */
export type RoomConstructor<R extends Room = Room> = new () => R

/** The contract a room class is typed with (`Room<S, C>` → `C`). */
export type ContractOf<R> = R extends { readonly __contract?: infer C }
  ? C extends Contract
    ? C
    : EmptyContract
  : EmptyContract

/**
 * A room class as `defineRoomType` accepts it: a class typed with a
 * contract must also carry it at runtime as `static contract`, and it must
 * be that same contract. Forgetting it is a compile error at the
 * registration site.
 */
export type RoomClass<R extends Room = Room> = RoomConstructor<R> &
  ([EmptyContract] extends [ContractOf<R>]
    ? { readonly contract?: Contract | undefined }
    : { readonly contract: ContractOf<R> })

export interface RoomListingInfo {
  id: string
  type: string
  clients: number
  maxClients: number
  visibility: "public" | "private"
  locked: boolean
  metadata: Record<string, unknown>
  processId: string
}

export interface ProcessInfo {
  id: string
  roomCount: number
  clientCount: number
  metadata?: Record<string, unknown>
}

export type ProcessSelector = (processes: ProcessInfo[]) => ProcessInfo

export type RoomFilter = (room: RoomListingInfo) => boolean

export interface MatchMakerQueryOptions {
  type: string
  metadata?: Record<string, unknown>
  filters?: RoomFilter[]
  limit?: number
  /** Include private rooms. Default false. */
  includePrivate?: boolean
}

/** Where an error reported to `server.onError` came from. */
export type ErrorSource =
  | "onAuth"
  | "onCreate"
  | "onJoin"
  | "onLeave"
  | "onTick"
  | "onBeforeSync"
  | "onDispose"
  | "onDisconnect"
  | "onReconnect"
  | "onPause"
  | "onResume"
  | "onMessage"
  | "send"
  | "sync"
  | "saveState"
  | "loadState"
  | "transport"
  | "protocol"
  | "callback"

/** Second argument of `server.onError` callbacks. */
export interface ErrorContext {
  source: ErrorSource
  room?: Room
  client?: Client
  connection?: Connection
  /** The message type, for `onMessage` and `send` errors. */
  messageType?: string
}
