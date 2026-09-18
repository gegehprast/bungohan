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
}

export enum CloseCode {
  NORMAL = 1000,
  GOING_AWAY = 1001,
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
