/**
 * The reference client (spec §7.1): implements the §6.7 wire protocol,
 * including the §6.7.7 forward-compatibility rules. Browser-safe: no
 * Bun/Node APIs, and never imports `@bungohan/core`.
 */
import { err, ok, type Result } from "@bungohan/result"
import {
  decodeFrame,
  encodeFrame,
  type ISerializer,
  type IStateCodec,
  MessagePackSerializer,
  MessagePackStateCodec,
  SchemaCodec,
} from "@bungohan/serializer"
import type { Schema } from "@bungohan/state"
import {
  ClientFrameType,
  type Clock,
  CloseCode,
  type ConnectionState,
  type Contract,
  type CreateArg,
  contractHash,
  type EmptyContract,
  type InferJoinOptions,
  type JoinHandshake,
  JoinMode,
  LeaveCode,
  PROTOCOL_VERSION,
  type ReconnectionOptions,
  type Reservation,
  SERVER_FRAME_HEADERS,
  ServerFrameType,
  SystemClock,
  type TimerId,
  type TypedOptionsContract,
  type UntypedOptionsContract,
} from "@bungohan/types"
import { ClientError, joinErrorCode } from "./errors"
import { joinBody } from "./options"
import {
  type IRoom,
  type JoinOptions,
  Room,
  type RoomHost,
  type RoomLink,
} from "./room"
import {
  type ClientSocket,
  type IClientTransport,
  WebSocketClientTransport,
} from "./transport"

export interface ClientLogger {
  warn(message: string, detail?: unknown): void
  error(message: string, detail?: unknown): void
}

export interface ClientOptions {
  /** Server URL, e.g. `wss://game.example.com`. */
  url: string
  /** Sent as `?token=` (the server's `ConnectionContext.token`). */
  token?: string
  /**
   * Open the connection as soon as the client is created. Either way, a
   * join on a disconnected client connects first. Default `true`.
   */
  autoConnect?: boolean
  /** Default `{ enabled: true, maxAttempts: 10, delay: 1000, delayMax: 30000, factor: 2 }`. */
  reconnection?: Partial<ReconnectionOptions>
  /** Room messages. Must match the server's. Default MessagePack. */
  serializer?: ISerializer
  /**
   * State codecs this client can decode. The handshake names the room's;
   * one missing here fails the join with `CODEC_MISMATCH` (spec §6.7.4).
   * Default: MessagePack (Phase 1).
   */
  stateCodecs?: IStateCodec[]
  /** How connections are opened. Default: the platform `WebSocket`. */
  transport?: IClientTransport
  /** Timers for PING and reconnection. Default `SystemClock`. */
  clock?: Clock
  /** Milliseconds between PINGs (round-trip measurement); 0 disables. Default 5000. */
  pingInterval?: number
  /** A join the server hasn't answered by then fails with `TIMEOUT`; 0 disables. Default 10000. */
  joinTimeout?: number
  /** Where dropped frames and listener errors are reported. Default `console`. */
  logger?: ClientLogger
}

/**
 * The join inputs for a contract with typed options: the contract is
 * required, since it is what the options are encoded against.
 */
export type TypedJoin<S extends Schema, C extends Contract> = JoinOptions<
  S,
  C
> & { readonly contract: C }

/** How {@link IBungohanClient.joinWith} joins. */
export type JoinWithMode = "create" | "join" | "joinById" | "joinOrCreate"

const JOIN_WITH: Readonly<Record<JoinWithMode, number>> = {
  create: JoinMode.CREATE,
  join: JoinMode.JOIN,
  joinById: JoinMode.JOIN_BY_ID,
  joinOrCreate: JoinMode.JOIN_OR_CREATE,
}

/** The client's public surface (spec §7.1). */
export interface IBungohanClient {
  connect(): Promise<Result<void, ClientError>>
  disconnect(): Promise<void>
  /**
   * Creates a room. For a contract with typed options (spec §4.1.2),
   * `options` are its join options, or `{ create, join }` when it declares
   * create options, and `join.contract` is required; they are checked at
   * compile time and encoded against the declarations. Otherwise
   * `options` are anything MessagePack carries.
   */
  create<S extends Schema, C extends TypedOptionsContract>(
    roomType: string,
    options: NoInfer<CreateArg<C>>,
    join: TypedJoin<S, C>,
  ): Promise<Result<IRoom<S, C>, ClientError>>
  create<
    S extends Schema = Schema,
    C extends UntypedOptionsContract = EmptyContract,
  >(
    roomType: string,
    options?: unknown,
    join?: JoinOptions<S, C>,
  ): Promise<Result<IRoom<S, C>, ClientError>>
  /** Joins an available room; `options` are join options (see `create`). */
  join<S extends Schema, C extends TypedOptionsContract>(
    roomType: string,
    options: NoInfer<InferJoinOptions<C>>,
    join: TypedJoin<S, C>,
  ): Promise<Result<IRoom<S, C>, ClientError>>
  join<
    S extends Schema = Schema,
    C extends UntypedOptionsContract = EmptyContract,
  >(
    roomType: string,
    options?: unknown,
    join?: JoinOptions<S, C>,
  ): Promise<Result<IRoom<S, C>, ClientError>>
  /** Joins a room by id; `options` are join options (see `create`). */
  joinById<S extends Schema, C extends TypedOptionsContract>(
    roomId: string,
    options: NoInfer<InferJoinOptions<C>>,
    join: TypedJoin<S, C>,
  ): Promise<Result<IRoom<S, C>, ClientError>>
  joinById<
    S extends Schema = Schema,
    C extends UntypedOptionsContract = EmptyContract,
  >(
    roomId: string,
    options?: unknown,
    join?: JoinOptions<S, C>,
  ): Promise<Result<IRoom<S, C>, ClientError>>
  /** Joins an available room or creates one; `options` as for `create`. */
  joinOrCreate<S extends Schema, C extends TypedOptionsContract>(
    roomType: string,
    options: NoInfer<CreateArg<C>>,
    join: TypedJoin<S, C>,
  ): Promise<Result<IRoom<S, C>, ClientError>>
  joinOrCreate<
    S extends Schema = Schema,
    C extends UntypedOptionsContract = EmptyContract,
  >(
    roomType: string,
    options?: unknown,
    join?: JoinOptions<S, C>,
  ): Promise<Result<IRoom<S, C>, ClientError>>
  /**
   * The four joins above, by mode, for code that is generic over the
   * contract (React's `useRoom`). Typed options are still encoded against
   * the contract's declarations, so options that don't fit fail with
   * `ENCODE_FAILED`, but only at run time: prefer the typed methods.
   */
  joinWith<S extends Schema = Schema, C extends Contract = EmptyContract>(
    mode: JoinWithMode,
    target: string,
    options: unknown,
    join?: JoinOptions<S, C>,
  ): Promise<Result<IRoom<S, C>, ClientError>>
  reconnect<S extends Schema = Schema, C extends Contract = EmptyContract>(
    roomId: string,
    reconnectToken: string,
    join?: JoinOptions<S, C>,
  ): Promise<Result<IRoom<S, C>, ClientError>>
  consumeReservation<
    S extends Schema = Schema,
    C extends Contract = EmptyContract,
  >(
    reservation: Reservation,
    join?: JoinOptions<S, C>,
  ): Promise<Result<IRoom<S, C>, ClientError>>
  getRooms(): Map<string, IRoom<Schema, Contract>>
  getRoom(id: string): IRoom<Schema, Contract> | undefined
  leaveAll(): Promise<void>
  readonly connectionState: ConnectionState
  /** Last measured PING round trip in ms, or undefined before the first. */
  readonly latency: number | undefined
  onError(cb: (error: ClientError) => void): () => void
  onDisconnect(cb: () => void): () => void
  onReconnect(cb: () => void): () => void
}

const DEFAULT_RECONNECTION: ReconnectionOptions = {
  enabled: true,
  maxAttempts: 10,
  delay: 1000,
  delayMax: 30000,
  factor: 2,
}

/** Largest header varint (spec §6.7.1). */
const MAX_VARINT = 0xffffffff

/** Client-initiated close used to force a re-sync (spec §5.7.9). */
const RESYNC_CLOSE = 4000

interface PendingJoin {
  readonly room: RoomLink
  /** Set for resumes (reconnection) and `reconnect()`: expected room id. */
  readonly roomId: string | undefined
  readonly resume: boolean
  timer: TimerId | undefined
  resolve(result: Result<RoomLink, ClientError>): void
}

interface Connection {
  readonly socket: ClientSocket
  open: boolean
}

const hashes = new WeakMap<Contract, string>()

/** The contract's hash, computed once per contract object. */
function hashOf(contract: Contract | undefined): string | null {
  if (contract === undefined) return null
  let hash = hashes.get(contract)
  if (hash === undefined) {
    hash = contractHash(contract)
    hashes.set(contract, hash)
  }
  return hash
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string")
}

/**
 * The handshake's known leading elements (spec §6.7.4); elements after
 * them are ignored (§6.7.7 rule 1). Undefined if malformed.
 */
function parseHandshake(value: unknown): JoinHandshake | undefined {
  if (!Array.isArray(value) || value.length < 8) return undefined
  const [roomId, roomType, sessionId, token, hash, codec, client, server] =
    value
  if (
    typeof roomId !== "string" ||
    typeof roomType !== "string" ||
    typeof sessionId !== "string" ||
    (token !== null && typeof token !== "string") ||
    typeof hash !== "string" ||
    typeof codec !== "string" ||
    !isStringArray(client) ||
    !isStringArray(server)
  ) {
    return undefined
  }
  return [roomId, roomType, sessionId, token, hash, codec, client, server]
}

/** Appends `?token=` to the URL, keeping any query it already has. */
function withToken(url: string, token: string | undefined): string {
  if (token === undefined) return url
  const [base, hash] = splitOnce(url, "#")
  const separator = base.includes("?") ? "&" : "?"
  const withQuery = `${base}${separator}token=${encodeURIComponent(token)}`
  return hash === undefined ? withQuery : `${withQuery}#${hash}`
}

function splitOnce(value: string, at: string): [string, string | undefined] {
  const index = value.indexOf(at)
  return index < 0
    ? [value, undefined]
    : [value.slice(0, index), value.slice(index + 1)]
}

export class BungohanClient implements IBungohanClient {
  private readonly _url: string
  private readonly _reconnection: ReconnectionOptions
  private readonly _serializer: ISerializer
  private readonly _codecs: ReadonlyMap<string, IStateCodec>
  private readonly _transport: IClientTransport
  private readonly _clock: Clock
  private readonly _pingInterval: number
  private readonly _joinTimeout: number
  private readonly _logger: ClientLogger
  private readonly _host: RoomHost

  private _state: ConnectionState = "disconnected"
  private _connection: Connection | undefined
  /** Resolvers waiting for the current connect attempt. */
  private _connecting: ((result: Result<void, ClientError>) => void)[] = []
  private _attempt = 0
  private _retryTimer: TimerId | undefined
  private _pingTimer: TimerId | undefined
  private _ping: { nonce: number; sentAt: number } | undefined
  private _nextNonce = 1
  private _latency: number | undefined
  private _nextRequest = 1

  /** Joined (or joining) rooms, by current roomRef. */
  private readonly _byRef = new Map<number, RoomLink>()
  /** Rooms waiting for the connection to come back (reconnection). */
  private readonly _resuming = new Set<RoomLink>()
  private readonly _pending = new Map<number, PendingJoin>()

  private readonly _onError = new Set<(error: ClientError) => void>()
  private readonly _onDisconnect = new Set<() => void>()
  private readonly _onReconnect = new Set<() => void>()

  public constructor(options: ClientOptions) {
    this._url = withToken(options.url, options.token)
    this._reconnection = { ...DEFAULT_RECONNECTION, ...options.reconnection }
    this._serializer = options.serializer ?? new MessagePackSerializer()
    const codecs = options.stateCodecs ?? [
      new SchemaCodec(),
      new MessagePackStateCodec(),
    ]
    this._codecs = new Map(codecs.map((codec) => [codec.getName(), codec]))
    this._transport = options.transport ?? new WebSocketClientTransport()
    this._clock = options.clock ?? new SystemClock()
    this._pingInterval = options.pingInterval ?? 5000
    this._joinTimeout = options.joinTimeout ?? 10_000
    this._logger = options.logger ?? {
      warn: (message, detail) =>
        console.warn(`[bungohan/client] ${message}`, detail ?? ""),
      error: (message, detail) =>
        console.error(`[bungohan/client] ${message}`, detail ?? ""),
    }
    this._host = {
      serializer: this._serializer,
      sendFrame: (type, header, body) => this._sendFrame(type, header, body),
      forget: (room) => this._forget(room),
      desync: (room, error) => this._desync(room, error),
      defer: (fn) => {
        this._clock.setTimeout(fn, 0)
      },
      warn: (message, detail) => this._logger.warn(message, detail),
      error: (message, detail) => this._logger.error(message, detail),
    }
    if (options.autoConnect !== false) void this.connect()
  }

  public get connectionState(): ConnectionState {
    return this._state
  }

  public get latency(): number | undefined {
    return this._latency
  }

  // --- connection ----------------------------------------------------------

  /**
   * Opens the connection (resolves once it is open). Already connected is
   * `ok`; a connection in progress is waited for. While reconnecting, it
   * waits for the reconnection's next attempt to open.
   */
  public connect(): Promise<Result<void, ClientError>> {
    if (this._state === "connected") return Promise.resolve(ok(undefined))
    const done = new Promise<Result<void, ClientError>>((resolve) => {
      this._connecting.push(resolve)
    })
    if (this._state === "disconnected") {
      this._state = "connecting"
      this._open()
    }
    return done
  }

  /**
   * Leaves every room (consented) and closes the connection. No
   * reconnection follows.
   */
  public async disconnect(): Promise<void> {
    await this.leaveAll()
    this._stopRetry()
    const connection = this._connection
    this._connection = undefined
    const wasOpen = connection?.open === true
    this._setDisconnected(
      new ClientError("CONNECTION_LOST", "client disconnected"),
    )
    connection?.socket.close(CloseCode.NORMAL, "client disconnect")
    if (wasOpen) this._emit(this._onDisconnect)
  }

  public async leaveAll(): Promise<void> {
    const rooms = new Set<RoomLink>([
      ...this._byRef.values(),
      ...this._resuming,
    ])
    for (const pending of this._pending.values()) rooms.add(pending.room)
    for (const room of rooms) await room.leave()
  }

  // --- joins ---------------------------------------------------------------

  public create<S extends Schema, C extends TypedOptionsContract>(
    roomType: string,
    options: NoInfer<CreateArg<C>>,
    join: TypedJoin<S, C>,
  ): Promise<Result<IRoom<S, C>, ClientError>>
  public create<
    S extends Schema = Schema,
    C extends UntypedOptionsContract = EmptyContract,
  >(
    roomType: string,
    options?: unknown,
    join?: JoinOptions<S, C>,
  ): Promise<Result<IRoom<S, C>, ClientError>>
  public create(
    roomType: string,
    options?: unknown,
    join?: JoinOptions<Schema, Contract>,
  ): Promise<Result<IRoom<Schema, Contract>, ClientError>> {
    return this._join(JoinMode.CREATE, roomType, options, join)
  }

  public join<S extends Schema, C extends TypedOptionsContract>(
    roomType: string,
    options: NoInfer<InferJoinOptions<C>>,
    join: TypedJoin<S, C>,
  ): Promise<Result<IRoom<S, C>, ClientError>>
  public join<
    S extends Schema = Schema,
    C extends UntypedOptionsContract = EmptyContract,
  >(
    roomType: string,
    options?: unknown,
    join?: JoinOptions<S, C>,
  ): Promise<Result<IRoom<S, C>, ClientError>>
  public join(
    roomType: string,
    options?: unknown,
    join?: JoinOptions<Schema, Contract>,
  ): Promise<Result<IRoom<Schema, Contract>, ClientError>> {
    return this._join(JoinMode.JOIN, roomType, options, join)
  }

  public joinById<S extends Schema, C extends TypedOptionsContract>(
    roomId: string,
    options: NoInfer<InferJoinOptions<C>>,
    join: TypedJoin<S, C>,
  ): Promise<Result<IRoom<S, C>, ClientError>>
  public joinById<
    S extends Schema = Schema,
    C extends UntypedOptionsContract = EmptyContract,
  >(
    roomId: string,
    options?: unknown,
    join?: JoinOptions<S, C>,
  ): Promise<Result<IRoom<S, C>, ClientError>>
  public joinById(
    roomId: string,
    options?: unknown,
    join?: JoinOptions<Schema, Contract>,
  ): Promise<Result<IRoom<Schema, Contract>, ClientError>> {
    return this._join(JoinMode.JOIN_BY_ID, roomId, options, join)
  }

  public joinOrCreate<S extends Schema, C extends TypedOptionsContract>(
    roomType: string,
    options: NoInfer<CreateArg<C>>,
    join: TypedJoin<S, C>,
  ): Promise<Result<IRoom<S, C>, ClientError>>
  public joinOrCreate<
    S extends Schema = Schema,
    C extends UntypedOptionsContract = EmptyContract,
  >(
    roomType: string,
    options?: unknown,
    join?: JoinOptions<S, C>,
  ): Promise<Result<IRoom<S, C>, ClientError>>
  public joinOrCreate(
    roomType: string,
    options?: unknown,
    join?: JoinOptions<Schema, Contract>,
  ): Promise<Result<IRoom<Schema, Contract>, ClientError>> {
    return this._join(JoinMode.JOIN_OR_CREATE, roomType, options, join)
  }

  public joinWith<
    S extends Schema = Schema,
    C extends Contract = EmptyContract,
  >(
    mode: JoinWithMode,
    target: string,
    options: unknown,
    join?: JoinOptions<S, C>,
  ): Promise<Result<IRoom<S, C>, ClientError>> {
    return this._join(JOIN_WITH[mode], target, options, join)
  }

  /**
   * Resumes a held seat with a token kept from an earlier connection (e.g.
   * across a page reload). Automatic reconnection needs no call.
   */
  public reconnect<
    S extends Schema = Schema,
    C extends Contract = EmptyContract,
  >(
    roomId: string,
    reconnectToken: string,
    join?: JoinOptions<S, C>,
  ): Promise<Result<IRoom<S, C>, ClientError>> {
    return this._join(JoinMode.RECONNECT, reconnectToken, null, join, roomId)
  }

  public consumeReservation<
    S extends Schema = Schema,
    C extends Contract = EmptyContract,
  >(
    reservation: Reservation,
    join?: JoinOptions<S, C>,
  ): Promise<Result<IRoom<S, C>, ClientError>> {
    return this._join(JoinMode.CONSUME_RESERVATION, reservation.id, null, join)
  }

  public getRooms(): Map<string, IRoom<Schema, Contract>> {
    const rooms = new Map<string, IRoom<Schema, Contract>>()
    for (const room of [...this._byRef.values(), ...this._resuming]) {
      if (room.snapshots > 0) rooms.set(room.id, room)
    }
    return rooms
  }

  public getRoom(id: string): IRoom<Schema, Contract> | undefined {
    return this.getRooms().get(id)
  }

  // --- events --------------------------------------------------------------

  /** Connection-level errors: server `ERROR` frames, failed reconnection. */
  public onError(cb: (error: ClientError) => void): () => void {
    return add(this._onError, cb)
  }

  /** An open connection closed (whether or not reconnection follows). */
  public onDisconnect(cb: () => void): () => void {
    return add(this._onDisconnect, cb)
  }

  /** A reconnection opened a new connection (rooms then resume). */
  public onReconnect(cb: () => void): () => void {
    return add(this._onReconnect, cb)
  }

  // --- internals: joining --------------------------------------------------

  private async _join<S extends Schema, C extends Contract>(
    mode: number,
    target: string,
    options: unknown,
    join: JoinOptions<S, C> = {},
    roomId?: string,
  ): Promise<Result<IRoom<S, C>, ClientError>> {
    const hash = hashOf(join.contract)
    // Typed options are encoded before anything is sent, so options that
    // got past the types fail here, locally.
    const body = joinBody(mode, target, options, hash, join.contract)
    if (body.isErr()) return body
    const connected = await this.connect()
    if (connected.isErr()) return connected
    const room = new Room<S, C>(this._host, join, hash)
    const result = await this._request(room, body.value, roomId, false)
    return result.isErr() ? result : ok(room)
  }

  private _request(
    room: RoomLink,
    elements: unknown[],
    roomId: string | undefined,
    resume: boolean,
  ): Promise<Result<RoomLink, ClientError>> {
    const requestId = this._nextRequest
    this._nextRequest = requestId >= MAX_VARINT ? 1 : requestId + 1
    return new Promise((resolve) => {
      const pending: PendingJoin = {
        room,
        roomId,
        resume,
        timer: undefined,
        resolve,
      }
      this._pending.set(requestId, pending)
      if (this._joinTimeout > 0) {
        pending.timer = this._clock.setTimeout(() => {
          pending.timer = undefined
          this._settle(
            requestId,
            err(new ClientError("TIMEOUT", "the server did not answer")),
          )
        }, this._joinTimeout)
      }
      const body = this._serializer.encode(elements)
      const sent = body.isErr()
        ? err(new ClientError("ENCODE_FAILED", body.error.message))
        : this._sendFrame(ClientFrameType.JOIN, [requestId], body.value)
      if (sent.isErr()) this._settle(requestId, sent)
    })
  }

  /**
   * Resolves a pending join. A failure after `JOIN_SUCCESS` (timeout, …)
   * leaves the seat the server already gave it.
   */
  private _settle(
    requestId: number,
    result: Result<RoomLink, ClientError>,
  ): void {
    const pending = this._pending.get(requestId)
    if (pending === undefined) return
    this._pending.delete(requestId)
    if (pending.timer !== undefined) this._clock.clearTimeout(pending.timer)
    if (result.isErr()) {
      const { room } = pending
      if (this._byRef.get(room._ref) === room && room.status !== "left") {
        this._sendFrame(ClientFrameType.LEAVE, [room._ref])
        this._byRef.delete(room._ref)
      }
      if (pending.resume) {
        // A seat that couldn't be resumed is gone.
        room._fail(result.error.code, result.error.message)
        room._left(LeaveCode.DISCONNECTED)
      }
    }
    pending.resolve(result)
  }

  private _joinSuccess(requestId: number, ref: number, body: Uint8Array) {
    const pending = this._pending.get(requestId)
    if (pending === undefined) {
      this._logger.warn(`dropped JOIN_SUCCESS for unknown request ${requestId}`)
      // The server seated us; don't keep a seat nobody uses.
      this._sendFrame(ClientFrameType.LEAVE, [ref])
      return
    }
    const decoded = this._serializer.decode(body)
    const handshake = decoded.isOk() ? parseHandshake(decoded.value) : undefined
    const { room } = pending
    if (handshake === undefined) {
      this._sendFrame(ClientFrameType.LEAVE, [ref])
      this._settle(
        requestId,
        err(new ClientError("INVALID_MESSAGE", "malformed JOIN_SUCCESS")),
      )
      return
    }
    const [roomId, , , , , codecName] = handshake
    const codec = this._codecs.get(codecName)
    if (codec === undefined) {
      // No fallback to another codec (spec §6.7.4): leave, fail locally.
      this._sendFrame(ClientFrameType.LEAVE, [ref])
      this._settle(
        requestId,
        err(
          new ClientError(
            "CODEC_MISMATCH",
            `the room uses state codec "${codecName}", which this client ` +
              `can't decode (it has: ${[...this._codecs.keys()].join(", ")})`,
          ),
        ),
      )
      return
    }
    if (pending.roomId !== undefined && pending.roomId !== roomId) {
      this._sendFrame(ClientFrameType.LEAVE, [ref])
      this._settle(
        requestId,
        err(
          new ClientError(
            "INVALID_TOKEN",
            `the token belongs to room ${roomId}, not ${pending.roomId}`,
          ),
        ),
      )
      return
    }
    room._bind(ref, handshake, codec)
    this._byRef.set(ref, room)
    // The join completes with the first STATE_SNAPSHOT (spec §6.7.2).
  }

  // --- internals: frames ---------------------------------------------------

  private _sendFrame(
    type: number,
    header: readonly number[],
    body?: Uint8Array,
  ): Result<void, ClientError> {
    const connection = this._connection
    if (connection === undefined || !connection.open) {
      return err(new ClientError("NOT_CONNECTED", "not connected"))
    }
    const frame = encodeFrame(type, header, body)
    if (frame.isErr()) {
      return err(new ClientError("ENCODE_FAILED", frame.error.message))
    }
    if (!connection.socket.send(frame.value)) {
      return err(new ClientError("NOT_CONNECTED", "the connection is closed"))
    }
    return ok(undefined)
  }

  private _receive(connection: Connection, data: Uint8Array): void {
    if (connection !== this._connection) return
    const type = data[0]
    // Unknown frame types are dropped, not fatal: a newer server may send
    // frames this client predates. A frame is one whole transport message,
    // so skipping it needs no knowledge of its layout (spec §6.7.7).
    if (type === undefined || !Object.hasOwn(SERVER_FRAME_HEADERS, type)) {
      this._logger.warn(`dropped frame: unknown frame type ${type}`)
      return
    }
    const frame = decodeFrame(data, SERVER_FRAME_HEADERS)
    if (frame.isErr()) {
      this._logger.warn(`dropped frame ${type}: ${frame.error.message}`)
      return
    }
    const { header, body } = frame.value
    const first = header[0] ?? 0
    switch (type) {
      case ServerFrameType.JOIN_SUCCESS:
        this._joinSuccess(first, header[1] ?? 0, body)
        return
      case ServerFrameType.JOIN_ERROR: {
        const [code, message] = this._errorBody(body)
        this._settle(
          first,
          err(new ClientError(joinErrorCode(code), message, { code })),
        )
        return
      }
      case ServerFrameType.PONG:
        this._pong(first)
        return
      case ServerFrameType.ERROR:
        if (first === 0) {
          const [code, message] = this._errorBody(body)
          this._emit(
            this._onError,
            new ClientError("SERVER_ERROR", `${code}: ${message}`, { code }),
          )
          return
        }
        break
    }
    const room = this._byRef.get(first)
    if (room === undefined) {
      // E.g. the LEAVE(1000) that acknowledges our own LEAVE.
      return
    }
    room._receive(type, header, body)
    if (type === ServerFrameType.STATE_SNAPSHOT) this._joined(room)
  }

  /** `[code, message]`, reading only the known elements (§6.7.7). */
  private _errorBody(body: Uint8Array): [string, string] {
    const decoded = this._serializer.decode(body)
    const value = decoded.isOk() ? decoded.value : undefined
    if (!Array.isArray(value) || value.length < 2) {
      return ["INVALID_MESSAGE", "malformed error body"]
    }
    return [String(value[0]), String(value[1])]
  }

  /** A room's snapshot arrived: complete its pending join, if any. */
  private _joined(room: RoomLink): void {
    if (room.status === "left") return
    for (const [requestId, pending] of this._pending) {
      if (pending.room === room) {
        this._settle(requestId, ok(room))
        return
      }
    }
  }

  private _forget(room: RoomLink): void {
    if (this._byRef.get(room._ref) === room) this._byRef.delete(room._ref)
    this._resuming.delete(room)
    for (const [requestId, pending] of this._pending) {
      if (pending.room === room && !pending.resume) {
        this._settle(
          requestId,
          err(new ClientError("LEFT", "left before the join completed")),
        )
      }
    }
  }

  /**
   * The replica no longer matches the server's (spec §5.7.9). Protocol v1
   * has no "send me a snapshot" frame, so re-sync through reconnection:
   * drop the connection, resume every seat with its token, and each room
   * gets a fresh snapshot.
   */
  private _desync(room: RoomLink, error: Error): void {
    this._logger.error(`state desync in room ${room.id}; re-syncing`, error)
    const connection = this._connection
    if (connection === undefined) return
    this._lost(connection, RESYNC_CLOSE, "desync")
    connection.socket.close(RESYNC_CLOSE, "desync")
  }

  // --- internals: connection lifecycle -------------------------------------

  private _open(): void {
    // Declared before open(): a transport may report through the handlers
    // only after open() returns, and they must see the assignment below.
    let connection: Connection | undefined
    const opened = this._transport.open(this._url, [PROTOCOL_VERSION], {
      onOpen: () => {
        if (connection !== undefined) this._opened(connection)
      },
      onMessage: (data) => {
        if (connection !== undefined) this._receive(connection, data)
      },
      onClose: (code, reason) => {
        if (connection !== undefined) this._lost(connection, code, reason)
      },
    })
    if (opened.isErr()) {
      this._failedAttempt(opened.error)
      return
    }
    connection = { socket: opened.value, open: false }
    this._connection = connection
  }

  private _opened(connection: Connection): void {
    if (connection !== this._connection) return
    connection.open = true
    const reconnecting = this._state === "reconnecting"
    this._state = "connected"
    this._attempt = 0
    this._startPing()
    for (const resolve of this._connecting.splice(0)) resolve(ok(undefined))
    if (!reconnecting) return
    this._emit(this._onReconnect)
    // Resume every held seat with its current token (spec §6.7.5).
    for (const room of [...this._resuming]) {
      this._resuming.delete(room)
      const token = room.reconnectionToken
      if (token === undefined) {
        room._left(LeaveCode.DISCONNECTED)
        continue
      }
      void this._request(
        room,
        [JoinMode.RECONNECT, token, null, room._hash],
        room.id,
        true,
      )
    }
  }

  /** The connection closed, or never opened. */
  private _lost(connection: Connection, code: number, reason: string): void {
    if (connection !== this._connection) return
    this._connection = undefined
    this._stopPing()
    const wasOpen = connection.open
    connection.open = false

    // Joins in flight on this connection can't complete. Resumes are
    // retried on the next connection, so they go back to waiting.
    for (const [requestId, pending] of [...this._pending]) {
      if (pending.resume) {
        this._pending.delete(requestId)
        if (pending.timer !== undefined) this._clock.clearTimeout(pending.timer)
        this._resuming.add(pending.room)
        pending.room._suspend()
      } else {
        this._settle(
          requestId,
          err(new ClientError("CONNECTION_LOST", "connection closed")),
        )
      }
    }

    if (this._state === "connecting") {
      // The first connect never opened: report it, don't retry. Nothing
      // was lost yet.
      this._setDisconnected(
        new ClientError("CONNECTION_FAILED", `closed with ${code} ${reason}`),
      )
      return
    }

    const terminal =
      code === CloseCode.PROTOCOL_ERROR ||
      code === CloseCode.POLICY_VIOLATION ||
      (code === CloseCode.NORMAL && wasOpen)
    if (terminal || !this._reconnection.enabled) {
      const error =
        code === CloseCode.PROTOCOL_ERROR
          ? new ClientError("PROTOCOL_ERROR", reason || "protocol mismatch")
          : new ClientError(
              wasOpen ? "CONNECTION_LOST" : "CONNECTION_FAILED",
              `connection closed (${code}${reason ? `: ${reason}` : ""})`,
            )
      this._setDisconnected(error)
      if (code === CloseCode.PROTOCOL_ERROR) this._emit(this._onError, error)
      if (wasOpen) this._emit(this._onDisconnect)
      return
    }

    // Unexpected: keep every seat that has a token and try again.
    for (const room of [...this._byRef.values()]) {
      this._byRef.delete(room._ref)
      if (room.status === "joining") {
        // Seated but never joined (no snapshot yet): nothing to resume.
        room._left(LeaveCode.DISCONNECTED)
        continue
      }
      room._suspend()
      this._resuming.add(room)
    }
    this._state = "reconnecting"
    if (wasOpen) this._emit(this._onDisconnect)
    this._failedAttempt(
      new ClientError("CONNECTION_FAILED", `closed with ${code}`),
    )
  }

  /** Schedules the next attempt, or gives up after `maxAttempts`. */
  private _failedAttempt(error: ClientError): void {
    if (this._state === "connecting") {
      // A first connect that fails is reported, not retried: nothing was
      // lost yet. Joins made meanwhile fail with it.
      this._setDisconnected(error)
      return
    }
    this._state = "reconnecting"
    if (this._attempt >= this._reconnection.maxAttempts) {
      const failed = new ClientError(
        "RECONNECTION_FAILED",
        `gave up after ${this._attempt} reconnection attempts`,
      )
      this._setDisconnected(failed)
      this._emit(this._onError, failed)
      return
    }
    const { delay, factor, delayMax } = this._reconnection
    const wait = Math.min(delay * factor ** this._attempt, delayMax)
    this._attempt++
    this._retryTimer = this._clock.setTimeout(() => {
      this._retryTimer = undefined
      this._open()
    }, wait)
  }

  /** Ends everything: rooms left, pending joins and connects failed. */
  private _setDisconnected(error: ClientError): void {
    this._state = "disconnected"
    this._attempt = 0
    this._stopRetry()
    this._stopPing()
    for (const requestId of [...this._pending.keys()]) {
      this._settle(requestId, err(error))
    }
    const rooms = [...this._byRef.values(), ...this._resuming]
    this._byRef.clear()
    this._resuming.clear()
    for (const room of rooms) room._left(LeaveCode.DISCONNECTED)
    for (const resolve of this._connecting.splice(0)) resolve(err(error))
  }

  private _stopRetry(): void {
    if (this._retryTimer === undefined) return
    this._clock.clearTimeout(this._retryTimer)
    this._retryTimer = undefined
  }

  // --- internals: ping -----------------------------------------------------

  private _startPing(): void {
    this._stopPing()
    if (this._pingInterval <= 0) return
    this._pingTimer = this._clock.setInterval(
      () => this._sendPing(),
      this._pingInterval,
    )
  }

  private _stopPing(): void {
    this._ping = undefined
    if (this._pingTimer === undefined) return
    this._clock.clearInterval(this._pingTimer)
    this._pingTimer = undefined
  }

  private _sendPing(): void {
    const nonce = this._nextNonce
    this._nextNonce = nonce >= MAX_VARINT ? 1 : nonce + 1
    // rtt: whole ms, sub-ms rounds up to 1, 0 = none yet (spec §6.7.1).
    const rtt =
      this._latency === undefined
        ? 0
        : Math.min(MAX_VARINT, Math.max(1, Math.ceil(this._latency)))
    const sent = this._sendFrame(ClientFrameType.PING, [nonce, rtt])
    if (sent.isOk()) this._ping = { nonce, sentAt: this._clock.now() }
  }

  private _pong(nonce: number): void {
    const ping = this._ping
    if (ping === undefined || ping.nonce !== nonce) return
    this._ping = undefined
    this._latency = this._clock.now() - ping.sentAt
  }

  private _emit<A extends unknown[]>(
    set: Iterable<(...args: A) => void>,
    ...args: A
  ): void {
    for (const listener of [...set]) {
      try {
        listener(...args)
      } catch (error) {
        this._logger.error("client listener threw", error)
      }
    }
  }
}

function add<T>(set: Set<T>, value: T): () => void {
  set.add(value)
  return () => {
    set.delete(value)
  }
}

/** Creates a {@link BungohanClient}. */
export function createBungohanClient(options: ClientOptions): BungohanClient {
  return new BungohanClient(options)
}
