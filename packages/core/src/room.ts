import { err, ok, type Result } from "@bungohan/result"
import {
  encodeFrame,
  type ISerializer,
  type IStateCodec,
  type IStateCodecSession,
  MessagePackSerializer,
  SchemaCodec,
} from "@bungohan/serializer"
import {
  clearChangeTrees,
  encodeSnapshot,
  fromPlain,
  generateDeltas,
  Schema,
  toPlain,
  type WireOp,
} from "@bungohan/state"
import type { IStore } from "@bungohan/store"
import type { ConnectionContext } from "@bungohan/transport"
import {
  type Clock,
  type Contract,
  type EmptyContract,
  type Infer,
  type InferCreateOptions,
  type InferJoinOptions,
  type JoinHandshake,
  LeaveCode,
  type RecvMap,
  type Reservation,
  type SendMap,
  ServerFrameType,
  SystemClock,
  type TimerId,
} from "@bungohan/types"
import { nanoid } from "nanoid"
import { Client, type Connection } from "./client"
import { BungohanError, type ErrorCode } from "./errors"
import { Logger } from "./logger"
import { IntervalLoop, SimulationLoop } from "./loop"
import {
  ClientStats,
  type MetricsCollector,
  type RoomMetrics,
  RoomStats,
} from "./metrics"
import {
  DETACHED_TYPE,
  type RoomTypeDef,
  readServerOptions,
  validateStateClass,
} from "./room-type"
import {
  type ErrorContext,
  type ErrorSource,
  type ResolvedLimits,
  type RoomOnCreateOptions,
  resolveLimits,
  type UserDefinedRoomOnJoinOptions,
} from "./types"

/** What a room needs from its server. Internal: implemented by `BungohanServer`. */
export interface RoomHost {
  readonly clock: Clock
  readonly logger: Logger
  readonly serializer: ISerializer
  readonly stateCodec: IStateCodec
  readonly store: IStore | undefined
  readonly metrics: MetricsCollector | undefined
  readonly simulationTickRate: number
  readonly maxCatchUpSteps: number
  readonly syncTickRate: number
  isShuttingDown(): boolean
  /** Per-connection limits (spec §6.9). */
  readonly limits: ResolvedLimits
  /**
   * Bytes queued for this connection, or `undefined` when this process
   * can't know (a seat whose socket is on another process).
   */
  queuedFor(connection: Connection): number | undefined
  /** Closes a connection that is over a limit, with 1013 (spec §6.9). */
  shed(connection: Connection, why: string): void
  sendFrame(connection: Connection, frame: Uint8Array): void
  broadcastFrame(connections: Connection[], frame: Uint8Array): void
  reportError(error: unknown, context: ErrorContext): void
  createId(size: number): string
  /** A seat was released (after `onLeave`): unlink it, fire `server.onLeave`. */
  seatReleased(room: Room, client: Client, consented: boolean): void
  roomDisposed(room: Room): void
}

type Handler = (client: Client, message: unknown) => unknown

/** @internal What matchmaking created a room for (see `Placement`). */
export interface RoomPlacement {
  readonly key?: string
  readonly where?: Record<string, unknown>
}

/** Options of `onMessage` and `onMessageRaw`. */
export interface MessageHandlerOptions {
  /**
   * Run on the room's serial queue: this handler starts only once every
   * earlier serial task of the room has finished (see `Room.serial`).
   * Default false: called as the message arrives, not awaited.
   */
  serial?: boolean
}

/**
 * What `onAuth` (static or instance) and the server's `authenticate`
 * return: `false` refuses (`AUTH_FAILED`), `true` admits, and an object
 * admits and becomes the auth data. From `onAuth`, that is `client.auth`
 * and `onJoin`'s third argument, and `true` gives the seat a copy of
 * `connection.auth`.
 */
export type AuthResult = Record<string, unknown> | boolean

interface HeldReservation {
  readonly reservation: Reservation
  readonly options: unknown
  readonly timer: TimerId
}

/**
 * Join options as the hooks receive them. They were decoded against the
 * contract's join options (or are untyped and made a plain object), which
 * is exactly what `InferJoinOptions` describes.
 */
function joinOptions<C extends Contract>(
  options: unknown,
): InferJoinOptions<C> {
  const plain: unknown = asOptions(options)
  return plain as InferJoinOptions<C>
}

/** `options` as the plain object the hooks receive. */
export function asOptions(options: unknown): Record<string, unknown> {
  return typeof options === "object" &&
    options !== null &&
    !Array.isArray(options)
    ? (options as Record<string, unknown>)
    : {}
}

/**
 * A room: authoritative state, clients and game logic (see
 * docs/guides/rooms.md). Extend it, give it a `state`, and override the
 * lifecycle hooks you need. Bind a message contract as the second type
 * parameter, and hand the same contract to the runtime as
 * `static contract`:
 *
 * ```ts
 * class ShooterRoom extends Room<ShooterState, typeof shooterContract> {
 *   public static override contract = shooterContract
 *   public state = new ShooterState()
 *   protected override async onCreate() {
 *     this.onMessage("playerMove", (client, msg) => { … })
 *   }
 * }
 * ```
 *
 * Hooks are user code and may throw: the framework catches, reports to
 * `server.onError`, and carries on. Rooms take no constructor arguments;
 * the server wires them up after `new`.
 */
export abstract class Room<
  TState extends Schema = Schema,
  TContract extends Contract = EmptyContract,
> {
  /**
   * The runtime copy of the room's contract (`defineContract`): what
   * decodes and encodes its messages and options. Required when the class
   * is typed with a contract (a compile error at `defineRoomType`
   * otherwise).
   */
  public static contract: Contract | undefined = undefined

  /** Type-only link to `TContract` (never set at runtime). */
  declare public readonly __contract?: TContract
  /** Type-only link to `TState` (never set at runtime). */
  declare public readonly __state?: TState

  /** The synchronized state. Assign it as a field or in `onCreate`. */
  protected state!: TState
  /** Seats by `sessionId`: joining, joined and awaiting reconnection. */
  protected readonly clients = new Map<string, Client>()

  /**
   * Seats (clients plus open reservations) before joins fail with
   * `ROOM_FULL`. Starts from the room type's option; change it at any
   * time.
   */
  public maxClients = Number.POSITIVE_INFINITY
  /**
   * Dispose the room when its last seat is released. Starts from the room
   * type's option; set it to `false` to keep an empty room alive.
   */
  public autoDispose = true
  /**
   * Hold a seat whose connection dropped for `reconnectionTimeout`
   * seconds, instead of releasing it at once. Starts from the room type's
   * option.
   */
  public allowReconnection = true
  /** Seconds a dropped seat is held. Starts from the room type's option. */
  public reconnectionTimeout = 30
  /**
   * Free-form description for matchmaking: `matchMaker.query()` matches
   * it and room listings show it (e.g. a map name, a skill bracket). Keep
   * it plain JSON; in cluster mode it crosses processes.
   */
  public metadata: Record<string, unknown> = {}
  /** See `key`. */
  private _key: string | undefined

  private _host: RoomHost | undefined
  private _type: RoomTypeDef | undefined
  private _id = ""
  private _visibility: "public" | "private" = "public"
  private _locked = false
  private _disposing: Promise<void> | undefined
  private _disposed = false
  private _paused = false
  private _ready = false
  /** @internal Resolves once `onCreate` finished (or failed). */
  public _readyPromise: Promise<Result<void, BungohanError>> | undefined
  private _root: Schema | undefined
  private _session: IStateCodecSession | undefined
  private _simulation: SimulationLoop | undefined
  private _sync: IntervalLoop | undefined
  /** Rates asked for before the loops existed (e.g. in `onCreate`). */
  private _simulationRate: number | undefined
  private _syncRate: number | undefined
  private readonly _handlers = new Map<string, Set<Handler>>()
  private readonly _rawHandlers = new Map<string, Set<Handler>>()
  private readonly _unhandled = new Set<string>()
  /** The last task on the room's serial queue (see `serial`). */
  private _serialTail: Promise<void> = Promise.resolve()
  private readonly _presence = new Map<string, unknown>()
  private readonly _reservations = new Map<string, HeldReservation>()
  private readonly _tokens = new Map<string, Client>()
  private readonly _reconnectTimers = new Map<Client, TimerId>()
  /** @internal Metrics; undefined when metrics are off. */
  public _stats: RoomStats | undefined

  // ==========================================================================
  // Identity and state
  // ==========================================================================

  /** The room's unique id, what clients pass to `joinById`. */
  public get id(): string {
    return this._id
  }

  /** The name the room's type was registered under (`defineRoomType`). */
  public get roomType(): string {
    return this._type?.name ?? ""
  }

  /**
   * `"private"` rooms are skipped by `join`/`joinOrCreate` matchmaking and
   * by listings, but still joinable by id. Change it with
   * `makePrivate()`/`makePublic()`.
   */
  public get visibility(): "public" | "private" {
    return this._visibility
  }

  /**
   * A locked room refuses every new join (`ROOM_LOCKED`), by id too; held
   * seats can still reconnect. Change it with `lock()`/`unlock()`.
   */
  public get locked(): boolean {
    return this._locked
  }

  /** True from the moment disposal starts. */
  public get isDisposed(): boolean {
    return this._disposing !== undefined
  }

  /**
   * True while every client has dropped and at least one seat is held:
   * both loops are stopped until a seat reconnects or someone joins.
   */
  public get isPaused(): boolean {
    return this._paused
  }

  /**
   * True when this object is a `RoomProxy` for a room on another process
   * (cluster mode). A room this process owns is always local.
   */
  public get isRemote(): boolean {
    return false
  }

  /** The server's clock: use it for game timers so tests can drive them. */
  protected get clock(): Clock {
    return this._requireHost().clock
  }

  // ==========================================================================
  // Lifecycle hooks (user code; may throw)
  // ==========================================================================

  /**
   * Runs only when a join *creates* the room, before `onCreate`. Return
   * `false` to refuse, an object to become `client.auth`, or `true` (the
   * default) to use a copy of `client.connection?.auth`, what the server's
   * `authenticate` admitted the connection with. `options` are
   * the joiner's options, as `onJoin` gets them (a static method can't see
   * the class's contract type, so declare the parameter's type yourself).
   */
  protected static async onAuth(
    _client: Client,
    _options: UserDefinedRoomOnJoinOptions,
    _context: ConnectionContext,
  ): Promise<AuthResult> {
    return true
  }

  /**
   * Runs when joining an existing room (including through a reservation).
   * Returns as the static `onAuth` does. `options` are typed by the contract's join options and were decoded
   * against them: their shape is guaranteed, their values are
   * still the client's, so check game rules (a name's length) here or in
   * `onJoin`.
   */
  protected async onAuth(
    _client: Client,
    _options: InferJoinOptions<TContract>,
    _context: ConnectionContext,
  ): Promise<AuthResult> {
    return true
  }

  /**
   * The room was created. `options` are the framework's room settings plus
   * the contract's create options: typed and decoded when the contract
   * declares them, otherwise whatever the creator sent. Set up the state
   * and register message handlers here. A throw fails the creating join
   * (`JOIN_FAILED`) and disposes the room.
   */
  protected async onCreate(
    _options: RoomOnCreateOptions & InferCreateOptions<TContract>,
  ): Promise<void> {}

  /** A client joined. `options` are its join options (see `onAuth`). */
  protected async onJoin(
    _client: Client,
    _options: InferJoinOptions<TContract>,
    _auth: Record<string, unknown>,
  ): Promise<void> {}

  /** `consented`: the client left on purpose (vs. lost connection or kick). */
  protected async onLeave(
    _client: Client,
    _consented: boolean,
  ): Promise<void> {}

  /** Every simulation step; `deltaTime` is the fixed step in ms. */
  protected onTick(_deltaTime: number): void {}

  /** Right before every sync tick. */
  protected onBeforeSync(): void {}

  /**
   * The room is going away, after every seat was released (each client
   * got its `onLeave`). Save what should outlive it here; the server
   * waits for it during a graceful shutdown.
   */
  protected async onDispose(): Promise<void> {}

  /**
   * `client`'s connection dropped unexpectedly and its seat is now held
   * for reconnection (`client.connected` is false). Its `onLeave` is
   * deferred until the seat is released; use this to stop what the player
   * was doing, e.g. their last input. Not called when the drop releases the
   * seat at once (no reconnection): that is `onLeave(client, false)`.
   */
  protected onDisconnect(_client: Client): void {}

  /**
   * A held seat was resumed on a new connection (after `onResume`, if the
   * room was paused). No `onJoin` runs: the seat never left.
   */
  protected onReconnect(_client: Client): void {}

  /**
   * No client connected, and at least one seat awaits reconnection: both
   * loops stop (`onTick` doesn't run) until `onResume`.
   */
  protected onPause(): void {}

  /**
   * A paused room is running again: a held seat reconnected (this runs
   * before its `onReconnect`) or someone joined.
   */
  protected onResume(): void {}

  // ==========================================================================
  // Messages
  // ==========================================================================

  /**
   * Handles a contract message from clients. The payload type is inferred
   * from the contract; it was decoded type-directed, so its shape is
   * guaranteed (its *values* are still the client's: validate game rules).
   * Returns an unsubscribe function.
   *
   * Handlers are **not awaited** by default. Each message's handlers are
   * called as it arrives, so an async handler that awaits can finish after
   * handlers of later messages, even from the same client. Pass
   * `{ serial: true }` to put this handler on the room's serial queue
   * instead (see `serial`): it then starts only after every earlier
   * serial task of the room, from any client or timer, has finished. A
   * rejection goes to `server.onError`, like a throw.
   */
  public onMessage<K extends keyof RecvMap<TContract>>(
    type: K,
    handler: (
      client: Client,
      message: Infer<RecvMap<TContract>[K]>,
    ) => void | Promise<void>,
    options?: MessageHandlerOptions,
  ): () => void {
    const name = String(type)
    if (this._type !== undefined && !this._type.clientIds.has(name)) {
      this._requireHost().logger.error(
        `${this._label()}: onMessage("${name}"): not a client message of ` +
          "the room's contract; the handler will never run",
      )
    }
    // Decoding against the contract produced exactly this payload type.
    const typed: Handler = (client, message) =>
      handler(client, message as Infer<RecvMap<TContract>[K]>)
    return addHandler(
      this._handlers,
      name,
      this._serialized(name, typed, options),
    )
  }

  /**
   * Handles an untyped message sent with `sendRaw` (MessagePack, no
   * contract). Like `onMessage`, handlers are not awaited unless
   * `{ serial: true }` puts them on the room's serial queue.
   */
  public onMessageRaw(
    type: string,
    handler: (client: Client, message: unknown) => void | Promise<void>,
    options?: MessageHandlerOptions,
  ): () => void {
    return addHandler(
      this._rawHandlers,
      type,
      this._serialized(type, handler, options),
    )
  }

  /**
   * Runs `task` after every task queued before it on this room has
   * finished, awaiting it: one queue per room, shared by serial message
   * handlers (`onMessage(type, handler, { serial: true })`) and anything
   * else you pass here. Use it where a change must see the result of the
   * one before it across an `await`, such as two players acting on the
   * same shared value through a remote service. Call it from a timer
   * callback so the timer's change waits its turn too.
   *
   * A task that throws or rejects is reported to `server.onError` and
   * doesn't stop the queue. The returned promise settles when `task` has
   * run, and never rejects. Once the room starts disposing, tasks that
   * haven't started are dropped; one already running isn't interrupted,
   * so after an `await` it may find the room disposed (`isDisposed`) or
   * its client gone (`client.status`). Don't await `dispose()` inside a
   * task: disposal doesn't wait for the queue, but a task awaiting it
   * holds up every task behind it until it finishes.
   * See docs/guides/messages.md#handlers-arent-awaited.
   */
  protected serial(task: () => unknown): Promise<void> {
    return this._enqueue(task, { source: "serial", room: this })
  }

  private _enqueue(task: () => unknown, context: ErrorContext): Promise<void> {
    const run = async (): Promise<void> => {
      if (this._disposing !== undefined) return
      try {
        await task()
      } catch (error) {
        this._requireHost().reportError(error, context)
      }
    }
    const next = this._serialTail.then(run)
    this._serialTail = next
    return next
  }

  /** A handler as registered: on the serial queue if asked. */
  private _serialized(
    name: string,
    handler: Handler,
    options: MessageHandlerOptions | undefined,
  ): Handler {
    if (options?.serial !== true) return handler
    return (client, message) => {
      void this._enqueue(() => handler(client, message), {
        source: "onMessage",
        room: this,
        client,
        messageType: name,
      })
    }
  }

  /** Sends a contract message to one client. */
  protected send<K extends keyof SendMap<TContract>>(
    client: Client,
    type: K,
    message: Infer<SendMap<TContract>[K]>,
  ): void {
    const name = String(type)
    const body = this._encodeMessage(name, message)
    if (body === undefined) return
    const [id, bytes] = body
    this._deliver(client, ServerFrameType.ROOM_MESSAGE, [id], bytes)
  }

  /** Sends a contract message to every client (but `except`). Encoded once. */
  protected broadcast<K extends keyof SendMap<TContract>>(
    type: K,
    message: Infer<SendMap<TContract>[K]>,
    except?: Client,
  ): void {
    const body = this._encodeMessage(String(type), message)
    if (body === undefined) return
    const [id, bytes] = body
    this._deliverAll(ServerFrameType.ROOM_MESSAGE, [id], bytes, except)
  }

  /** Public `broadcast`, for code outside the room. */
  public broadcastMessage<K extends keyof SendMap<TContract>>(
    type: K,
    message: Infer<SendMap<TContract>[K]>,
    except?: Client,
  ): void {
    this.broadcast(type, message, except)
  }

  /**
   * @internal `broadcast` by name, for a `RoomProxy` on another process
   * (spec §6.4). The payload is checked against the contract by
   * `_encodeMessage`, which reports an unknown name to `server.onError`.
   */
  public _broadcastByName(
    type: string,
    message: unknown,
    except?: Client,
  ): void {
    const body = this._encodeMessage(type, message)
    if (body === undefined) return
    const [id, bytes] = body
    this._deliverAll(ServerFrameType.ROOM_MESSAGE, [id], bytes, except)
  }

  /** @internal `broadcastRaw` by name (spec §6.4). */
  public _broadcastRawByName(
    type: string,
    message: unknown,
    except?: Client,
  ): void {
    const body = this._encodeRaw(type, message)
    if (body !== undefined) {
      this._deliverAll(ServerFrameType.ROOM_MESSAGE_RAW, [], body, except)
    }
  }

  /** Untyped send: the type name travels inline, the payload as MessagePack. */
  protected sendRaw(client: Client, type: string, message: unknown): void {
    const body = this._encodeRaw(type, message)
    if (body !== undefined) {
      this._deliver(client, ServerFrameType.ROOM_MESSAGE_RAW, [], body)
    }
  }

  /** `sendRaw` to every client (but `except`). Encoded once. */
  protected broadcastRaw(
    type: string,
    message: unknown,
    except?: Client,
  ): void {
    const body = this._encodeRaw(type, message)
    if (body !== undefined) {
      this._deliverAll(ServerFrameType.ROOM_MESSAGE_RAW, [], body, except)
    }
  }

  // ==========================================================================
  // Room control
  // ==========================================================================

  /**
   * Removes `client` from this room: it gets `LEAVE(code)` (default
   * `4000 KICKED`), and `onLeave(client, false)` runs. The connection stays
   * open (it may be in other rooms).
   */
  public disconnectClient(
    client: Client,
    code: number = LeaveCode.KICKED,
    reason?: string,
  ): void {
    void this._release(client, false, code, reason)
  }

  /**
   * Seats a server-side client (a bot, or a test) with no connection.
   * Runs the instance `onAuth` and `onJoin` like a real join.
   */
  public async join(
    client: Client,
    options?: InferJoinOptions<TContract>,
  ): Promise<Result<void, BungohanError>> {
    // Converted through the wire encoding, like any server-built options,
    // so the hooks see what a client's options would decode to.
    const read = readServerOptions(this._type ?? DETACHED_TYPE, "join", options)
    if (read.isErr()) {
      return err(this._error("INVALID_OPTIONS", read.error.message))
    }
    const seated = this._seat(client, undefined, false)
    if (seated.isErr()) return seated
    const context: ConnectionContext = {
      ip: "server",
      searchParams: new URLSearchParams(),
      headers: new Headers(),
    }
    const auth = await this._authorize(client, read.value, context)
    if (auth.isErr()) {
      this._unseat(client)
      return auth
    }
    const joined = await this._runJoin(client, read.value, auth.value)
    if (joined.isErr()) return joined
    this._activate(client)
    return ok(undefined)
  }

  /** Releases `client`'s seat: `LEAVE(1000)` if consented, else `LEAVE(4000)`. */
  public async leave(
    client: Client,
    consented = true,
  ): Promise<Result<void, BungohanError>> {
    if (client._room !== this || client._status === "left") {
      return err(this._error("CLIENT_NOT_FOUND", "client is not in this room"))
    }
    await this._release(
      client,
      consented,
      consented ? LeaveCode.CONSENTED : LeaveCode.KICKED,
    )
    return ok(undefined)
  }

  /** Refuses new joins (see {@link locked}), e.g. once a match starts. */
  public lock(): void {
    this._locked = true
  }

  /** Accepts joins again. */
  public unlock(): void {
    this._locked = false
  }

  /** Hides the room from matchmaking and listings (see {@link visibility}). */
  public makePrivate(): void {
    this._visibility = "private"
  }

  /** Lists the room again and lets matchmaking place clients in it. */
  public makePublic(): void {
    this._visibility = "public"
  }

  /**
   * Steps per second of this room's simulation (default: the server's
   * `simulation.tickRate`). Works from `onCreate`: the rate is kept and
   * applied when the loop starts. Ignored unless finite and positive.
   */
  public setSimulationTickRate(fps: number): void {
    if (!(Number.isFinite(fps) && fps > 0)) return
    this._simulationRate = fps
    this._simulation?.setTickRate(fps)
  }

  /**
   * State syncs per second of this room (default: the server's
   * `sync.tickRate`). Works from `onCreate`, like `setSimulationTickRate`.
   */
  public setStateSyncTickRate(hz: number): void {
    if (!(Number.isFinite(hz) && hz > 0)) return
    this._syncRate = hz
    this._sync?.setRate(hz)
  }

  /**
   * Disposes the room: every client gets `LEAVE(4002 ROOM_DISPOSED)` (or
   * `4001` during shutdown) and `onLeave(client, false)`, then `onDispose`.
   */
  public dispose(): Promise<void> {
    this._disposing ??= this._dispose()
    return this._disposing
  }

  // ==========================================================================
  // Presence (local to this process)
  // ==========================================================================

  /**
   * Keeps a small record for a seat (by `sessionId`), for code outside
   * the room to read. Never sent to clients (what they should see belongs
   * in the state), and cleared when the seat is released or the room is
   * disposed.
   */
  public setPresence(clientId: string, data: unknown): void {
    this._presence.set(clientId, data)
  }

  /** The seat's presence record, or undefined. */
  public getPresence(clientId: string): unknown {
    return this._presence.get(clientId)
  }

  /** Every presence record, by `sessionId` (a copy). */
  public getAllPresence(): Map<string, unknown> {
    return new Map(this._presence)
  }

  /** Drops the seat's presence record. */
  public removePresence(clientId: string): void {
    this._presence.delete(clientId)
  }

  // ==========================================================================
  // Persistence (through the server's IStore)
  // ==========================================================================

  /**
   * Store key of this room's state. The default contains the room id,
   * which is random and never reissued, so a state saved under it is only
   * found again by this room. Override it with a key from your game (a
   * world id) to load a state after a restart; see
   * docs/guides/rooms.md#what-survives-a-restart.
   */
  protected stateKey(): string {
    return `room:${this.roomType}:${this.id}:state`
  }

  /**
   * Loads the state saved by `saveState`, as a new instance of the current
   * state's class. `ok(undefined)` when nothing is saved or the server has
   * no store. Assign the result to `this.state` (in `onCreate`, or later:
   * a replaced state is re-sent to every client as a fresh snapshot).
   */
  protected async loadState(): Promise<
    Result<TState | undefined, BungohanError>
  > {
    const host = this._requireHost()
    if (host.store === undefined) return ok(undefined)
    const current = this.state
    if (!(current instanceof Schema)) {
      return err(
        this._error("INVALID_STATE", "loadState needs this.state to be set"),
      )
    }
    const loaded = await host.store.get(this.stateKey())
    if (loaded.isErr()) {
      return err(
        this._error("STORE_FAILED", loaded.error.message, loaded.error),
      )
    }
    if (loaded.value === undefined) return ok(undefined)
    const ctor = current.constructor as new () => TState
    const state = fromPlain(ctor, loaded.value)
    return state.isErr()
      ? err(this._error("STORE_FAILED", state.error.message, state.error))
      : ok(state.value)
  }

  /**
   * Saves `state` (default: the room's state) under `stateKey()`. No-op
   * without a store. Nothing saves automatically: call it when the state
   * must survive (on a timer, at the end of a round, in `onDispose`).
   */
  protected async saveState(
    state: TState = this.state,
  ): Promise<Result<void, BungohanError>> {
    const host = this._requireHost()
    if (host.store === undefined) return ok(undefined)
    const saved = await host.store.set(this.stateKey(), toPlain(state))
    return saved.isErr()
      ? err(this._error("STORE_FAILED", saved.error.message, saved.error))
      : ok(undefined)
  }

  // ==========================================================================
  // Queries
  // ==========================================================================

  /** Seats taken (joining, joined, awaiting reconnection). */
  public getClientCount(): number {
    return this.clients.size
  }

  /** Whether a seat with this `sessionId` is taken (held seats count). */
  public hasClient(clientId: string): boolean {
    return this.clients.has(clientId)
  }

  /** The seat with this `sessionId`, including held ones. */
  public getClient(clientId: string): Client | undefined {
    return this.clients.get(clientId)
  }

  /** Every seat: joining, joined and awaiting reconnection (a copy). */
  public getClients(): Client[] {
    return [...this.clients.values()]
  }

  /** Seats counted against `maxClients`: clients plus open reservations. */
  public getSeatCount(): number {
    return this.clients.size + this._reservations.size
  }

  /** True if a matchmaking join could take a seat right now. */
  public isAvailable(): boolean {
    return (
      this._disposing === undefined &&
      !this._locked &&
      this._visibility === "public" &&
      this.getSeatCount() < this.maxClients
    )
  }

  /** @internal Room metrics; undefined when metrics are off. */
  public _metrics(now: number): RoomMetrics | undefined {
    const stats = this._stats
    if (stats === undefined) return undefined
    const uptime = (now - stats.createdAt) / 1000
    return {
      roomId: this.id,
      roomType: this.roomType,
      clientCount: this.clients.size,
      uptime,
      totalMessages: stats.messages,
      messagesPerSecond: uptime > 0 ? stats.messages / uptime : 0,
      stateSyncCount: stats.syncs,
      simulationTicks: stats.ticks,
      averageTickDuration: stats.tickDuration.value,
      averageSyncDuration: stats.syncDuration.value,
      avgStateDeltaBytes: stats.deltaBytes.value,
      avgStateSnapshotBytes: stats.snapshotBytes.value,
      droppedSimulationMs: this._simulation?.droppedMs ?? 0,
      syncPauses: stats.syncPauses,
      timestamp: now,
    }
  }

  // ==========================================================================
  // Internals: setup and creation
  // ==========================================================================

  /**
   * @internal The state, unchecked: for definition-time checks on a probe
   * instance, and for the test harness (`stateOf`).
   */
  public _peekState(): unknown {
    return this.state
  }

  /** @internal */
  public _setup(host: RoomHost, type: RoomTypeDef, id: string): void {
    this._host = host
    this._type = type
    this._id = id
    const o = type.options
    this.maxClients = o.maxClients
    this.autoDispose = o.autoDispose
    this.allowReconnection = o.allowReconnection
    this.reconnectionTimeout = o.reconnectionTimeout
    this.metadata = { ...o.metadata }
    this._visibility = o.visibility
    this._locked = o.locked
    if (host.metrics !== undefined)
      this._stats = new RoomStats(host.clock.now())
  }

  /**
   * The key server-side matchmaking created this room under
   * (`Placement.key`): at most one room of the type has it, across the
   * cluster. `undefined` for a room created without one. Fixed for the
   * room's life.
   */
  public get key(): string | undefined {
    return this._key
  }

  /**
   * @internal Runs `onCreate`, checks the state, starts the loops.
   * `placement` is what matchmaking created the room for: its key, and
   * `where` entries that go into `metadata` last, so the room matches.
   */
  public async _create(
    options: unknown,
    placement: RoomPlacement = {},
  ): Promise<Result<void, BungohanError>> {
    const host = this._requireHost()
    const user = asOptions(options)
    this._key = placement.key
    const full: RoomOnCreateOptions & Record<string, unknown> = {
      ...user,
      roomId: this.id,
      roomType: this.roomType,
      maxClients: this.maxClients,
      autoDispose: this.autoDispose,
      allowReconnection: this.allowReconnection,
      reconnectionTimeout: this.reconnectionTimeout,
      visibility: this._visibility,
      locked: this._locked,
      metadata: {
        ...this.metadata,
        ...asOptions(user["metadata"]),
        ...placement.where,
      },
    }
    this.metadata = full.metadata
    // `options` were decoded against the contract's create options (or are
    // untyped), which is exactly what InferCreateOptions describes.
    const typed: unknown = full
    const created = await this._hookAsync("onCreate", undefined, () =>
      this.onCreate(
        typed as RoomOnCreateOptions & InferCreateOptions<TContract>,
      ),
    )
    if (!created) {
      return err(this._error("ROOM_CREATE_FAILED", "onCreate threw"))
    }
    if (this.state !== undefined) {
      const problems = validateStateClass(this.state)
      if (problems.length > 0) {
        const message = `${this._label()}: invalid state: ${problems.join("; ")}`
        host.logger.error(message)
        return err(this._error("ROOM_CREATE_FAILED", message))
      }
      this._root = this.state
    }
    this._session = host.stateCodec.createSession()
    this._simulation = new SimulationLoop(
      host.clock,
      this._simulationRate ?? host.simulationTickRate,
      (dt) => this._simulate(dt),
      host.maxCatchUpSteps,
    )
    this._sync = new IntervalLoop(
      host.clock,
      this._syncRate ?? host.syncTickRate,
      () => this._syncNow(),
    )
    this._ready = true
    if (this._disposing === undefined) {
      this._simulation.start()
      this._sync.start()
    }
    return ok(undefined)
  }

  /** @internal The sync loop's period in ms while it runs (the test harness). */
  public get _syncPeriodMs(): number | undefined {
    const sync = this._sync
    return sync?.running === true ? sync.periodMs : undefined
  }

  /** @internal True once `onCreate` completed. */
  public get _isReady(): boolean {
    return this._ready
  }

  // ==========================================================================
  // Internals: seats and joins (driven by the server, spec §6.7.2)
  // ==========================================================================

  /**
   * @internal Whether a new seat may be taken by id: what `joinById` and
   * `reserveById` check. Private rooms are fine; locked, full and
   * disposing ones aren't.
   */
  public _acceptsNewSeat(): Result<void, BungohanError> {
    const undisposed = this._undisposed()
    if (undisposed.isErr()) return undisposed
    if (this._locked) {
      return err(this._error("ROOM_LOCKED", "the room is locked"))
    }
    if (this.getSeatCount() >= this.maxClients) {
      return err(this._error("ROOM_FULL", "the room is full"))
    }
    return ok(undefined)
  }

  private _undisposed(): Result<void, BungohanError> {
    return this._disposing === undefined
      ? ok(undefined)
      : err(this._error("ROOM_NOT_FOUND", "the room is being disposed"))
  }

  /**
   * @internal Takes a seat synchronously (before any await), so concurrent
   * joins can't overfill the room.
   */
  public _seat(
    client: Client,
    connection: Connection | undefined,
    reserved: boolean,
    ref?: number,
  ): Result<void, BungohanError> {
    const open = reserved ? this._undisposed() : this._acceptsNewSeat()
    if (open.isErr()) return open
    if (this.clients.has(client.sessionId)) {
      return err(this._error("ALREADY_JOINED", "session already seated"))
    }
    client._room = this
    client._status = "joining"
    client._queue = []
    client._synced = false
    if (this._host?.metrics !== undefined) {
      client._stats = new ClientStats(this._host.clock.now())
    }
    this._bind(client, connection, ref)
    this.clients.set(client.sessionId, client)
    return ok(undefined)
  }

  /** @internal Undoes `_seat` for a join that failed before `onJoin` finished. */
  public _unseat(client: Client): void {
    if (this.clients.get(client.sessionId) !== client) return
    this.clients.delete(client.sessionId)
    this._unbind(client)
    client._status = "left"
    client._queue = undefined
    // A join that never completed empties the room only if the room was
    // there for it: it created the room, or it used the reservation that
    // was keeping the room. A refused join into an existing room (by id,
    // or a bot's) leaves it as it was: otherwise anyone with the id of a
    // room made by `createRoom` could dispose it with one join its onAuth
    // turns down.
    if (client.joinedBy === "create" || client.joinedBy === "reservation") {
      this._checkEmpty()
    }
  }

  /** @internal Instance `onAuth`. */
  public async _authorize(
    client: Client,
    options: unknown,
    context: ConnectionContext,
  ): Promise<Result<Record<string, unknown>, BungohanError>> {
    let result: AuthResult | undefined
    const ran = await this._hookAsync("onAuth", client, async () => {
      result = await this.onAuth(
        client,
        joinOptions<TContract>(options),
        context,
      )
    })
    if (!ran) return err(this._error("JOIN_FAILED", "onAuth threw"))
    return authOutcome(result, client, (code, message) =>
      this._error(code, message),
    )
  }

  /** @internal Static `onAuth` of a room class, for a join that creates a room. */
  public static async _authorizeCreate(
    ctor: object,
    client: Client,
    options: unknown,
    context: ConnectionContext,
    report: (error: unknown) => void,
    makeError: (code: ErrorCode, message: string) => BungohanError,
  ): Promise<Result<Record<string, unknown>, BungohanError>> {
    const hook: unknown = Reflect.get(ctor, "onAuth")
    if (typeof hook !== "function") {
      return authOutcome(true, client, makeError)
    }
    try {
      const result: unknown = await hook.call(
        ctor,
        client,
        asOptions(options),
        context,
      )
      return authOutcome(result, client, makeError)
    } catch (error) {
      report(error)
      return err(makeError("JOIN_FAILED", "onAuth threw"))
    }
  }

  /** @internal `onJoin`. On failure the seat is released without `onLeave`. */
  public async _runJoin(
    client: Client,
    options: unknown,
    auth: Record<string, unknown>,
  ): Promise<Result<void, BungohanError>> {
    client.auth = auth
    const ran = await this._hookAsync("onJoin", client, () =>
      this.onJoin(client, joinOptions<TContract>(options), auth),
    )
    if (!ran) {
      this._unseat(client)
      return err(this._error("JOIN_FAILED", "onJoin threw"))
    }
    if (client._status !== "joining") {
      // Kicked, or the room was disposed, while onJoin ran.
      return err(
        this._error("JOIN_FAILED", "the seat was released during onJoin"),
      )
    }
    return ok(undefined)
  }

  /** @internal A new reconnection token, or null if reconnection is off. */
  public _issueToken(client: Client): string | null {
    this._revokeToken(client)
    if (!this.allowReconnection || this.reconnectionTimeout <= 0) return null
    const token = `${this.id}.${this._requireHost().createId(24)}`
    client._reconnectionToken = token
    this._tokens.set(token, client)
    return token
  }

  /** @internal The `JOIN_SUCCESS` body (spec §6.7.4). */
  public _handshake(client: Client, token: string | null): JoinHandshake {
    const type = this._requireType()
    return [
      this.id,
      type.name,
      client.sessionId,
      token,
      type.contractHash,
      this._requireHost().stateCodec.getName(),
      [...type.clientNames],
      [...type.serverNames],
    ]
  }

  /**
   * @internal Called right after `JOIN_SUCCESS`: the client is joined,
   * its queued frames go out, the others hear `CLIENT_JOINED`. Its snapshot
   * follows at the next sync boundary.
   */
  public _activate(client: Client): void {
    if (client._status !== "joining") return
    client._status = "joined"
    // A room paused with only held seats resumes for a newcomer, or it
    // would never get its snapshot (spec §6.7.5).
    this._updatePause()
    const queue = client._queue
    client._queue = undefined
    if (queue !== undefined) {
      for (const frame of queue) this._send(client, frame)
    }
    const body = this._encodeBody(client.sessionId)
    if (body !== undefined) {
      this._deliverAll(ServerFrameType.CLIENT_JOINED, [], body, client)
    }
  }

  /** @internal The held seat a reconnection token names, if any. */
  public _heldSeat(token: string): Client | undefined {
    const client = this._tokens.get(token)
    return client?._status === "reconnecting" ? client : undefined
  }

  /** @internal Binds a held seat to a new connection (spec §6.7.5). */
  public _reconnect(
    client: Client,
    connection: Connection,
    ref?: number,
  ): void {
    const timer = this._reconnectTimers.get(client)
    if (timer !== undefined) this._requireHost().clock.clearTimeout(timer)
    this._reconnectTimers.delete(client)
    this._bind(client, connection, ref)
    client._status = "joined"
    client._synced = false
    this._updatePause()
  }

  /**
   * @internal Called right after a resumed seat's `JOIN_SUCCESS`, so what
   * `onReconnect` sends reaches the client after the handshake.
   */
  public _reconnected(client: Client): void {
    this._hook("onReconnect", () => this.onReconnect(client), client)
  }

  /** @internal The transport closed under this client. */
  public _connectionLost(client: Client): void {
    if (client._status === "left" || client._status === "reconnecting") return
    const host = this._requireHost()
    this._unbind(client)
    if (client._status === "joining") return // the join continuation cleans up
    if (
      this.allowReconnection &&
      this.reconnectionTimeout > 0 &&
      client._reconnectionToken !== undefined &&
      !host.isShuttingDown() &&
      this._disposing === undefined
    ) {
      client._status = "reconnecting"
      client._synced = false
      this._reconnectTimers.set(
        client,
        host.clock.setTimeout(() => {
          this._reconnectTimers.delete(client)
          void this._release(client, false, undefined)
        }, this.reconnectionTimeout * 1000),
      )
      this._hook("onDisconnect", () => this.onDisconnect(client), client)
      this._updatePause()
      return
    }
    void this._release(client, false, undefined)
  }

  /**
   * @internal Releases a seat for good: `LEAVE(code)` to the client (when
   * `code` is given and it is connected), `onLeave` if it had joined,
   * `CLIENT_LEFT` to the others, `server.onLeave`.
   */
  public async _release(
    client: Client,
    consented: boolean,
    code: number | undefined,
    reason?: string,
  ): Promise<void> {
    if (client._room !== this || client._status === "left") return
    const host = this._requireHost()
    const wasJoining = client._status === "joining"
    if (code !== undefined && client._connection !== undefined && !wasJoining) {
      const body = reason === undefined ? undefined : this._encodeBody(reason)
      const frame = this._frame(
        ServerFrameType.LEAVE,
        [client._roomRef, code],
        body,
      )
      if (frame !== undefined) this._send(client, frame)
    }
    const timer = this._reconnectTimers.get(client)
    if (timer !== undefined) host.clock.clearTimeout(timer)
    this._reconnectTimers.delete(client)
    this._revokeToken(client)
    this._unbind(client)
    client._status = "left"
    client._queue = undefined
    this.clients.delete(client.sessionId)
    this._presence.delete(client.sessionId)
    if (wasJoining) {
      this._checkEmpty()
      return
    }
    await this._hookAsync("onLeave", client, () =>
      this.onLeave(client, consented),
    )
    const body = this._encodeBody(client.sessionId)
    if (body !== undefined) {
      this._deliverAll(ServerFrameType.CLIENT_LEFT, [], body, client)
    }
    host.seatReleased(this, client, consented)
    this._updatePause()
    this._checkEmpty()
  }

  // ==========================================================================
  // Internals: reservations
  // ==========================================================================

  /** @internal Holds a seat for `reservation` until it expires. */
  public _hold(reservation: Reservation, options: unknown, ms: number): void {
    const host = this._requireHost()
    const timer = host.clock.setTimeout(() => {
      this._reservations.delete(reservation.id)
      this._checkEmpty()
    }, ms)
    this._reservations.set(reservation.id, { reservation, options, timer })
  }

  /** @internal Converts a held reservation into nothing (it becomes a seat). */
  public _takeReservation(id: string): unknown {
    const held = this._reservations.get(id)
    if (held === undefined) return undefined
    this._requireHost().clock.clearTimeout(held.timer)
    this._reservations.delete(id)
    return held.options
  }

  // ==========================================================================
  // Internals: inbound messages
  // ==========================================================================

  /**
   * @internal A `ROOM_MESSAGE` from `client`. An error is a protocol
   * violation (the server closes the connection); a missing handler isn't.
   */
  public _receive(
    client: Client,
    messageId: number,
    body: Uint8Array,
  ): Result<void, Error> {
    const type = this._requireType()
    const def = type.clientMessages[messageId]
    if (def === undefined) {
      return err(new Error(`unknown message id ${messageId}`))
    }
    const payload = this._requireHost().stateCodec.decodeMessage(def, body)
    if (payload.isErr()) return payload
    this._countInbound(client, body.byteLength)
    this._dispatch(this._handlers, def.name, client, payload.value)
    return ok(undefined)
  }

  /** @internal A `ROOM_MESSAGE_RAW` from `client`. */
  public _receiveRaw(client: Client, body: Uint8Array): Result<void, Error> {
    const decoded = this._requireHost().serializer.decode(body)
    if (decoded.isErr()) return decoded
    const value = decoded.value
    if (
      !Array.isArray(value) ||
      value.length < 2 || // trailing elements are ignored (spec §6.7.7)
      typeof value[0] !== "string"
    ) {
      return err(new Error("raw message must be [type, payload]"))
    }
    this._countInbound(client, body.byteLength)
    this._dispatch(this._rawHandlers, value[0], client, value[1])
    return ok(undefined)
  }

  /** @internal Records a client-reported round trip (metrics only). */
  public _recordLatency(client: Client, rtt: number): void {
    client._stats?.latency.add(rtt)
  }

  // ==========================================================================
  // Internals: loops and sync
  // ==========================================================================

  /** @internal One simulation step. */
  public _simulate(deltaTime: number): void {
    const stats = this._stats
    if (stats === undefined) {
      this._hook("onTick", () => this.onTick(deltaTime))
      return
    }
    const clock = this._requireHost().clock
    const start = clock.now()
    this._hook("onTick", () => this.onTick(deltaTime))
    stats.ticks++
    stats.tickDuration.add(clock.now() - start)
  }

  /**
   * Pauses, resumes or sheds seats by how much they have queued (spec
   * §6.9). A paused seat is taken out of `generateDeltas` the same way a
   * reconnecting one is, and comes back through the snapshot path, because
   * patches are deltas: skipping one would desync that client for good.
   */
  private _applyBackpressure(host: RoomHost): void {
    const limits = host.limits
    if (limits.pauseBytes <= 0) return
    const now = host.clock.now()
    for (const client of this.clients.values()) {
      const connection = client._connection
      if (client._status !== "joined" || connection === undefined) continue
      const queued = host.queuedFor(connection)
      if (queued === undefined) continue // socket on another process
      if (client._pausedSince === undefined) {
        if (queued <= limits.pauseBytes) continue
        client._pausedSince = now
        client._synced = false
        const stats = this._stats
        if (stats !== undefined) stats.syncPauses++
        host.logger.debug(
          `sync paused for ${client.sessionId}: ${queued} bytes queued`,
        )
        continue
      }
      if (queued <= limits.resumeBytes) {
        // Drained: the snapshot pass re-syncs it from scratch.
        client._pausedSince = undefined
        continue
      }
      if (
        limits.maxPausedMs > 0 &&
        now - client._pausedSince > limits.maxPausedMs
      ) {
        host.shed(connection, `read too slowly for ${limits.maxPausedMs}ms`)
      }
    }
  }

  /**
   * @internal One sync boundary (spec §5.7.10, §6.7.2): patches to clients
   * that have a snapshot, `clearChangeTrees`, then snapshots for clients
   * waiting for one. Sends nothing on an idle tick.
   */
  public _syncNow(): void {
    if (this._disposing !== undefined || !this._ready) return
    const host = this._requireHost()
    const stats = this._stats
    const start = stats === undefined ? 0 : host.clock.now()
    this._hook("onBeforeSync", () => this.onBeforeSync())
    this._adoptReplacedState()

    this._applyBackpressure(host)

    const root = this._root
    if (root !== undefined) {
      const synced: Client[] = []
      for (const client of this.clients.values()) {
        if (client._status === "joined" && client._synced) synced.push(client)
      }
      const deltas = generateDeltas(root, synced)
      const bodies = new Map<WireOp[], Uint8Array | null>()
      const targets = new Map<Uint8Array, Client[]>()
      for (const [client, ops] of deltas) {
        if (ops.length === 0) continue
        let body = bodies.get(ops)
        if (body === undefined) {
          body = this._encodeOps(ops)
          bodies.set(ops, body)
          if (body !== null) stats?.deltaBytes.add(body.byteLength)
        }
        if (body === null) continue
        const list = targets.get(body)
        if (list === undefined) targets.set(body, [client])
        else list.push(client)
      }
      for (const [body, clients] of targets) {
        this._sendGrouped(ServerFrameType.STATE_PATCH, [], body, clients)
      }
      clearChangeTrees(root)
    }

    for (const client of this.clients.values()) {
      if (client._status !== "joined" || client._synced) continue
      if (client._connection === undefined) continue
      // Still draining: a snapshot now would only add to the queue.
      if (client._pausedSince !== undefined) continue
      let ops: WireOp[] = []
      if (root !== undefined) {
        const snapshot = encodeSnapshot(root, client)
        if (snapshot.isErr()) {
          host.reportError(snapshot.error, {
            source: "sync",
            room: this,
            client,
          })
          continue
        }
        ops = snapshot.value
      }
      const body = this._encodeOps(ops)
      if (body === null) continue
      stats?.snapshotBytes.add(body.byteLength)
      const frame = this._frame(
        ServerFrameType.STATE_SNAPSHOT,
        [client._roomRef],
        body,
      )
      if (frame === undefined) continue
      this._send(client, frame)
      client._synced = true
    }

    if (stats !== undefined) {
      stats.syncs++
      stats.syncDuration.add(host.clock.now() - start)
    }
  }

  /**
   * A state assigned after the room started replaces the old tree: a new
   * codec session, and a fresh snapshot for everyone at this boundary.
   */
  private _adoptReplacedState(): void {
    const state: unknown = this.state
    if (state === this._root || !(state instanceof Schema)) return
    const problems = validateStateClass(state)
    if (problems.length > 0) {
      this._requireHost().reportError(
        new Error(`replacement state is invalid: ${problems.join("; ")}`),
        { source: "sync", room: this },
      )
      return
    }
    this._root = state
    this._session = this._requireHost().stateCodec.createSession()
    for (const client of this.clients.values()) client._synced = false
  }

  private _encodeOps(ops: WireOp[]): Uint8Array | null {
    const session = this._session
    if (session === undefined) return null
    const encoded = session.encodeOps(ops)
    if (encoded.isErr()) {
      this._requireHost().reportError(encoded.error, {
        source: "sync",
        room: this,
      })
      return null
    }
    return encoded.value
  }

  // ==========================================================================
  // Internals: dispose
  // ==========================================================================

  private async _dispose(): Promise<void> {
    const host = this._requireHost()
    this._simulation?.stop()
    this._sync?.stop()
    const code = host.isShuttingDown()
      ? LeaveCode.SERVER_SHUTDOWN
      : LeaveCode.ROOM_DISPOSED
    for (const client of [...this.clients.values()]) {
      await this._release(client, false, code)
    }
    for (const held of this._reservations.values()) {
      host.clock.clearTimeout(held.timer)
    }
    this._reservations.clear()
    await this._hookAsync("onDispose", undefined, () => this.onDispose())
    this._handlers.clear()
    this._rawHandlers.clear()
    this._presence.clear()
    this._disposed = true
    host.roomDisposed(this)
  }

  /** @internal True from the moment disposal starts. */
  public get _closing(): boolean {
    return this._disposing !== undefined
  }

  /** @internal True once disposal finished. */
  public get _isDisposed(): boolean {
    return this._disposed
  }

  private _checkEmpty(): void {
    if (
      this.autoDispose &&
      this._ready &&
      this._disposing === undefined &&
      this.clients.size === 0 &&
      this._reservations.size === 0
    ) {
      void this.dispose()
    }
  }

  private _updatePause(): void {
    if (this._disposing !== undefined || !this._ready) return
    let connected = 0
    let held = 0
    for (const client of this.clients.values()) {
      if (client._status === "reconnecting") held++
      else if (client._connection !== undefined) connected++
    }
    if (!this._paused && connected === 0 && held > 0) {
      this._paused = true
      this._simulation?.stop()
      this._sync?.stop()
      this._hook("onPause", () => this.onPause())
    } else if (this._paused && connected > 0) {
      this._paused = false
      this._simulation?.start()
      this._sync?.start()
      this._hook("onResume", () => this.onResume())
    }
  }

  // ==========================================================================
  // Internals: frames
  // ==========================================================================

  /**
   * Binds a seat to a connection and gives it a `roomRef`. A clustered
   * join passes `ref`: the handle the *edge* process already allocated on
   * the real connection, so every frame this room builds is addressed with
   * the handle that goes on the wire (spec §6.4, PROTOCOL.md §3.1).
   */
  private _bind(
    client: Client,
    connection: Connection | undefined,
    ref?: number,
  ): void {
    client._connection = connection
    if (connection === undefined) return
    client._roomRef = ref ?? connection._nextRoomRef++
    connection._seats.set(client._roomRef, client)
  }

  private _unbind(client: Client): void {
    const connection = client._connection
    if (connection?._seats.get(client._roomRef) === client) {
      connection._seats.delete(client._roomRef)
    }
    client._connection = undefined
  }

  private _revokeToken(client: Client): void {
    if (client._reconnectionToken !== undefined) {
      this._tokens.delete(client._reconnectionToken)
      client._reconnectionToken = undefined
    }
  }

  private _frame(
    type: number,
    header: readonly number[],
    body?: Uint8Array,
  ): Uint8Array | undefined {
    const frame = encodeFrame(type, header, body)
    if (frame.isOk()) return frame.value
    this._requireHost().reportError(frame.error, { source: "send", room: this })
    return undefined
  }

  /** Sends a built frame to a joined client, or queues it while joining. */
  private _send(client: Client, frame: Uint8Array): void {
    if (client._status === "joining") {
      client._queue?.push(frame)
      return
    }
    const connection = client._connection
    if (connection === undefined || client._status === "left") return
    this._requireHost().sendFrame(connection, frame)
    const stats = client._stats
    if (stats !== undefined) {
      stats.framesSent++
      stats.bytesSent += frame.byteLength
    }
  }

  private _deliver(
    client: Client,
    type: number,
    header: readonly number[],
    body: Uint8Array,
  ): void {
    if (client._room !== this || client._connection === undefined) return
    const frame = this._frame(type, [client._roomRef, ...header], body)
    if (frame !== undefined) this._send(client, frame)
  }

  /** Every connected client (but `except`), one frame per distinct roomRef. */
  private _deliverAll(
    type: number,
    header: readonly number[],
    body: Uint8Array,
    except: Client | undefined,
  ): void {
    const recipients: Client[] = []
    for (const client of this.clients.values()) {
      if (client !== except && client._connection !== undefined) {
        recipients.push(client)
      }
    }
    this._sendGrouped(type, header, body, recipients)
  }

  /**
   * Encode once, send to many (spec §8.1.1): clients share a frame when
   * their roomRef matches (in practice, all of them), and joined clients
   * get it through one `transport.broadcast`.
   */
  private _sendGrouped(
    type: number,
    header: readonly number[],
    body: Uint8Array,
    clients: readonly Client[],
  ): void {
    const byRef = new Map<number, Client[]>()
    for (const client of clients) {
      const list = byRef.get(client._roomRef)
      if (list === undefined) byRef.set(client._roomRef, [client])
      else list.push(client)
    }
    const host = this._requireHost()
    for (const [ref, group] of byRef) {
      const frame = this._frame(type, [ref, ...header], body)
      if (frame === undefined) continue
      const connections: Connection[] = []
      for (const client of group) {
        if (client._status === "joining") client._queue?.push(frame)
        else if (
          client._status === "joined" &&
          client._connection !== undefined
        ) {
          connections.push(client._connection)
          const stats = client._stats
          if (stats !== undefined) {
            stats.framesSent++
            stats.bytesSent += frame.byteLength
          }
        }
      }
      if (connections.length === 1 && connections[0] !== undefined) {
        host.sendFrame(connections[0], frame)
      } else if (connections.length > 1) {
        host.broadcastFrame(connections, frame)
      }
    }
  }

  private _encodeBody(value: unknown): Uint8Array | undefined {
    const encoded = this._requireHost().serializer.encode(value)
    if (encoded.isOk()) return encoded.value
    this._requireHost().reportError(encoded.error, {
      source: "send",
      room: this,
    })
    return undefined
  }

  private _encodeMessage(
    name: string,
    message: unknown,
  ): [id: number, body: Uint8Array] | undefined {
    const type = this._requireType()
    const host = this._requireHost()
    const id = type.serverIds.get(name)
    const def = type.serverDefs.get(name)
    if (id === undefined || def === undefined) {
      host.reportError(
        new Error(`"${name}" is not a server message of the room's contract`),
        { source: "send", room: this, messageType: name },
      )
      return undefined
    }
    // Contract messages use the room's codec, like its state (§8.1.1).
    const body = host.stateCodec.encodeMessage(def, message)
    if (body.isErr()) {
      host.reportError(body.error, {
        source: "send",
        room: this,
        messageType: name,
      })
      return undefined
    }
    return [id, body.value]
  }

  private _encodeRaw(type: string, message: unknown): Uint8Array | undefined {
    return this._encodeBody([type, message])
  }

  private _countInbound(client: Client, bytes: number): void {
    const stats = client._stats
    if (stats !== undefined) {
      stats.messagesReceived++
      stats.bytesReceived += bytes
      stats.lastMessageAt = this._requireHost().clock.now()
    }
    if (this._stats !== undefined) this._stats.messages++
  }

  private _dispatch(
    table: Map<string, Set<Handler>>,
    name: string,
    client: Client,
    payload: unknown,
  ): void {
    const host = this._requireHost()
    const handlers = table.get(name)
    if (handlers === undefined || handlers.size === 0) {
      if (!this._unhandled.has(name)) {
        this._unhandled.add(name)
        host.logger.warn(`${this._label()}: no handler for message "${name}"`)
      }
      return
    }
    const context: ErrorContext = {
      source: "onMessage",
      room: this,
      client,
      messageType: name,
    }
    for (const handler of [...handlers]) {
      try {
        const result = handler(client, payload)
        if (result instanceof Promise) {
          result.catch((error: unknown) => host.reportError(error, context))
        }
      } catch (error) {
        host.reportError(error, context)
      }
    }
  }

  // ==========================================================================
  // Internals: helpers
  // ==========================================================================

  /** Runs a synchronous hook; a throw goes to `server.onError`. */
  private _hook(
    source: ErrorSource,
    run: () => void,
    client?: Client,
  ): boolean {
    try {
      run()
      return true
    } catch (error) {
      const context: ErrorContext = { source, room: this }
      if (client !== undefined) context.client = client
      this._requireHost().reportError(error, context)
      return false
    }
  }

  /** Runs an async hook; a throw or rejection goes to `server.onError`. */
  private async _hookAsync(
    source: ErrorSource,
    client: Client | undefined,
    run: () => Promise<void>,
  ): Promise<boolean> {
    try {
      await run()
      return true
    } catch (error) {
      const context: ErrorContext = { source, room: this }
      if (client !== undefined) context.client = client
      this._requireHost().reportError(error, context)
      return false
    }
  }

  private _error(
    code: ErrorCode,
    message: string,
    context?: unknown,
  ): BungohanError {
    const now = this._host?.clock.now() ?? 0
    return new BungohanError(code, message, now, context)
  }

  private _label(): string {
    return `${this.roomType}@${this.id}`
  }

  private _requireHost(): RoomHost {
    return this._host ?? detachedHost()
  }

  private _requireType(): RoomTypeDef {
    return this._type ?? DETACHED_TYPE
  }
}

let detached: RoomHost | undefined

/**
 * Host of a room no server set up (e.g. `new MyRoom()` in a unit test):
 * frames go nowhere and errors are logged, so nothing throws.
 */
function detachedHost(): RoomHost {
  if (detached !== undefined) return detached
  const logger = new Logger()
  detached = {
    clock: new SystemClock(),
    logger,
    serializer: new MessagePackSerializer(),
    stateCodec: new SchemaCodec(),
    store: undefined,
    metrics: undefined,
    simulationTickRate: 60,
    maxCatchUpSteps: 5,
    syncTickRate: 20,
    isShuttingDown: () => false,
    limits: resolveLimits(undefined),
    queuedFor: () => undefined,
    shed: () => {},
    sendFrame: () => {},
    broadcastFrame: () => {},
    reportError: (error, context) =>
      logger.error(`room not set up by a server (${context.source})`, error),
    createId: (size) => nanoid(size),
    seatReleased: () => {},
    roomDisposed: () => {},
  }
  return detached
}

function addHandler(
  table: Map<string, Set<Handler>>,
  type: string,
  handler: Handler,
): () => void {
  let handlers = table.get(type)
  if (handlers === undefined) {
    handlers = new Set()
    table.set(type, handlers)
  }
  handlers.add(handler)
  return () => {
    handlers.delete(handler)
    if (handlers.size === 0 && table.get(type) === handlers) table.delete(type)
  }
}

/**
 * @internal What an `AuthResult` admits with: the object, a copy of
 * `inherited` for `true`, or `undefined` for a refusal (any falsy value,
 * and anything else that isn't a plain object).
 */
export function admission(
  result: unknown,
  inherited: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (result === true) return { ...inherited }
  if (typeof result === "object" && result !== null && !Array.isArray(result)) {
    return result as Record<string, unknown>
  }
  return undefined
}

/** `true` inherits the seat's connection's `auth` (spec §10.1). */
function authOutcome(
  result: unknown,
  client: Client,
  makeError: (code: ErrorCode, message: string) => BungohanError,
): Result<Record<string, unknown>, BungohanError> {
  const auth = admission(result, client.connection?.auth ?? {})
  return auth === undefined
    ? err(makeError("AUTH_FAILED", "authentication failed"))
    : ok(auth)
}

/** Creates a seat for a new session (used by the server and by `Room.join`). */
export function createClient(
  sessionId: string,
  connection?: Connection,
): Client {
  return new Client(sessionId, connection)
}
