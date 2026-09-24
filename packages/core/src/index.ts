// What apps otherwise need other @bungohan packages for.
export {
  Err,
  err,
  Ok,
  ok,
  type Result,
  tryCatch,
  tryCatchAsync,
} from "@bungohan/result"
// The shared definitions (state schemas, contracts, options), so a room
// file needs no other @bungohan package. A module shared with the browser
// should import these from @bungohan/schema instead of from here.
export * from "@bungohan/schema"
export { SchemaRegistry } from "@bungohan/state"
export { type IStore, MemoryStore, RedisStore } from "@bungohan/store"
export type { ConnectionContext, ITransport } from "@bungohan/transport"
export {
  type Clock,
  LeaveCode,
  type Reservation,
  SystemClock,
  type TimerId,
} from "@bungohan/types"
export {
  Client,
  type ClientStatus,
  Connection,
  type RemoteSeat,
} from "./client"
export {
  type ClusterHandlers,
  ClusterNode,
  type ClusterTimings,
  DEFAULT_CLUSTER_TIMINGS,
} from "./cluster/node"
export type { RoomInfo, RoomOp } from "./cluster/protocol"
export { RoomProxy } from "./cluster/proxy"
export { RemoteConnection } from "./cluster/remote"
export { BungohanError, type ErrorCode } from "./errors"
export {
  type HealthResponse,
  type HttpFallback,
  HttpServer,
  type HttpServerOptions,
  type MetricsResponse,
  type ReadyResponse,
  type RoomMetricsEntry,
  type RoomsResponseEntry,
} from "./http"
export { Logger, type LoggerOptions, type LogLevel } from "./logger"
export { IntervalLoop, SimulationLoop } from "./loop"
export { getMatchMaker, MatchMaker } from "./matchmaker"
export type { ClientMetrics, RoomMetrics, ServerMetrics } from "./metrics"
export { MetricsCollector } from "./metrics"
export { type AuthResult, Room } from "./room"
export { RoomManager } from "./room-manager"
export {
  BungohanServer,
  createBungohanServer,
  MAX_PROCESS_METADATA_BYTES,
} from "./server"
export type {
  ContractOf,
  DefineRoomOptions,
  DrainResult,
  ErrorContext,
  ErrorSource,
  LimitOptions,
  MatchMakerQueryOptions,
  ProcessInfo,
  ProcessSelector,
  RoomClass,
  RoomConstructor,
  RoomFilter,
  RoomListingInfo,
  RoomOnCreateOptions,
  ServerOptions,
  StateOf,
  UserDefinedRoomOnCreateOptions,
  UserDefinedRoomOnJoinOptions,
} from "./types"
