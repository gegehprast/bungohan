import type { IBackplane } from "@bungohan/backplane"
import type { ISerializer, IStateCodec } from "@bungohan/serializer"
import type { Schema } from "@bungohan/state"
import type { IStore } from "@bungohan/store"
import type { ITransport } from "@bungohan/transport"
import type {
  Clock,
  Contract,
  EmptyContract,
  HasTypedOptions,
  InferCreateOptions,
  InferJoinOptions,
} from "@bungohan/types"
import type { Client, Connection } from "./client"
import type { LoggerOptions } from "./logger"
import type { Room } from "./room"

// #region server-options
/** `createBungohanServer`'s options. Every field is optional. */
export interface ServerOptions {
  /** Port only ever lives at `transport.config.port`. */
  transport?: {
    provider?: ITransport
    config?: {
      /** Default 6060. `0` picks a free port; `server.getPort()` says which. */
      port?: number
      maxPayloadLength?: number
      idleTimeout?: number
      compression?: boolean
      /** Smallest frame worth deflating, in bytes. Default 128. */
      compressionThreshold?: number
    }
  }
  /**
   * Where rooms' `saveState`/`loadState` go. `provider` takes any
   * `IStore`; `config` builds a Redis store (closed on `stop()`). Without
   * either, both calls are no-ops.
   */
  store?: {
    provider?: IStore
    config?: { url?: string; host?: string; port?: number; password?: string }
  }
  /**
   * Cluster mode. With `enabled`, rooms may live on any
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
     * A small description of this process that every `ProcessSelector`
     * sees as `ProcessInfo.metadata`, e.g. `{ region: "eu-west" }`. Change
     * it later with `server.setProcessMetadata()`. It travels in every
     * heartbeat, so it is capped at 1,024 bytes once encoded; a larger or
     * unencodable value **throws** here, at startup. Default `{}`; it
     * applies without cluster mode too.
     */
    metadata?: Record<string, unknown>
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
   * The rooms' codec: state sync and contract messages.
   * Default `SchemaCodec`; `MessagePackStateCodec` is inspectable, for
   * debugging.
   */
  stateCodec?: IStateCodec
  /** Off by default; when off, metrics cost nothing. */
  metrics?: { enabled?: boolean }
  /**
   * A small HTTP server on its own port: `GET /health` (liveness),
   * `GET /ready` (readiness: 503 while draining or stopping),
   * `GET /metrics` and `GET /rooms` (public rooms), each switchable. Off
   * unless `enabled`.
   */
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
    /** Serve `GET /ready`. Default true. */
    enableReadiness?: boolean
    /** Default true. */
    enableRoomsList?: boolean
  }
  /** Default 60 steps per second. */
  simulation?: { tickRate?: number; maxCatchUpSteps?: number }
  /** Default 20 Hz. */
  sync?: { tickRate?: number }
  /**
   * What SIGTERM/SIGINT do: optionally `drain()`, then `stop()`, then
   * `onShutdown`, then exit the process.
   */
  gracefulShutdown?: {
    /**
     * Milliseconds before a stuck `stop()` exits with code 1. Counted from
     * the end of the drain, if there is one. Default 30,000.
     */
    timeout?: number
    /**
     * Drain before stopping: on a signal, `server.drain()` for up to this
     * many milliseconds, so games in progress can finish, then `stop()`.
     * A second signal stops at once. Default 0: stop right away.
     */
    drainTimeout?: number
    /** Runs after `stop()`, before the process exits. */
    onShutdown?: () => Promise<void>
    /** Install SIGTERM/SIGINT handlers in `start()`. Default true. */
    handleSignals?: boolean
  }
  /** Log level and destination. Default: `"info"` to the console. */
  logger?: LoggerOptions
  /** Time source for every loop and timeout. Default `SystemClock`. */
  clock?: Clock
  /**
   * Per-connection limits. On by default, with headroom a
   * normal game never reaches. `false` turns every limit off.
   */
  limits?: LimitOptions | false
}
// #endregion server-options

// #region limit-options
/**
 * Per-connection limits. Every number is a maximum, and `0`
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
// #endregion limit-options

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

// #region define-room-options
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
  /**
   * Each new room's starting `metadata`, merged with the `metadata` of
   * its create options.
   */
  metadata?: Record<string, unknown>
  /** Seconds a reservation holds its seat. Default 60. */
  reservationTimeout?: number
}
// #endregion define-room-options

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

/**
 * What `onCreate` receives, merged with the create options. A type alias,
 * not an interface: it must stay assignable to an object with an index
 * signature, so a room typed with create options still extends `Room`.
 */
export type RoomOnCreateOptions = {
  /** The new room's id (also `this.id`). */
  roomId: string
  /** The name the room type was registered under. */
  roomType: string
  /** The room type's `maxClients` (also `this.maxClients`). */
  maxClients: number
  /** The room type's `autoDispose` (also `this.autoDispose`). */
  autoDispose: boolean
  /** The room type's `allowReconnection` (also `this.allowReconnection`). */
  allowReconnection: boolean
  /** The room type's `reconnectionTimeout`, in seconds. */
  reconnectionTimeout: number
  /** The room's starting visibility (also `this.visibility`). */
  visibility: "public" | "private"
  /** Whether the room starts locked (also `this.locked`). */
  locked: boolean
  /**
   * The room type's metadata merged with the creator's `metadata` option;
   * already assigned to `this.metadata`.
   */
  metadata: Record<string, unknown>
}

/** Create options of a room whose contract declares none (untyped). */
export type UserDefinedRoomOnCreateOptions = Record<string, unknown>
/** Join options of a room whose contract declares none (untyped). */
export type UserDefinedRoomOnJoinOptions = Record<string, unknown>

/** Room classes have no constructor arguments; core wires them up after `new`. */
export type RoomConstructor<R extends Room = Room> = new () => R

/** The contract a room class is typed with (`Room<S, C>` → `C`). */
export type ContractOf<R> = R extends { readonly __contract?: infer C }
  ? C extends Contract
    ? C
    : EmptyContract
  : EmptyContract

/** The state class a room is typed with (`Room<S, C>` → `S`). */
export type StateOf<R> = R extends { readonly __state?: infer S }
  ? S extends Schema
    ? S
    : Schema
  : Schema

/**
 * A room class as `defineRoomType` accepts it: a class typed with a
 * contract must also carry it at runtime as `static contract`, and it must
 * be that same contract. Forgetting it is a compile error at the
 * registration site.
 */
export type RoomClass<R extends Room = Room> = RoomConstructor<R> &
  ([EmptyContract] extends [ContractOf<R>]
    ? {
        /** The class's `static contract`, if it has one. */
        readonly contract?: Contract | undefined
      }
    : {
        /** The class's `static contract`: the one it is typed with. */
        readonly contract: ContractOf<R>
      })

/**
 * The arguments after the room class of `matchMaker.createRoom` and
 * `joinOrCreate`: the class's create options, required when its contract
 * declares typed options, then a process selector.
 */
export type CreateRoomArgs<R> =
  HasTypedOptions<ContractOf<R>> extends true
    ? [
        options: InferCreateOptions<ContractOf<R>>,
        processSelector?: ProcessSelector,
      ]
    : [options?: unknown, processSelector?: ProcessSelector]

/**
 * The arguments after the room class of `matchMaker.reserve`: the seat's
 * join options, a process selector and, for typed options, the create
 * options used if the reservation has to create the room.
 */
export type ReserveArgs<R> =
  HasTypedOptions<ContractOf<R>> extends true
    ? [
        options: InferJoinOptions<ContractOf<R>>,
        processSelector?: ProcessSelector,
        createOptions?: InferCreateOptions<ContractOf<R>>,
      ]
    : [options?: unknown, processSelector?: ProcessSelector]

/**
 * One room as `matchMaker.query()` lists it: a plain snapshot, the same
 * whichever process runs the room, taken when the query ran.
 */
export interface RoomListingInfo {
  /** The room's id, for `joinById`. */
  id: string
  /** Its room type. */
  type: string
  /** Seats taken (joining, joined and held). */
  clients: number
  /** Its `maxClients`. */
  maxClients: number
  /** Private rooms are only listed with `includePrivate`. */
  visibility: "public" | "private"
  /** A locked room refuses new joins. */
  locked: boolean
  /** The room's `metadata`. */
  metadata: Record<string, unknown>
  /** The process the room runs on (this one, outside cluster mode). */
  processId: string
  /**
   * True when that process is draining (`server.drain()`): the room still
   * runs and `joinById` still reaches it, but it wants no new players.
   * Only listed with `includeDraining`, so this is false otherwise.
   */
  draining: boolean
}

/**
 * One server process, as `matchMaker.getAllProcesses()` reports it and a
 * {@link ProcessSelector} chooses among them.
 */
export interface ProcessInfo {
  /** The process id (`ServerOptions.cluster.processId`). */
  id: string
  /** Rooms it runs. */
  roomCount: number
  /** Seats taken across its rooms. */
  clientCount: number
  /**
   * What the process says about itself: `ServerOptions.cluster.metadata`,
   * or the last `server.setProcessMetadata()`. `{}` when unset. Untyped:
   * check a field before relying on it (see
   * docs/guides/scaling.md#placing-rooms-by-region).
   */
  metadata: Record<string, unknown>
  /**
   * True while the process drains (`server.drain()`): it takes no new
   * rooms, so a selector is never offered it, but its rooms still run.
   */
  draining: boolean
}

/**
 * Picks the process a room is created on:
 * `(processes) => processes.reduce((a, b) => a.roomCount <= b.roomCount ?
 * a : b)` balances by room count. It must return one of `processes`,
 * which never includes a draining process; when every process is
 * draining it isn't called, and the call fails with
 * `SERVER_SHUTTING_DOWN`. Without cluster mode the only choice is this
 * process, and choosing another fails with `CLUSTER_NOT_IMPLEMENTED`.
 */
export type ProcessSelector = (processes: ProcessInfo[]) => ProcessInfo

/** How a `server.drain()` ended. */
export interface DrainResult {
  /**
   * `"drained"`: this process holds no rooms. `"timeout"`: the drain's
   * `timeout` passed first. `"cancelled"`: `cancelDrain()` was called
   * first. In the last two cases the rooms are still running.
   */
  outcome: "drained" | "timeout" | "cancelled"
  /** Rooms this process still held when the promise resolved. */
  rooms: number
}

/** A custom `matchMaker.query()` condition: keeps rooms it returns true for. */
export type RoomFilter = (room: RoomListingInfo) => boolean

/** What `matchMaker.query()` looks for. */
export interface MatchMakerQueryOptions {
  /** The room type to list. */
  type: string
  /**
   * Keep only rooms whose `metadata` has each of these keys with an equal
   * (`===`) value.
   */
  metadata?: Record<string, unknown>
  /** Keep only rooms every filter accepts (run on this process). */
  filters?: RoomFilter[]
  /** At most this many rooms. */
  limit?: number
  /** Include private rooms. Default false. */
  includePrivate?: boolean
  /**
   * Include rooms on draining processes (`server.drain()`). Default
   * false: a lobby that lists rooms and sends players to them by id would
   * otherwise keep feeding a process that is trying to empty, so its
   * drain ends only at its timeout. Pass true for tools that need every
   * room (an admin view, a room-code lookup for an invite); the listings
   * say which rooms are draining.
   */
  includeDraining?: boolean
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
  /** What was running: a hook, a handler, or a part of the server. */
  source: ErrorSource
  /** The room involved, if any. */
  room?: Room
  /** The client (seat) involved, if any. */
  client?: Client
  /** The connection involved, if any (e.g. a protocol violation). */
  connection?: Connection
  /** The message type, for `onMessage` and `send` errors. */
  messageType?: string
}
