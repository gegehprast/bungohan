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
// The shared definitions (state schemas, contracts, options), so client
// code needs no other @bungohan package. A module shared with the server
// should import these from @bungohan/schema instead of from here.
export * from "@bungohan/schema"
export { SchemaRegistry } from "@bungohan/state"
export {
  type Clock,
  LeaveCode,
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
