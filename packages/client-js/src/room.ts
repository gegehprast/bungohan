/**
 * A joined room, client side (spec §7.2, §7.3). Created by
 * `BungohanClient`; frames reach it already parsed and routed by roomRef.
 */
import { err, ok, type Result } from "@bungohan/result"
import type {
  ISerializer,
  IStateCodec,
  IStateCodecSession,
} from "@bungohan/serializer"
import {
  applyDelta,
  reachableSchemaClasses,
  Schema,
  type SchemaConstructor,
  SchemaRegistry,
} from "@bungohan/state"
import {
  ClientFrameType,
  type Contract,
  type EmptyContract,
  type Infer,
  type JoinHandshake,
  LeaveCode,
  type RecvMap,
  type SendMap,
  ServerFrameType,
} from "@bungohan/types"
import { ClientError } from "./errors"

/**
 * Where a room is in its life (`room.status`). A room you get from a join
 * is already `"joined"`.
 */
export type RoomStatus =
  /** `JOIN_SUCCESS` received, waiting for the first `STATE_SNAPSHOT`. */
  | "joining"
  /** In the room, with its state. */
  | "joined"
  /** The connection dropped; the seat is being resumed with the token. */
  | "reconnecting"
  /** Left for good; see the `onLeave` code for why. */
  | "left"

/**
 * The last argument of every join, `{ state, contract }`: runtime inputs
 * that also drive type inference, so the joined room is fully typed
 * (`IRoom<State, typeof contract>`) with no type arguments to write.
 */
export interface JoinOptions<S extends Schema, C extends Contract> {
  /**
   * The room state's root class. The replica (`room.state`) is built from
   * it. Without it, state frames are decoded (the stream stays in step)
   * but not applied, and `room.state` is an empty `Schema`.
   */
  state?: SchemaConstructor<S>
  /**
   * The room's message contract (`defineContract`), the same object the
   * server uses. It types `send`/`onMessage` (direction inverted), packs and
   * unpacks payloads, and its hash is sent with the join, so a stale
   * client fails with `CONTRACT_MISMATCH` instead of mis-decoding. Without
   * it the hash is `null` (no check) and only `*Raw` messages work.
   */
  contract?: C
}

/** Events for {@link IRoom.removeListener}. */
export type RoomEvent =
  | "message"
  | "messageRaw"
  | "stateChange"
  | "leave"
  | "error"
  | "clientJoin"
  | "clientLeave"

/**
 * Registers listeners on a replica and returns what undoes them (or
 * nothing). See {@link IRoom.listen}.
 */
export type StateAttacher<S> = (state: S) => (() => void) | undefined

/**
 * A room this client has joined, from any of the client's join methods.
 * `S` is the state class and `C` the contract, both inferred from the
 * join's `{ state, contract }`.
 *
 * Every `on*` method returns a function that removes that listener, and
 * every listener is removed right after the room is left, so a left room
 * needs no clean-up. Nothing here throws; `send` and `leave` return a
 * `Result`.
 */
export interface IRoom<
  S extends Schema = Schema,
  C extends Contract = EmptyContract,
> {
  /** The room's id, the same on every client (e.g. for `joinById`). */
  readonly id: string
  /**
   * This client's seat in the room: the `client.sessionId` the server
   * sees, and the key other clients see it under (in `onClientJoin`, and
   * in whatever player map your state keeps). Kept across reconnections.
   */
  readonly sessionId: string
  /** The name the room type was defined under on the server. */
  readonly roomType: string
  /**
   * The replica. A fresh object after every `STATE_SNAPSHOT` (a join, a
   * reconnect, or the server replacing its state): hold on to `room`,
   * not to `room.state`. Use {@link listen} for listeners that survive.
   */
  readonly state: Readonly<S>
  /** Current token; replaced on every (re)join. Undefined if not allowed. */
  readonly reconnectionToken: string | undefined
  /**
   * Where the room is in its life. `"reconnecting"` while the connection
   * is being retried (messages can't be sent), `"left"` for good.
   */
  readonly status: RoomStatus

  /**
   * Sends a contract message (one of the contract's `client` messages),
   * typed and encoded against its declaration. Fails with `NOT_CONNECTED`
   * while reconnecting (nothing is queued), `NOT_JOINED` once left,
   * `UNKNOWN_MESSAGE` for a name the server's contract doesn't have, or
   * `ENCODE_FAILED` for a payload that got past the types.
   */
  send<K extends keyof RecvMap<C> & string>(
    type: K,
    message: Infer<RecvMap<C>[K]>,
  ): Result<void, ClientError>
  /** Sends an untyped MessagePack message (the server's `onMessageRaw`). */
  sendRaw(type: string, message: unknown): Result<void, ClientError>
  /** Leaves the room (a consented `LEAVE`) and removes every listener. */
  leave(): Promise<Result<void, ClientError>>

  /**
   * A contract message from the server (one of the contract's `server`
   * messages), decoded and typed. Messages that arrived with the join,
   * before you could register, are kept (up to 64) and delivered to the
   * first handler registered for them, on a later turn.
   */
  onMessage<K extends keyof SendMap<C> & string>(
    type: K,
    cb: (message: Infer<SendMap<C>[K]>) => void,
  ): () => void
  /** Every raw message (`sendRaw`/`broadcastRaw` on the server). */
  onMessageRaw(cb: (type: string, message: unknown) => void): () => void
  /** After every applied state frame (snapshot or patch). */
  onStateChange(cb: (state: S) => void): () => void
  /**
   * Registers state listeners that survive replica resets. `attach` runs
   * now (if the room has state) and again on every fresh replica, *before*
   * its snapshot is applied, so snapshot content arrives through the
   * listeners it registers (`onAdd` per element, `onChange` per non-zero
   * root field). What it returns runs when that replica is discarded, when
   * the room is left, or when the returned function is called.
   */
  listen(attach: StateAttacher<S>): () => void
  /** The room was left; `code` is a `LeaveCode`. Listeners go after it. */
  onLeave(cb: (code: number) => void): () => void
  /** An `ERROR` frame for this room, or a local failure (desync, …). */
  onError(cb: (code: string, message: string) => void): () => void
  /**
   * Another client took a seat in the room (not this client itself). For
   * who is playing, prefer the room's state, which also covers clients
   * already there when you joined.
   */
  onClientJoin(cb: (client: { sessionId: string }) => void): () => void
  /** Another client's seat was released: it left, or its hold expired. */
  onClientLeave(cb: (client: { sessionId: string }) => void): () => void

  /**
   * Removes every listener, including {@link listen} attachments (their
   * clean-up runs). Leaving the room does this for you.
   */
  removeAllListeners(): void
  /**
   * Removes one listener by the function it was registered with (for
   * `"message"`, from every message type). Calling the function the `on*`
   * method returned does the same and is usually simpler.
   */
  removeListener(event: RoomEvent, callback: (...args: never[]) => void): void
}

/** What a room needs from its client. */
export interface RoomHost {
  readonly serializer: ISerializer
  /** Builds and sends a frame on the current connection. */
  sendFrame(
    type: number,
    header: readonly number[],
    body?: Uint8Array,
  ): Result<void, ClientError>
  /** The room is gone locally (left, kicked, …): forget it. */
  forget(room: RoomLink): void
  /** The replica is out of step with the server: re-sync the connection. */
  desync(room: RoomLink, error: Error): void
  /** Runs `fn` on a later turn of the client's clock (a 0 ms timer). */
  defer(fn: () => void): void
  warn(message: string, detail?: unknown): void
  error(message: string, detail?: unknown): void
}

/**
 * @internal A room as the client holds it: type-erased (any state, any
 * contract), plus the hooks the client drives it through.
 */
export interface RoomLink extends IRoom<Schema, Contract> {
  readonly _ref: number
  readonly _hash: string | null
  readonly snapshots: number
  _bind(ref: number, handshake: JoinHandshake, codec: IStateCodec): void
  _suspend(): void
  _receive(type: number, header: readonly number[], body: Uint8Array): void
  _leaveNow(): Result<void, ClientError>
  _left(code: number): void
  _fail(code: string, message: string): void
}

/** Replica root for rooms joined without a state class. Never applied to. */
class NoState extends Schema {
  public static override schemaName = "bungohan.client.NoState"
}

interface Attachment<S> {
  readonly attach: StateAttacher<S>
  detach: (() => void) | undefined
}

type Listener = (...args: never[]) => void

/** A pre-join event no handler took yet (see `Room._release`). */
type Unclaimed =
  | {
      readonly kind: "message" | "raw"
      readonly type: string
      readonly payload: unknown
    }
  | { readonly kind: "clientJoin" | "clientLeave"; readonly sessionId: string }
  | { readonly kind: "error"; readonly code: string; readonly message: string }

/** Classes reachable from each state class, walked once per class. */
const reachable = new WeakMap<SchemaConstructor, SchemaConstructor[]>()

/**
 * Registers every Schema class reachable from `stateClass` (nested fields,
 * collection element classes), so classes the client only ever receives
 * resolve by name without a manual `SchemaRegistry.register`.
 */
function registerReachable(stateClass: SchemaConstructor): void {
  let classes = reachable.get(stateClass)
  if (classes === undefined) {
    classes = reachableSchemaClasses(stateClass)
    reachable.set(stateClass, classes)
  }
  SchemaRegistry.register(...classes)
}

/** At most this many unclaimed pre-join events are kept (oldest dropped). */
const MAX_UNCLAIMED = 64

/**
 * The `IRoom` implementation the client creates for each join. Type your
 * code against `IRoom`.
 */
export class Room<S extends Schema = Schema, C extends Contract = EmptyContract>
  implements IRoom<S, C>, RoomLink
{
  public id = ""
  public sessionId = ""
  public roomType = ""
  public reconnectionToken: string | undefined = undefined
  /** The server's contract hash, from the handshake. */
  public contractHash = ""
  /** The room's state codec, by name, from the handshake. */
  public stateCodec = ""
  /** @internal Current per-connection handle; changes on reconnect. */
  public _ref = 0
  private _status: RoomStatus = "joining"
  private readonly _host: RoomHost
  private readonly _stateClass: SchemaConstructor<S> | undefined
  private readonly _contract: C | undefined
  private _codec: IStateCodec | undefined
  private _state: Schema
  private _session: IStateCodecSession | undefined
  private _snapshots = 0
  private _clientIds = new Map<string, number>()
  private _serverNames: readonly string[] = []
  /**
   * Frames held from a first join's `JOIN_SUCCESS` until just after the
   * join has been returned (see `_receive`). Undefined when not holding.
   */
  private _held: [number, readonly number[], Uint8Array][] | undefined
  /** True while held frames are being handled. */
  private _releasing = false
  private readonly _unclaimed: Unclaimed[] = []

  private readonly _messages = new Map<string, Set<(message: never) => void>>()
  private readonly _raw = new Set<(type: string, message: unknown) => void>()
  private readonly _stateChange = new Set<(state: S) => void>()
  private readonly _leave = new Set<(code: number) => void>()
  private readonly _error = new Set<(code: string, message: string) => void>()
  private readonly _clientJoin = new Set<(c: { sessionId: string }) => void>()
  private readonly _clientLeave = new Set<(c: { sessionId: string }) => void>()
  private readonly _attachments = new Set<Attachment<S>>()

  /** @internal The contract hash sent with the join (and with resumes). */
  public readonly _hash: string | null

  public constructor(
    host: RoomHost,
    options: JoinOptions<S, C>,
    hash: string | null,
  ) {
    this._host = host
    this._hash = hash
    this._stateClass = options.state
    this._contract = options.contract
    this._state = this._newReplica()
  }

  public get state(): Readonly<S> {
    // Without a state class, S is unconstrained by any runtime value and
    // the replica is an empty NoState (see JoinOptions.state).
    return this._state as S
  }

  public get status(): RoomStatus {
    return this._status
  }

  /** Snapshots received (1 after the join; +1 per reset). */
  public get snapshots(): number {
    return this._snapshots
  }

  // --- sending -------------------------------------------------------------

  public send<K extends keyof RecvMap<C> & string>(
    type: K,
    message: Infer<RecvMap<C>[K]>,
  ): Result<void, ClientError> {
    const usable = this._usable()
    if (usable.isErr()) return usable
    const id = this._clientIds.get(type)
    const def = this._contract?.client[type]
    if (id === undefined || def === undefined) {
      return err(
        new ClientError(
          "UNKNOWN_MESSAGE",
          `"${type}" is not a client message of this room's contract`,
        ),
      )
    }
    // Contract messages use the room's codec (PROTOCOL.md §6.4).
    const codec = this._codec
    if (codec === undefined) {
      return err(new ClientError("NOT_JOINED", "the room has no codec yet"))
    }
    const encoded = codec.encodeMessage(def, message)
    if (encoded.isErr()) {
      return err(new ClientError("ENCODE_FAILED", encoded.error.message))
    }
    return this._host.sendFrame(
      ClientFrameType.ROOM_MESSAGE,
      [this._ref, id],
      encoded.value,
    )
  }

  public sendRaw(type: string, message: unknown): Result<void, ClientError> {
    const usable = this._usable()
    if (usable.isErr()) return usable
    return this._sendBody(
      ClientFrameType.ROOM_MESSAGE_RAW,
      [this._ref],
      ok([type, message]),
    )
  }

  public leave(): Promise<Result<void, ClientError>> {
    return Promise.resolve(this._leaveNow())
  }

  /**
   * @internal `leave()`, synchronously: the LEAVE frame is on the socket
   * when this returns. Page-exit handlers depend on that (spec §7.5): the
   * browser may tear the page down before any promise continuation runs.
   */
  public _leaveNow(): Result<void, ClientError> {
    if (this._status === "left") {
      return err(new ClientError("NOT_JOINED", "already left"))
    }
    // Consented leave: the room counts as left once LEAVE is sent (spec
    // §6.7.5); the server's LEAVE(1000) acknowledgement is not awaited.
    // While reconnecting there is no connection to send it on, and the
    // seat is simply not resumed.
    if (this._status !== "reconnecting" && this._ref !== 0) {
      this._host.sendFrame(ClientFrameType.LEAVE, [this._ref])
    }
    this._left(LeaveCode.CONSENTED)
    return ok(undefined)
  }

  // --- listeners -----------------------------------------------------------

  public onMessage<K extends keyof SendMap<C> & string>(
    type: K,
    cb: (message: Infer<SendMap<C>[K]>) => void,
  ): () => void {
    let set = this._messages.get(type)
    if (set === undefined) {
      set = new Set()
      this._messages.set(type, set)
    }
    set.add(cb)
    this._claim((event) => event.kind === "message" && event.type === type)
    return () => set.delete(cb)
  }

  public onMessageRaw(cb: (type: string, message: unknown) => void) {
    const off = add(this._raw, cb)
    this._claim((event) => event.kind === "raw")
    return off
  }

  public onStateChange(cb: (state: S) => void): () => void {
    return add(this._stateChange, cb)
  }

  public listen(attach: StateAttacher<S>): () => void {
    const attachment: Attachment<S> = { attach, detach: undefined }
    this._attachments.add(attachment)
    if (this._snapshots > 0 && this._status !== "left") {
      this._attach(attachment)
    }
    return () => {
      if (!this._attachments.delete(attachment)) return
      this._detach(attachment)
    }
  }

  public onLeave(cb: (code: number) => void): () => void {
    return add(this._leave, cb)
  }

  public onError(cb: (code: string, message: string) => void): () => void {
    const off = add(this._error, cb)
    this._claim((event) => event.kind === "error")
    return off
  }

  public onClientJoin(cb: (client: { sessionId: string }) => void) {
    const off = add(this._clientJoin, cb)
    this._claim((event) => event.kind === "clientJoin")
    return off
  }

  public onClientLeave(cb: (client: { sessionId: string }) => void) {
    const off = add(this._clientLeave, cb)
    this._claim((event) => event.kind === "clientLeave")
    return off
  }

  public removeAllListeners(): void {
    this._messages.clear()
    this._raw.clear()
    this._stateChange.clear()
    this._leave.clear()
    this._error.clear()
    this._clientJoin.clear()
    this._clientLeave.clear()
    this._unclaimed.length = 0
    for (const attachment of this._attachments) this._detach(attachment)
    this._attachments.clear()
  }

  public removeListener(event: RoomEvent, callback: Listener): void {
    const sets: Record<RoomEvent, Iterable<Set<Listener>>> = {
      message: this._messages.values(),
      messageRaw: [this._raw],
      stateChange: [this._stateChange],
      leave: [this._leave],
      error: [this._error],
      clientJoin: [this._clientJoin],
      clientLeave: [this._clientLeave],
    }
    for (const set of sets[event]) set.delete(callback)
  }

  // --- driven by the client ------------------------------------------------

  /** @internal Adopts a `JOIN_SUCCESS` handshake (a join or a resume). */
  public _bind(
    ref: number,
    handshake: JoinHandshake,
    codec: IStateCodec,
  ): void {
    this._codec = codec
    const [id, roomType, sessionId, token, hash, codecName, client, server] =
      handshake
    this._ref = ref
    this.id = id
    this.roomType = roomType
    this.sessionId = sessionId
    this.reconnectionToken = token ?? undefined
    this.contractHash = hash
    this.stateCodec = codecName
    this._clientIds = new Map(client.map((name, index) => [name, index]))
    this._serverNames = server
    // A first join holds its frames; a resumed seat already has handlers.
    if (this._snapshots === 0) this._held = []
    // Nothing for this room may be decoded against the old stream: the
    // next state frame is a snapshot, which starts a new session.
    this._session = undefined
    if (this._status === "reconnecting") this._status = "joining"
  }

  /** @internal The connection dropped; the seat will be resumed. */
  public _suspend(): void {
    if (this._status !== "left") this._status = "reconnecting"
  }

  /**
   * @internal Handles one frame for this room.
   *
   * On a first join, messages can arrive between `JOIN_SUCCESS` and the
   * snapshot (e.g. a `send` in the server's `onJoin`), before the caller
   * has the room and could register a handler. So from `JOIN_SUCCESS` on,
   * frames are held, in order, except the first snapshot (which completes
   * the join) and a `LEAVE` before it (which fails the join). The held
   * frames are handled on the client clock's next turn, after the code
   * awaiting the join has registered its handlers. An event among them
   * that still finds no handler (e.g. React subscribes in an effect, which
   * may run later) is kept, and delivered to the first handler registered
   * for it.
   */
  public _receive(
    type: number,
    header: readonly number[],
    body: Uint8Array,
  ): void {
    const held = this._held
    if (held !== undefined) {
      const first =
        this._snapshots === 0 &&
        (type === ServerFrameType.STATE_SNAPSHOT ||
          type === ServerFrameType.LEAVE)
      if (!first) {
        held.push([type, header, body])
        return
      }
      if (type === ServerFrameType.STATE_SNAPSHOT) {
        this._host.defer(() => this._release())
      }
    }
    this._handle(type, header, body)
  }

  private _release(): void {
    const held = this._held
    this._held = undefined
    this._releasing = true
    try {
      for (const [type, header, body] of held ?? []) {
        if (this._status === "left") return
        this._handle(type, header, body)
      }
    } finally {
      this._releasing = false
    }
  }

  /**
   * Delivers an event to its listeners. With none, a pre-join event is
   * kept for a later handler; any other is reported as unhandled.
   */
  private _offer(event: Unclaimed): void {
    if (this._dispatch(event)) return
    if (this._releasing) {
      if (this._unclaimed.push(event) > MAX_UNCLAIMED) this._unclaimed.shift()
    } else if (event.kind === "message") {
      this._host.warn(`no onMessage handler for "${event.type}"`)
    }
  }

  /** False if the event has no listeners. */
  private _dispatch(event: Unclaimed): boolean {
    switch (event.kind) {
      case "message": {
        const set = this._messages.get(event.type)
        if (set === undefined || set.size === 0) return false
        this._emit(set, event.payload as never)
        return true
      }
      case "raw":
        if (this._raw.size === 0) return false
        this._emit(this._raw, event.type, event.payload)
        return true
      case "clientJoin":
      case "clientLeave": {
        const set =
          event.kind === "clientJoin" ? this._clientJoin : this._clientLeave
        if (set.size === 0) return false
        this._emit(set, { sessionId: event.sessionId })
        return true
      }
      case "error":
        if (this._error.size === 0) return false
        this._emit(this._error, event.code, event.message)
        return true
    }
  }

  /** A handler was registered: hand it the kept events it takes, later. */
  private _claim(takes: (event: Unclaimed) => boolean): void {
    if (this._unclaimed.length === 0) return
    const claimed = this._unclaimed.filter(takes)
    if (claimed.length === 0) return
    const rest = this._unclaimed.filter((event) => !takes(event))
    this._unclaimed.splice(0, this._unclaimed.length, ...rest)
    // Not inside the registering call: its caller doesn't even hold the
    // unsubscribe function yet.
    this._host.defer(() => {
      for (const event of claimed) {
        if (this._status === "left") return
        this._dispatch(event)
      }
    })
  }

  private _handle(
    type: number,
    header: readonly number[],
    body: Uint8Array,
  ): void {
    switch (type) {
      case ServerFrameType.STATE_SNAPSHOT:
        this._snapshot(body)
        return
      case ServerFrameType.STATE_PATCH:
        this._patch(body)
        return
      case ServerFrameType.ROOM_MESSAGE:
        this._message(header[1] ?? -1, body)
        return
      case ServerFrameType.ROOM_MESSAGE_RAW: {
        const decoded = this._decodeArray(body, 2, "ROOM_MESSAGE_RAW")
        if (decoded === undefined) return
        const [name, payload] = decoded
        if (typeof name !== "string") {
          this._host.warn("dropped raw message: type is not a string")
          return
        }
        this._offer({ kind: "raw", type: name, payload })
        return
      }
      case ServerFrameType.CLIENT_JOINED:
      case ServerFrameType.CLIENT_LEFT: {
        const sessionId = this._decode(body)
        if (typeof sessionId !== "string") {
          this._host.warn(`dropped frame ${type}: sessionId not a string`)
          return
        }
        const kind =
          type === ServerFrameType.CLIENT_JOINED ? "clientJoin" : "clientLeave"
        this._offer({ kind, sessionId })
        return
      }
      case ServerFrameType.LEAVE: {
        // No frame for this roomRef follows a LEAVE (spec §6.7.5).
        this._left(header[1] ?? LeaveCode.KICKED)
        return
      }
      case ServerFrameType.ERROR: {
        const decoded = this._decodeArray(body, 2, "ERROR")
        if (decoded === undefined) return
        const [code, message] = decoded
        this._fail(String(code), String(message))
        return
      }
      default:
        this._host.warn(`dropped frame ${type}: not a room frame`)
    }
  }

  /**
   * @internal The room is over locally: fires `onLeave(code)`, then removes
   * every listener (spec §7.2) and tells the client to forget it.
   */
  public _left(code: number): void {
    if (this._status === "left") return
    this._status = "left"
    this._held = undefined
    this._host.forget(this)
    this._emit(this._leave, code)
    this.removeAllListeners()
  }

  /** @internal Reports an error to the room's `onError` listeners. */
  public _fail(code: string, message: string): void {
    this._emit(this._error, code, message)
  }

  // --- internals -----------------------------------------------------------

  private _usable(): Result<void, ClientError> {
    switch (this._status) {
      case "left":
        return err(new ClientError("NOT_JOINED", "the room has been left"))
      case "reconnecting":
        return err(new ClientError("NOT_CONNECTED", "reconnecting"))
      default:
        return ok(undefined)
    }
  }

  private _sendBody(
    type: number,
    header: readonly number[],
    body: Result<unknown, Error>,
  ): Result<void, ClientError> {
    if (body.isErr()) {
      return err(new ClientError("ENCODE_FAILED", body.error.message))
    }
    const encoded = this._host.serializer.encode(body.value)
    if (encoded.isErr()) {
      return err(new ClientError("ENCODE_FAILED", encoded.error.message))
    }
    return this._host.sendFrame(type, header, encoded.value)
  }

  private _newReplica(): Schema {
    if (this._stateClass === undefined) return new NoState()
    registerReachable(this._stateClass)
    return new this._stateClass()
  }

  /** Every snapshot starts a fresh stream: new session, new replica. */
  private _snapshot(body: Uint8Array): void {
    for (const attachment of this._attachments) this._detach(attachment)
    if (this._codec === undefined) {
      this._desync(new ClientError("DESYNC", "STATE_SNAPSHOT before join"))
      return
    }
    this._session = this._codec.createSession()
    this._state = this._newReplica()
    this._snapshots++
    if (this._status === "joining") this._status = "joined"
    for (const attachment of this._attachments) this._attach(attachment)
    this._applyState(body)
  }

  private _patch(body: Uint8Array): void {
    if (this._session === undefined) {
      this._desync(new ClientError("DESYNC", "STATE_PATCH before a snapshot"))
      return
    }
    this._applyState(body)
  }

  private _applyState(body: Uint8Array): void {
    const session = this._session
    if (session === undefined) return
    const ops = session.decodeOps(body)
    if (ops.isErr()) {
      this._desync(new ClientError("DESYNC", ops.error.message))
      return
    }
    if (this._stateClass !== undefined) {
      const applied = applyDelta(this._state, ops.value, {
        onUnknownClass: (name) => this._unknownClass(name),
      })
      if (applied.isErr()) {
        this._desync(
          new ClientError("DESYNC", applied.error.message, applied.error),
        )
        return
      }
    }
    this._emit(this._stateChange, this._state as S)
  }

  /**
   * An instance of a class with no registered local class was left out of
   * the replica (spec §5.7.2). Loud, since the replica now lacks data:
   * logged, and reported through `onError`, kept for the first handler if
   * it happened while joining (before the caller had the room).
   */
  private _unknownClass(name: string): void {
    const message =
      `the server sent "${name}", a Schema class this client has not ` +
      "registered; its instances are missing from room.state. Declare it " +
      "reachably from the join's state class, or SchemaRegistry.register() it"
    this._host.error(`room ${this.roomType}: ${message}`)
    const event: Unclaimed = { kind: "error", code: "UNKNOWN_CLASS", message }
    if (this._dispatch(event)) return
    if (this._held !== undefined || this._releasing) {
      if (this._unclaimed.push(event) > MAX_UNCLAIMED) this._unclaimed.shift()
    }
  }

  private _desync(error: ClientError): void {
    this._session = undefined
    this._fail(error.code, error.message)
    this._host.desync(this, error)
  }

  private _message(id: number, body: Uint8Array): void {
    // Ids resolve by name through the handshake's table (spec §4.2); an
    // id or name this client can't map is dropped, not fatal (§6.7.7).
    const name = this._serverNames[id]
    if (name === undefined) {
      this._host.warn(`dropped message: unknown message id ${id}`)
      return
    }
    const def = this._contract?.server[name]
    if (def === undefined) {
      this._host.warn(`dropped message "${name}": not in the client contract`)
      return
    }
    const codec = this._codec
    if (codec === undefined) {
      this._host.warn(`dropped message "${name}": the room has no codec yet`)
      return
    }
    const payload = codec.decodeMessage(def, body)
    if (payload.isErr()) {
      this._host.warn(`dropped message "${name}": ${payload.error.message}`)
      return
    }
    this._offer({ kind: "message", type: name, payload: payload.value })
  }

  private _decode(body: Uint8Array): unknown {
    const decoded = this._host.serializer.decode(body)
    if (decoded.isErr()) {
      this._host.warn(`dropped frame: ${decoded.error.message}`)
      return undefined
    }
    return decoded.value
  }

  /** The known leading elements of an array body (spec §6.7.7 rule 1). */
  private _decodeArray(
    body: Uint8Array,
    count: number,
    what: string,
  ): unknown[] | undefined {
    const value = this._decode(body)
    if (!Array.isArray(value) || value.length < count) {
      this._host.warn(`dropped ${what}: expected an array of ${count}+`)
      return undefined
    }
    return value.slice(0, count)
  }

  private _attach(attachment: Attachment<S>): void {
    try {
      attachment.detach = attachment.attach(this._state as S) ?? undefined
    } catch (error) {
      this._host.error("listen() attach threw", error)
    }
  }

  private _detach(attachment: Attachment<S>): void {
    const detach = attachment.detach
    attachment.detach = undefined
    if (detach === undefined) return
    try {
      detach()
    } catch (error) {
      this._host.error("listen() cleanup threw", error)
    }
  }

  /** Calls every listener; one that throws is logged, not propagated. */
  private _emit<A extends unknown[]>(
    set: Iterable<(...args: A) => void>,
    ...args: A
  ): void {
    for (const listener of [...set]) {
      try {
        listener(...args)
      } catch (error) {
        this._host.error("room listener threw", error)
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
