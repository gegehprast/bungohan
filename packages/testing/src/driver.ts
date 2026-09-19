/**
 * A test client that speaks the wire protocol (spec §6.7) directly: it
 * builds and parses frames byte by byte, keeps a state replica with
 * `applyDelta`, and decodes contract messages. It stands in for client-js
 * in core's tests, and is a reference for what any client must do.
 */
import { err, ok, type Result } from "@bungohan/result"
import {
  decodeFrame,
  encodeFrame,
  type ISerializer,
  type IStateCodec,
  type IStateCodecSession,
  MessagePackSerializer,
  MessagePackStateCodec,
  packUnknownMessage,
  unpackMessage,
} from "@bungohan/serializer"
import {
  applyDelta,
  type Schema,
  type SchemaConstructor,
  type StateError,
} from "@bungohan/state"
import {
  ClientFrameType,
  type Contract,
  contractHash,
  type EmptyContract,
  type Infer,
  type JoinHandshake,
  JoinMode,
  type RecvMap,
  SERVER_FRAME_HEADERS,
  type SendMap,
  ServerFrameType,
} from "@bungohan/types"
import type { LoopbackSocket } from "./loopback"

/** A failed join: the `JOIN_ERROR` code and message. */
export class JoinFailure extends Error {
  public readonly code: string

  public constructor(code: string, message: string) {
    super(message)
    this.name = "JoinFailure"
    this.code = code
  }
}

export interface JoinOptions<S extends Schema, C extends Contract> {
  /** Replica root class; without it, state frames are counted, not applied. */
  state?: SchemaConstructor<S>
  /** Decodes server messages; its hash goes in the `JOIN` unless overridden. */
  contract?: C
  /** Sent as the `JOIN`'s contract hash. Default: the contract's, or null. */
  contractHash?: string | null
}

export interface DriverOptions {
  serializer?: ISerializer
  stateCodec?: IStateCodec
}

/** A received room message: contract (decoded) or raw. */
export interface ReceivedMessage {
  readonly type: string
  readonly payload: unknown
  readonly raw: boolean
}

interface Pending {
  readonly room: TestRoom<Schema, Contract>
  resolve(result: Result<JoinHandshake, JoinFailure>): void
}

/** One wire-protocol client connection. */
export class TestClient {
  public readonly socket: LoopbackSocket
  /** `ERROR` frames for the connection (roomRef 0): `[code, message]`. */
  public readonly errors: [string, string][] = []
  /** PONG nonces received, in order. */
  public readonly pongs: number[] = []
  /** Every frame received, as raw bytes (for byte-level assertions). */
  public readonly frames: Uint8Array[] = []
  /** Close code, once the connection closed. */
  public closeCode: number | undefined
  private readonly _flush: () => Promise<void>
  private readonly _serializer: ISerializer
  private readonly _codec: IStateCodec
  private readonly _rooms = new Map<number, TestRoom<Schema, Contract>>()
  private readonly _pending = new Map<number, Pending>()
  private _nextRequest = 1

  public constructor(
    socket: LoopbackSocket,
    flush: () => Promise<void>,
    options: DriverOptions = {},
  ) {
    this.socket = socket
    this._flush = flush
    this._serializer = options.serializer ?? new MessagePackSerializer()
    this._codec = options.stateCodec ?? new MessagePackStateCodec()
    socket.onMessage((data) => this._receive(data))
    socket.onClose((code) => {
      this.closeCode = code
    })
  }

  public get connected(): boolean {
    return this.socket.readyState === "open"
  }

  public joinOrCreate<S extends Schema, C extends Contract = EmptyContract>(
    roomType: string,
    options?: unknown,
    join?: JoinOptions<S, C>,
  ): Promise<Result<TestRoom<S, C>, JoinFailure>> {
    return this.request(JoinMode.JOIN_OR_CREATE, roomType, options, join)
  }

  public create<S extends Schema, C extends Contract = EmptyContract>(
    roomType: string,
    options?: unknown,
    join?: JoinOptions<S, C>,
  ): Promise<Result<TestRoom<S, C>, JoinFailure>> {
    return this.request(JoinMode.CREATE, roomType, options, join)
  }

  public join<S extends Schema, C extends Contract = EmptyContract>(
    roomType: string,
    options?: unknown,
    join?: JoinOptions<S, C>,
  ): Promise<Result<TestRoom<S, C>, JoinFailure>> {
    return this.request(JoinMode.JOIN, roomType, options, join)
  }

  public joinById<S extends Schema, C extends Contract = EmptyContract>(
    roomId: string,
    options?: unknown,
    join?: JoinOptions<S, C>,
  ): Promise<Result<TestRoom<S, C>, JoinFailure>> {
    return this.request(JoinMode.JOIN_BY_ID, roomId, options, join)
  }

  public reconnect<S extends Schema, C extends Contract = EmptyContract>(
    token: string,
    join?: JoinOptions<S, C>,
  ): Promise<Result<TestRoom<S, C>, JoinFailure>> {
    return this.request(JoinMode.RECONNECT, token, null, join)
  }

  public consumeReservation<
    S extends Schema,
    C extends Contract = EmptyContract,
  >(
    reservationId: string,
    join?: JoinOptions<S, C>,
  ): Promise<Result<TestRoom<S, C>, JoinFailure>> {
    return this.request(JoinMode.CONSUME_RESERVATION, reservationId, null, join)
  }

  /**
   * Sends a `JOIN` in any mode and flushes the transport, which delivers
   * the reply (async hooks settle within the flush).
   */
  public async request<S extends Schema, C extends Contract>(
    mode: JoinMode,
    target: string,
    options: unknown,
    join: JoinOptions<S, C> = {},
  ): Promise<Result<TestRoom<S, C>, JoinFailure>> {
    const hash =
      join.contractHash !== undefined
        ? join.contractHash
        : join.contract === undefined
          ? null
          : contractHash(join.contract)
    const requestId = this._nextRequest++
    const room = new TestRoom<S, C>(this, join)
    const reply = new Promise<Result<JoinHandshake, JoinFailure>>((resolve) => {
      // Stored type-erased: the room's own methods are what use S and C.
      const erased: unknown = room
      this._pending.set(requestId, {
        room: erased as TestRoom<Schema, Contract>,
        resolve,
      })
    })
    this.sendFrame(
      ClientFrameType.JOIN,
      [requestId],
      [mode, target, options, hash],
    )
    await this._flush()
    const pending = this._pending.get(requestId)
    if (pending !== undefined) {
      this._pending.delete(requestId)
      pending.resolve(err(new JoinFailure("TIMEOUT", "no reply after flush")))
    }
    const handshake = await reply
    return handshake.isErr() ? handshake : ok(room)
  }

  /** Sends `PING(nonce, rtt)`. */
  public ping(nonce: number, rtt = 0): void {
    this.sendFrame(ClientFrameType.PING, [nonce, rtt])
  }

  /** Builds and sends a frame; `body` (if given) goes through the serializer. */
  public sendFrame(type: number, header: number[], body?: unknown): void {
    let bytes: Uint8Array | undefined
    if (body !== undefined) bytes = this._serializer.encode(body).unwrap()
    this.sendBytes(encodeFrame(type, header, bytes).unwrap())
  }

  /** Sends raw bytes as one frame (for malformed-frame tests). */
  public sendBytes(data: Uint8Array): void {
    this.socket.send(data)
  }

  /** Closes the connection and flushes. */
  public async close(code = 1000): Promise<void> {
    this.socket.close(code)
    await this._flush()
  }

  /** @internal */
  public _encode(value: unknown): Uint8Array {
    return this._serializer.encode(value).unwrap()
  }

  /** @internal */
  public _flushNow(): Promise<void> {
    return this._flush()
  }

  /** @internal */
  public _createSession(): IStateCodecSession {
    return this._codec.createSession()
  }

  /** @internal */
  public _forget(ref: number): void {
    this._rooms.delete(ref)
  }

  private _decode(body: Uint8Array): unknown {
    return this._serializer.decode(body).unwrap()
  }

  private _receive(data: Uint8Array): void {
    this.frames.push(data)
    const frame = decodeFrame(data, SERVER_FRAME_HEADERS).unwrap()
    const { type, header, body } = frame
    const first = header[0] ?? 0
    switch (type) {
      case ServerFrameType.JOIN_SUCCESS: {
        const pending = this._pending.get(first)
        if (pending === undefined)
          throw new Error(`unexpected JOIN_SUCCESS ${first}`)
        this._pending.delete(first)
        const ref = header[1] ?? 0
        const handshake = this._decode(body) as JoinHandshake
        pending.room._bind(ref, handshake)
        this._rooms.set(ref, pending.room)
        pending.resolve(ok(handshake))
        return
      }
      case ServerFrameType.JOIN_ERROR: {
        const pending = this._pending.get(first)
        if (pending === undefined)
          throw new Error(`unexpected JOIN_ERROR ${first}`)
        this._pending.delete(first)
        const [code, message] = this._decode(body) as [string, string]
        pending.resolve(err(new JoinFailure(code, message)))
        return
      }
      case ServerFrameType.ERROR: {
        const error = this._decode(body) as [string, string]
        if (first === 0) this.errors.push(error)
        else this._rooms.get(first)?.errors.push(error)
        return
      }
      case ServerFrameType.PONG:
        this.pongs.push(first)
        return
      default: {
        const room = this._rooms.get(first)
        if (room === undefined) {
          throw new Error(`frame ${type} for unknown roomRef ${first}`)
        }
        room._receive(type, header, body, (b) => this._decode(b))
      }
    }
  }
}

/** A joined room, as the driver sees it. */
export class TestRoom<S extends Schema, C extends Contract = EmptyContract> {
  public roomRef = 0
  public roomId = ""
  public roomType = ""
  public sessionId = ""
  public reconnectionToken: string | null = null
  public contractHash = ""
  public stateCodec = ""
  public clientMessages: string[] = []
  public serverMessages: string[] = []
  /** The replica, created fresh by every `STATE_SNAPSHOT`. */
  public state: S | undefined
  public snapshots = 0
  public patches = 0
  public readonly messages: ReceivedMessage[] = []
  /** sessionIds from `CLIENT_JOINED` / `CLIENT_LEFT`. */
  public readonly joined: string[] = []
  public readonly left: string[] = []
  public readonly errors: [string, string][] = []
  public readonly stateErrors: StateError[] = []
  /** Set by the server's `LEAVE`. */
  public leaveCode: number | undefined
  public leaveReason: string | undefined
  private readonly _client: TestClient
  private readonly _options: JoinOptions<S, C>
  private _session: IStateCodecSession | undefined

  public constructor(client: TestClient, options: JoinOptions<S, C>) {
    this._client = client
    this._options = options
  }

  /** Sends a contract message (checked against the client side of `C`). */
  public send<K extends keyof RecvMap<C> & string>(
    type: K,
    payload: Infer<RecvMap<C>[K]>,
  ): void {
    const id = this.clientMessages.indexOf(type)
    const def = this._options.contract?.client[type]
    if (id < 0 || def === undefined) throw new Error(`cannot send "${type}"`)
    const packed = packUnknownMessage(def, payload).unwrap()
    this._client.sendFrame(
      ClientFrameType.ROOM_MESSAGE,
      [this.roomRef, id],
      packed,
    )
  }

  /** Sends a `ROOM_MESSAGE` with an arbitrary id and body (malformed tests). */
  public sendById(messageId: number, body: unknown): void {
    this._client.sendFrame(
      ClientFrameType.ROOM_MESSAGE,
      [this.roomRef, messageId],
      body,
    )
  }

  public sendRaw(type: string, payload: unknown): void {
    this._client.sendFrame(
      ClientFrameType.ROOM_MESSAGE_RAW,
      [this.roomRef],
      [type, payload],
    )
  }

  /** Sends `LEAVE` and flushes (the server acknowledges with `LEAVE(1000)`). */
  public async leave(): Promise<void> {
    this._client.sendFrame(ClientFrameType.LEAVE, [this.roomRef])
    await this._client._flushNow()
  }

  /** Payloads of the received messages of one type. */
  public received<K extends keyof SendMap<C> & string>(
    type: K,
  ): Infer<SendMap<C>[K]>[] {
    return this.messages
      .filter((m) => m.type === type && !m.raw)
      .map((m) => m.payload as Infer<SendMap<C>[K]>)
  }

  /** @internal */
  public _bind(ref: number, handshake: JoinHandshake): void {
    this.roomRef = ref
    ;[
      this.roomId,
      this.roomType,
      this.sessionId,
      this.reconnectionToken,
      this.contractHash,
      this.stateCodec,
      this.clientMessages,
      this.serverMessages,
    ] = handshake
  }

  /** @internal */
  public _receive(
    type: number,
    header: readonly number[],
    body: Uint8Array,
    decode: (body: Uint8Array) => unknown,
  ): void {
    switch (type) {
      case ServerFrameType.STATE_SNAPSHOT:
        // Every snapshot starts a fresh stream (spec §6.7.2).
        this._session = this._client._createSession()
        this.state =
          this._options.state === undefined
            ? undefined
            : new this._options.state()
        this.snapshots++
        this._applyState(body)
        return
      case ServerFrameType.STATE_PATCH:
        if (this.snapshots === 0) throw new Error("patch before snapshot")
        this.patches++
        this._applyState(body)
        return
      case ServerFrameType.ROOM_MESSAGE: {
        const name = this.serverMessages[header[1] ?? -1]
        if (name === undefined) throw new Error("unknown message id")
        const def = this._options.contract?.server[name]
        const wire = decode(body)
        const payload =
          def === undefined ? wire : unpackMessage(def, wire).unwrap()
        this.messages.push({ type: name, payload, raw: false })
        return
      }
      case ServerFrameType.ROOM_MESSAGE_RAW: {
        const [name, payload] = decode(body) as [string, unknown]
        this.messages.push({ type: name, payload, raw: true })
        return
      }
      case ServerFrameType.CLIENT_JOINED:
        this.joined.push(decode(body) as string)
        return
      case ServerFrameType.CLIENT_LEFT:
        this.left.push(decode(body) as string)
        return
      case ServerFrameType.LEAVE:
        this.leaveCode = header[1]
        if (body.byteLength > 0) this.leaveReason = decode(body) as string
        this._client._forget(this.roomRef)
        return
      default:
        throw new Error(`unexpected frame ${type}`)
    }
  }

  private _applyState(body: Uint8Array): void {
    const session = this._session
    if (session === undefined) throw new Error("no codec session")
    const ops = session.decodeOps(body).unwrap()
    if (this.state === undefined) return
    const applied = applyDelta(this.state, ops)
    if (applied.isErr()) this.stateErrors.push(applied.error)
  }
}
