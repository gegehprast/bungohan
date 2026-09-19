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
export { SchemaRegistry } from "@bungohan/state"
export { LeaveCode } from "@bungohan/types"
export {
  BungohanClient,
  type ClientLogger,
  type ClientOptions,
  createBungohanClient,
  type IBungohanClient,
} from "./client"
export { ClientError, type ClientErrorCode } from "./errors"
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
