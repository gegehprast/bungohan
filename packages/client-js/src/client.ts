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

/**
 * Where the client reports problems that have no caller to return an
 * error to (`ClientOptions.logger`). Pass one to route them to your own
 * logging, or a no-op one to silence them.
 */
export interface ClientLogger {
  /**
   * Something was dropped but the client carries on: a frame it couldn't
   * use, or a message nobody listens to.
   */
  warn(message: string, detail?: unknown): void
  /** One of your listeners threw; the client caught it and carried on. */
  error(message: string, detail?: unknown): void
}

// #region client-options
/** Fetches the `token` for the next connection (see `ClientOptions.token`). */
export type TokenProvider = () =>
  | string
  | undefined
  | Promise<string | undefined>

/** `createBungohanClient`'s options. Only `url` is required. */
export interface ClientOptions {
  /** Server URL, e.g. `wss://game.example.com`. */
  url: string
  /**
   * A credential, sent as `?token=` (the server's `context.token`). A
   * function is called before every connection the client opens, the
   * first and each automatic reconnection, so each can carry a fresh
   * one-time ticket: a fixed string would already be spent when the
   * client reconnects. If it throws, rejects or returns something other
   * than a string or `undefined`, that attempt fails as if the server were
   * unreachable. See docs/guides/client.md#one-time-tokens.
   */
  token?: string | TokenProvider
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
   * one missing here fails the join with `CODEC_MISMATCH`.
   * Default: `[new SchemaCodec(), new MessagePackStateCodec()]`, so either
   * server setting works.
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
// #endregion client-options

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

/**
 * A connection to a Bungohan server, holding seats in any number of rooms
 * (see docs/guides/client.md). Create one per page with
 * `createBungohanClient` and share it; type your code against this
 * interface so a test can pass a client from `@bungohan/testing`.
 *
 * Nothing here throws: every operation that can fail resolves to a
 * `Result` whose error is a `ClientError` with a `code`.
 */
export interface IBungohanClient {
  /**
   * Opens the connection; resolves once it is open. Rarely needed: the
   * client connects on creation (`autoConnect`), and a join on a
   * disconnected client connects first. Already connected is `ok`, and a
   * connection in progress (or a reconnection's next attempt) is waited
   * for.
   *
   * A first connection that fails is reported, not retried:
   * `CONNECTION_FAILED`, or `PROTOCOL_ERROR` when the server doesn't speak
   * this client's protocol version. Retries only happen for a connection
   * that was open and dropped (see `ClientOptions.reconnection`).
   */
  connect(): Promise<Result<void, ClientError>>
  /**
   * Leaves every room (a consented leave, so each room's `onLeave` gets
   * `LeaveCode.CONSENTED`) and closes the connection. No reconnection
   * follows, and joins still in flight fail. Everything is sent before
   * this returns; the promise is already settled. The client can
   * `connect()` again later.
   */
  disconnect(): Promise<void>
  /**
   * Creates a room of `roomType` and joins it, resolving once its first
   * state snapshot has arrived (so `room.state` is filled in).
   *
   * For a contract with typed options (see docs/guides/options.md),
   * `options` are its join options, or `{ create, join }` when it declares
   * create options, and `join.contract` is required; they are checked at
   * compile time and encoded against the declarations. Otherwise
   * `options` are anything MessagePack carries. Pass `join`
   * (`{ state, contract }`) to type the room and get a replica.
   *
   * Fails with the server's refusal (`ROOM_TYPE_NOT_DEFINED`,
   * `AUTH_FAILED`, `CONTRACT_MISMATCH`, …) or a local error
   * (`CONNECTION_FAILED`, `TIMEOUT`, `CODEC_MISMATCH`, `ENCODE_FAILED`).
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
  /**
   * Joins an existing room of `roomType` that is public, unlocked and not
   * full; fails with `ROOM_NOT_FOUND` if there is none. `options` are
   * join options; the rest is as for `create`.
   */
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
  /**
   * Joins the room with this id, private rooms included (e.g. an id
   * picked from a room list or shared by a friend). Fails with
   * `ROOM_NOT_FOUND`, `ROOM_LOCKED` or `ROOM_FULL`. `options` are join
   * options; the rest is as for `create`.
   */
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
  /**
   * Joins an available room of `roomType` (as `join` would), or creates
   * one if there is none. `options` as for `create`: with create options
   * declared, `create` is only used if a room is created.
   */
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
  /**
   * Resumes a seat the server is still holding, with a
   * `room.reconnectionToken` kept from an earlier connection (e.g. across
   * a page reload; see docs/guides/client.md#resuming-after-a-reload).
   * The dropped connections this client itself sees are resumed
   * automatically, with no call.
   *
   * Fails with `INVALID_TOKEN` once the seat is gone (the timeout passed,
   * the room was disposed, or the token was replaced by a later join).
   */
  reconnect<S extends Schema = Schema, C extends Contract = EmptyContract>(
    roomId: string,
    reconnectToken: string,
    join?: JoinOptions<S, C>,
  ): Promise<Result<IRoom<S, C>, ClientError>>
  /**
   * Takes a seat the server reserved for this player (the server's
   * `matchMaker.reserve()`, handed to the client by your own means, such
   * as an HTTP response; see docs/guides/matchmaking.md#reservations).
   * Fails with `RESERVATION_NOT_FOUND` or `RESERVATION_EXPIRED`; a
   * reservation can be consumed once.
   */
  consumeReservation<
    S extends Schema = Schema,
    C extends Contract = EmptyContract,
  >(
    reservation: Reservation,
    join?: JoinOptions<S, C>,
  ): Promise<Result<IRoom<S, C>, ClientError>>
  /**
   * The rooms this client is in, by room id: every room whose join has
   * completed and that hasn't been left, including rooms waiting for a
   * reconnection. A new map each call; joins still in flight aren't in it.
   */
  getRooms(): Map<string, IRoom<Schema, Contract>>
  /** One room from {@link getRooms}, by id. */
  getRoom(id: string): IRoom<Schema, Contract> | undefined
  /**
   * Leaves every room (consented), including joins in flight and rooms
   * waiting for a reconnection, but keeps the connection open. Every
   * `LEAVE` is sent before this returns.
   */
  leaveAll(): Promise<void>
  /**
   * Opt-in: gives up every seat when the page is closed, reloaded or
   * navigated away from (`disconnect()`, run inside the page-exit event).
   * Without it, the server sees a closed tab as a dropped connection and
   * holds the seat for the reconnection timeout. A game that resumes
   * seats after a reload (see docs/guides/client.md#leaving-with-the-page)
   * must not call it.
   *
   * Listens for both `beforeunload` and `pagehide` and acts on whichever
   * fires first: a message sent in `pagehide` during a reload never leaves
   * a Firefox-engine browser. Returns a function that removes both
   * listeners. Outside a browser (no `window`) it does nothing and returns
   * a no-op. `target` defaults to the global `window`.
   */
  leaveOnPageExit(target?: PageExitTarget): () => void
  /**
   * `"connecting"` until the first connection opens, `"connected"`, then
   * `"reconnecting"` while a dropped connection is being retried (rooms
   * wait, and `send` fails with `NOT_CONNECTED`), and `"disconnected"`
   * before connecting, after `disconnect()`, or once reconnection gives
   * up. For a status indicator; there is no change event, so poll it or
   * use `onDisconnect`/`onReconnect`.
   */
  readonly connectionState: ConnectionState
  /** Last measured PING round trip in ms, or undefined before the first. */
  readonly latency: number | undefined
  /**
   * Connection-level errors, not tied to one room: an `ERROR` frame from
   * the server, a refused protocol version (`PROTOCOL_ERROR`), or
   * `RECONNECTION_FAILED` when every attempt failed. Room errors go to
   * `room.onError`. Returns a function that removes the listener.
   */
  onError(cb: (error: ClientError) => void): () => void
  /**
   * An open connection closed, whether or not a reconnection follows
   * (check `connectionState`), including through `disconnect()`. Returns a
   * function that removes the listener.
   */
  onDisconnect(cb: () => void): () => void
  /**
   * A reconnection opened a new connection. Held seats are resumed right
   * after, each room getting a fresh snapshot. Returns a function that
   * removes the listener.
   */
  onReconnect(cb: () => void): () => void
}

/** What `leaveOnPageExit` listens on: `window`, or a stand-in. */
export type PageExitTarget = Pick<
  EventTarget,
  "addEventListener" | "removeEventListener"
>

/**
 * Both, not just `pagehide`: Firefox drops a WebSocket message sent in
 * `pagehide` during a reload, but sends one from `beforeunload` (spec §7.5).
 */
const PAGE_EXIT_EVENTS = ["beforeunload", "pagehide"] as const

/** The page's `window`, or undefined in Bun, Node and workers. */
function pageWindow(): PageExitTarget | undefined {
  return typeof window === "undefined" ? undefined : window
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

/** Calls a token provider, turning a throw or a bad value into an error. */
async function fetchToken(
  provider: TokenProvider,
): Promise<Result<string | undefined, ClientError>> {
  try {
    const token: unknown = await provider()
    if (token === undefined || typeof token === "string") return ok(token)
    return err(
      new ClientError(
        "CONNECTION_FAILED",
        `the token provider returned a ${typeof token}, not a string`,
      ),
    )
  } catch (error) {
    return err(
      new ClientError("CONNECTION_FAILED", "the token provider failed", error),
    )
  }
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

/**
 * The `IBungohanClient` implementation. Create it with
 * `createBungohanClient`, and type code that receives it as
 * `IBungohanClient`.
 */
export class BungohanClient implements IBungohanClient {
  private readonly _url: string
  private readonly _token: string | TokenProvider | undefined
  /** Bumped per token fetch; a fetch that isn't the latest is dropped. */
  private _tokenFetch = 0
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
    this._url = options.url
    this._token = options.token
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

  public disconnect(): Promise<void> {
    this._disconnectNow()
    return Promise.resolve()
  }

  public leaveAll(): Promise<void> {
    this._leaveAllNow()
    return Promise.resolve()
  }

  public leaveOnPageExit(target = pageWindow()): () => void {
    if (target === undefined) return () => {}
    let exited = false
    // Never preventDefault() or set returnValue here: in beforeunload that
    // asks the browser to show a "leave this page?" prompt.
    const onExit = (): void => {
      if (exited) return
      exited = true
      this._disconnectNow()
    }
    for (const type of PAGE_EXIT_EVENTS) target.addEventListener(type, onExit)
    return () => {
      for (const type of PAGE_EXIT_EVENTS) {
        target.removeEventListener(type, onExit)
      }
    }
  }

  /** `disconnect()`, synchronously: every frame is sent when it returns. */
  private _disconnectNow(): void {
    this._leaveAllNow()
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

  private _leaveAllNow(): void {
    const rooms = new Set<RoomLink>([
      ...this._byRef.values(),
      ...this._resuming,
    ])
    for (const pending of this._pending.values()) rooms.add(pending.room)
    for (const room of rooms) room._leaveNow()
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

  public onError(cb: (error: ClientError) => void): () => void {
    return add(this._onError, cb)
  }

  public onDisconnect(cb: () => void): () => void {
    return add(this._onDisconnect, cb)
  }

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
    const token = this._token
    if (typeof token !== "function") {
      this._openSocket(withToken(this._url, token))
      return
    }
    const attempt = ++this._tokenFetch
    void fetchToken(token).then((fetched) => {
      // disconnect() (and maybe a new connect()) won while it ran.
      if (attempt !== this._tokenFetch || this._state === "disconnected") return
      if (fetched.isErr()) {
        this._logger.warn(fetched.error.message, fetched.error.context)
        this._failedAttempt(fetched.error)
        return
      }
      this._openSocket(withToken(this._url, fetched.value))
    })
  }

  private _openSocket(url: string): void {
    // Declared before open(): a transport may report through the handlers
    // only after open() returns, and they must see the assignment below.
    let connection: Connection | undefined
    const opened = this._transport.open(url, [PROTOCOL_VERSION], {
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

/**
 * Creates the client, which connects right away unless
 * `options.autoConnect` is `false`. Create one per page and share it: one
 * connection can hold seats in several rooms.
 */
export function createBungohanClient(options: ClientOptions): BungohanClient {
  return new BungohanClient(options)
}
