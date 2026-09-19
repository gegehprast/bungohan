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
  /** Cluster mode (spec §6.4) is not built yet: `enabled: true` makes `start()` fail. */
  cluster?: {
    enabled?: boolean
    processId?: string
    backplane?: {
      provider?: IBackplane
      config?: { url?: string; host?: string; port?: number; password?: string }
    }
  }
  /** Room messages and envelope bodies. Default `MessagePackSerializer`. */
  serializer?: ISerializer
  /** State sync. Default `MessagePackStateCodec` (Phase 1, spec §8.1.3). */
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
