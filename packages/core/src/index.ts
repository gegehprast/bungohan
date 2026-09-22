// Defined in @bungohan/types (shared with client-js); re-exported here.

// The schema, contract and option building blocks, so a room file needs
// no other @bungohan package. Same objects as the packages they come from
// (and as client-js re-exports).
export {
  createArray,
  createBoolean,
  createFiltered,
  createFixedPoint,
  createFloat32,
  createInt,
  createMap,
  createNumber,
  createSchemaArray,
  createSchemaMap,
  createSchemaSet,
  createSet,
  createString,
  type FilterClient,
  Schema,
  type SchemaConstructor,
  SchemaRegistry,
} from "@bungohan/state"
export { type IStore, MemoryStore, RedisStore } from "@bungohan/store"
export type { ConnectionContext, ITransport } from "@bungohan/transport"
export {
  type Clock,
  type Contract,
  type CreateArg,
  defineContract,
  defineMessage,
  type EmptyContract,
  f,
  type Infer,
  type InferCreateOptions,
  type InferJoinOptions,
  LeaveCode,
  type MessageDef,
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
export { HttpServer, type HttpServerOptions } from "./http"
export { Logger, type LoggerOptions, type LogLevel } from "./logger"
export { IntervalLoop, SimulationLoop } from "./loop"
export { getMatchMaker, MatchMaker } from "./matchmaker"
export type { ClientMetrics, RoomMetrics, ServerMetrics } from "./metrics"
export { MetricsCollector } from "./metrics"
export { Room } from "./room"
export { RoomManager } from "./room-manager"
export { BungohanServer, createBungohanServer } from "./server"
export type {
  ContractOf,
  DefineRoomOptions,
  ErrorContext,
  ErrorSource,
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
