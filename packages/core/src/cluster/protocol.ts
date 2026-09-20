/**
 * The cluster backplane protocol (spec §6.4): what one process publishes to
 * another.
 *
 * This is **not** the wire protocol. Clustering is invisible to clients:
 * PROTOCOL.md is unchanged, and nothing defined here ever reaches a socket.
 * What crosses the backplane is either a control message or a *finished*
 * client frame, produced by the process that owns the room and relayed
 * byte for byte by the process that holds the connection.
 *
 * `IBackplane` carries JSON, so frame bytes travel base64-encoded.
 */
import type { ConnectionContext } from "@bungohan/transport"
import type { JoinMode, Reservation } from "@bungohan/types"
import type { ErrorCode } from "../errors"
import type { ProcessInfo, RoomListingInfo } from "../types"

/**
 * Bumped when this format changes in a way older processes can't read. A
 * message with a different version is dropped (and logged once per peer),
 * so a rolling deploy degrades to "those processes don't see each other"
 * rather than to corruption.
 */
export const CLUSTER_PROTOCOL = 1

/** Where every process listens for broadcasts. */
export function allChannel(namespace: string): string {
  return `${namespace}:cluster:all`
}

/** Where one process listens for messages addressed to it. */
export function processChannel(namespace: string, processId: string): string {
  return `${namespace}:cluster:p:${processId}`
}

// ---------------------------------------------------------------------------
// Frame bytes over a JSON channel
// ---------------------------------------------------------------------------

export function encodeBytes(bytes: Uint8Array): string {
  return bytes.toBase64()
}

export function decodeBytes(text: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.fromBase64(text)
}

// ---------------------------------------------------------------------------
// Connection context
// ---------------------------------------------------------------------------

/**
 * A `ConnectionContext` as JSON, so the owning process can run `onAuth`
 * with the same ip, query, headers and token the edge process saw. Only
 * these fields travel; a custom transport's extra properties stay on the
 * process that created them.
 */
export interface WireContext {
  ip: string
  searchParams: [string, string][]
  headers: [string, string][]
  token?: string
  protocol?: string
}

export function packContext(context: ConnectionContext): WireContext {
  const packed: WireContext = {
    ip: context.ip,
    searchParams: [...context.searchParams],
    headers: [...context.headers],
  }
  if (typeof context.token === "string") packed.token = context.token
  if (typeof context.protocol === "string") packed.protocol = context.protocol
  return packed
}

export function unpackContext(wire: WireContext): ConnectionContext {
  const context: ConnectionContext = {
    ip: wire.ip,
    searchParams: new URLSearchParams(wire.searchParams),
    headers: new Headers(wire.headers),
  }
  if (wire.token !== undefined) context.token = wire.token
  if (wire.protocol !== undefined) context.protocol = wire.protocol
  return context
}

// ---------------------------------------------------------------------------
// Rooms as another process sees them
// ---------------------------------------------------------------------------

/** A remote room's public surface, behind a {@link RoomProxy}. */
export interface RoomInfo {
  id: string
  roomType: string
  processId: string
  maxClients: number
  autoDispose: boolean
  allowReconnection: boolean
  reconnectionTimeout: number
  visibility: "public" | "private"
  locked: boolean
  metadata: Record<string, unknown>
  clientCount: number
  seatCount: number
  disposed: boolean
}

/** A room operation a `RoomProxy` forwards to the owning process. */
export type RoomOp =
  | { op: "info" }
  | { op: "lock"; locked: boolean }
  | { op: "visibility"; visibility: "public" | "private" }
  | { op: "dispose" }
  | { op: "presenceSet"; clientId: string; data: unknown }
  | { op: "presenceRemove"; clientId: string }
  | { op: "presenceAll" }
  | { op: "broadcast"; type: string; message: unknown; except?: string }
  | { op: "broadcastRaw"; type: string; message: unknown; except?: string }
  | { op: "kick"; sessionId: string; code: number; reason?: string }

/** What a resolved join tells the owning process to do (spec §6.4). */
export type JoinTarget =
  | { kind: "room"; roomId: string; mode: JoinMode }
  | { kind: "reconnect"; token: string }
  | { kind: "reservation"; reservationId: string }

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

interface Envelope {
  /** {@link CLUSTER_PROTOCOL}. */
  v: number
  /** The publishing process. */
  from: string
}

/** Liveness (§6.4): published on a timer and on request. */
export interface Heartbeat extends Envelope {
  t: "hb"
  rooms: number
  clients: number
}

/** "I just started; announce yourselves." Answered with a `Heartbeat`. */
export interface Hello extends Envelope {
  t: "hello"
}

/** A graceful stop: peers drop this process without waiting for a timeout. */
export interface Bye extends Envelope {
  t: "bye"
}

export interface ProcessInfoRequest extends Envelope {
  t: "pi?"
  rid: string
}

export interface ProcessInfoReply extends Envelope {
  t: "pi!"
  rid: string
  info: ProcessInfo
}

/** "Who owns this room id / holds this reservation id?" (first reply wins) */
export interface LocateRequest extends Envelope {
  t: "loc?"
  rid: string
  kind: "room" | "reservation"
  key: string
}

/** Only a process that has it answers. */
export interface LocateReply extends Envelope {
  t: "loc!"
  rid: string
}

/** "Does anyone have an available room of this type?" (first reply wins) */
export interface FindRequest extends Envelope {
  t: "find?"
  rid: string
  roomType: string
  /**
   * Rooms the asking connection already holds a seat in. A local
   * `joinOrCreate` skips those, so a cluster-wide one must too, or a
   * client joining the same type twice would hear `ALREADY_JOINED`
   * instead of getting a second room.
   */
  exclude: string[]
}

export interface FindReply extends Envelope {
  t: "find!"
  rid: string
  roomId: string
}

export interface QueryRequest extends Envelope {
  t: "q?"
  rid: string
  roomType: string
  metadata?: Record<string, unknown>
  includePrivate: boolean
}

export interface QueryReply extends Envelope {
  t: "q!"
  rid: string
  rooms: RoomListingInfo[]
}

export interface CreateRoomRequest extends Envelope {
  t: "create?"
  rid: string
  roomType: string
  options: unknown
}

export interface CreateRoomReply extends Envelope {
  t: "create!"
  rid: string
  info?: RoomInfo
  code?: ErrorCode
  message?: string
}

export interface ReserveRequest extends Envelope {
  t: "reserve?"
  rid: string
  roomId: string
  options: unknown
}

export interface ReserveReply extends Envelope {
  t: "reserve!"
  rid: string
  reservation?: Reservation
  code?: ErrorCode
  message?: string
}

export interface RoomOpRequest extends Envelope {
  t: "op?"
  rid: string
  roomId: string
  call: RoomOp
}

export interface RoomOpReply extends Envelope {
  t: "op!"
  rid: string
  value?: unknown
  code?: ErrorCode
  message?: string
}

/**
 * A `JOIN` the edge process resolved to a room on the owning process. It
 * carries the **edge's** `roomRef` (the handle that goes on the wire, §3.1
 * of PROTOCOL.md) and connection id, so every frame the owner produces for
 * this seat is already addressed correctly and is relayed unchanged.
 */
export interface JoinForwardRequest extends Envelope {
  t: "join?"
  rid: string
  connectionId: string
  /** Allocated by the edge on its own connection; never reused there. */
  roomRef: number
  /** Echoed in `JOIN_SUCCESS`/`JOIN_ERROR`. */
  requestId: number
  target: JoinTarget
  options: unknown
  hash: string | null
  context: WireContext
}

export interface JoinForwardReply extends Envelope {
  t: "join!"
  rid: string
  roomId?: string
  sessionId?: string
  code?: ErrorCode
  message?: string
}

/** A room message the edge received for a seat the owner holds. */
export interface SeatMessage extends Envelope {
  t: "msg"
  roomId: string
  sessionId: string
  connectionId: string
  /** True for `ROOM_MESSAGE_RAW`. */
  raw: boolean
  messageId: number
  body: string
}

/** The client asked to leave a remote room (`LEAVE` frame). */
export interface SeatLeave extends Envelope {
  t: "leave"
  roomId: string
  sessionId: string
}

/** An edge connection closed; the owner holds or releases its seats. */
export interface ConnectionClosed extends Envelope {
  t: "conn"
  connectionId: string
}

/** Finished frames the edge relays verbatim to one or more connections. */
export interface FrameRelay extends Envelope {
  t: "frames"
  to: string[]
  body: string
}

/** The owner refused a frame: the edge closes the connection (§8.2). */
export interface ViolationRelay extends Envelope {
  t: "violation"
  connectionId: string
  why: string
}

export type ClusterMessage =
  | Heartbeat
  | Hello
  | Bye
  | ProcessInfoRequest
  | ProcessInfoReply
  | LocateRequest
  | LocateReply
  | FindRequest
  | FindReply
  | QueryRequest
  | QueryReply
  | CreateRoomRequest
  | CreateRoomReply
  | ReserveRequest
  | ReserveReply
  | RoomOpRequest
  | RoomOpReply
  | JoinForwardRequest
  | JoinForwardReply
  | SeatMessage
  | SeatLeave
  | ConnectionClosed
  | FrameRelay
  | ViolationRelay

/**
 * A received JSON value as a cluster message, or undefined if it isn't one
 * (a foreign publisher on the channel, or a different protocol version).
 */
export function asClusterMessage(value: unknown): ClusterMessage | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const message = value as Partial<ClusterMessage>
  if (
    typeof message.t !== "string" ||
    typeof message.from !== "string" ||
    message.v !== CLUSTER_PROTOCOL
  ) {
    return undefined
  }
  return message as ClusterMessage
}

/**
 * A message without the envelope fields {@link ClusterNode} fills in.
 * Distributive, so each member keeps its own shape.
 */
export type ClusterPayload = ClusterMessage extends infer M
  ? M extends ClusterMessage
    ? Omit<M, "v" | "from">
    : never
  : never
