/**
 * Wire-protocol vocabulary shared by `@bungohan/core` and every client
 * implementation (spec §4). The string enum values are for readability in
 * TypeScript and logs; the wire carries numeric ids (spec §4.2).
 */

export enum ServerMessageType {
  ROOM_MESSAGE = "room_message",
  STATE_SNAPSHOT = "state_snapshot",
  STATE_PATCH = "state_patch",
  JOIN_SUCCESS = "join_success",
  JOIN_ERROR = "join_error",
  CLIENT_JOINED = "client_joined",
  CLIENT_LEFT = "client_left",
  LEAVE = "leave",
  ERROR = "error",
  PONG = "pong",
}

export enum ClientMessageType {
  ROOM_MESSAGE = "room_message",
  JOIN = "join",
  LEAVE = "leave",
  PING = "ping",
}

export enum LeaveCode {
  CONSENTED = 1000,
  DISCONNECTED = 1001,
  KICKED = 4000,
  SERVER_SHUTDOWN = 4001,
  /** The room was disposed while the client was in it (spec §6.7.5). */
  ROOM_DISPOSED = 4002,
}

export enum CloseCode {
  NORMAL = 1000,
  GOING_AWAY = 1001,
  /** Unsupported protocol version (spec §6.7.7). */
  PROTOCOL_ERROR = 1002,
  POLICY_VIOLATION = 1008,
  INTERNAL_ERROR = 1011,
}

export type ConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting"

export interface RoomOptions {
  maxClients: number
  autoDispose: boolean
  allowReconnection: boolean
  reconnectionTimeout: number
  visibility: "public" | "private"
  locked: boolean
  metadata?: Record<string, unknown>
}

export interface ReconnectionOptions {
  enabled: boolean
  maxAttempts: number
  delay: number
  delayMax: number
  factor: number
}

export interface Reservation {
  id: string
  roomId: string
  roomType: string
  sessionId: string
  expiresAt: number
}

/** Readable envelope shape; the wire form is positional (spec §4.2). */
export interface RoomMessageEnvelope {
  __type: ServerMessageType.ROOM_MESSAGE
  __roomId: string
  __messageType: string
  __data: unknown
}

/**
 * The protocol version, negotiated as the WebSocket subprotocol when a
 * connection opens (spec §6.7.7). Bumped only for breaking wire changes.
 */
export const PROTOCOL_VERSION = "bungohan.v1"

// ---------------------------------------------------------------------------
// Wire ids (spec §6.7). These, not the string enums above, cross the wire.
// ---------------------------------------------------------------------------

/**
 * Client → server frame types. A frame is `type:u8`, a fixed number of
 * LEB128 header varints, then the body (spec §6.7.1).
 */
export const ClientFrameType = {
  /** `roomRef, messageId` + packed payload. */
  ROOM_MESSAGE: 0,
  /** `roomRef` + `[type, payload]`. */
  ROOM_MESSAGE_RAW: 1,
  /** `requestId` + `[mode, target, options, contractHash]`. */
  JOIN: 2,
  /** `roomRef`, empty body. */
  LEAVE: 3,
  /** `nonce, rtt`, empty body. */
  PING: 4,
} as const

export type ClientFrameType =
  (typeof ClientFrameType)[keyof typeof ClientFrameType]

/** Server → client frame types (spec §6.7.1). */
export const ServerFrameType = {
  /** `roomRef, messageId` + packed payload. */
  ROOM_MESSAGE: 0,
  /** `roomRef` + `[type, payload]`. */
  ROOM_MESSAGE_RAW: 1,
  /** `roomRef` + state codec bytes (full state). */
  STATE_SNAPSHOT: 2,
  /** `roomRef` + state codec bytes (one sync tick). */
  STATE_PATCH: 3,
  /** `requestId, roomRef` + handshake. */
  JOIN_SUCCESS: 4,
  /** `requestId` + `[code, message]`. */
  JOIN_ERROR: 5,
  /** `roomRef` + sessionId. */
  CLIENT_JOINED: 6,
  /** `roomRef` + sessionId. */
  CLIENT_LEFT: 7,
  /** `roomRef, code` + optional reason. */
  LEAVE: 8,
  /** `roomRef` (0 = connection) + `[code, message]`. */
  ERROR: 9,
  /** `nonce`, empty body. */
  PONG: 10,
} as const

export type ServerFrameType =
  (typeof ServerFrameType)[keyof typeof ServerFrameType]

/** Header varint count per client frame type. */
export const CLIENT_FRAME_HEADERS: Readonly<Record<ClientFrameType, number>> = {
  0: 2,
  1: 1,
  2: 1,
  3: 1,
  4: 2,
}

/** Header varint count per server frame type. */
export const SERVER_FRAME_HEADERS: Readonly<Record<ServerFrameType, number>> = {
  0: 2,
  1: 1,
  2: 1,
  3: 1,
  4: 2,
  5: 1,
  6: 1,
  7: 1,
  8: 2,
  9: 1,
  10: 1,
}

/** `JOIN` modes (spec §6.7.3). */
export const JoinMode = {
  JOIN_OR_CREATE: 0,
  CREATE: 1,
  JOIN: 2,
  JOIN_BY_ID: 3,
  RECONNECT: 4,
  CONSUME_RESERVATION: 5,
} as const

export type JoinMode = (typeof JoinMode)[keyof typeof JoinMode]

/** Body of a `JOIN` frame. */
export type JoinRequest = [
  mode: JoinMode,
  target: string,
  options: unknown,
  contractHash: string | null,
]

/** Body of a `JOIN_SUCCESS` frame (spec §6.7.4). */
export type JoinHandshake = [
  roomId: string,
  roomType: string,
  sessionId: string,
  reconnectionToken: string | null,
  contractHash: string,
  stateCodec: string,
  clientMessages: string[],
  serverMessages: string[],
]

/** Codes a `JOIN_ERROR` frame can carry (spec §6.7.6). */
export type JoinErrorCode =
  | "INVALID_OPTIONS"
  | "SERVER_SHUTTING_DOWN"
  | "ROOM_TYPE_NOT_DEFINED"
  | "CONTRACT_MISMATCH"
  | "ROOM_NOT_FOUND"
  | "ROOM_LOCKED"
  | "ROOM_FULL"
  | "ALREADY_JOINED"
  | "AUTH_FAILED"
  | "JOIN_FAILED"
  | "INVALID_TOKEN"
  | "RESERVATION_NOT_FOUND"
  | "RESERVATION_EXPIRED"
