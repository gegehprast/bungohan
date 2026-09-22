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
// The schema, contract and option building blocks: a module both the
// server and the browser import (state classes, contract) needs no other
// @bungohan package. Same objects as core re-exports.
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
  type TimerId,
} from "@bungohan/types"
export {
  BungohanClient,
  type ClientLogger,
  type ClientOptions,
  createBungohanClient,
  type IBungohanClient,
  type JoinWithMode,
  type TypedJoin,
} from "./client"
export { ClientError, type ClientErrorCode } from "./errors"
export { joinBody } from "./options"
export {
  type IRoom,
  type JoinOptions,
  Room,
  type RoomEvent,
  type RoomStatus,
  type StateAttacher,
} from "./room"
export {
  ABNORMAL_CLOSURE,
  type ClientSocket,
  type ClientSocketHandlers,
  type IClientTransport,
  WebSocketClientTransport,
} from "./transport"
