import { err, ok, type Result } from "@bungohan/result"
import {
  decodeFrame,
  encodeFrame,
  type ISerializer,
  type IStateCodec,
  MessagePackSerializer,
  SchemaCodec,
} from "@bungohan/serializer"
import { type IStore, RedisStore } from "@bungohan/store"
import {
  clipCloseReason,
  type ITransport,
  WebSocketTransport,
} from "@bungohan/transport"
import {
  CLIENT_FRAME_HEADERS,
  ClientFrameType,
  type Clock,
  CloseCode,
  JoinMode,
  type JoinRequest,
  LeaveCode,
  PROTOCOL_VERSION,
  ServerFrameType,
  SystemClock,
  type TimerId,
} from "@bungohan/types"
import { nanoid } from "nanoid"
import { Client, Connection } from "./client"
import { BungohanError, type ErrorCode } from "./errors"
import { HttpServer } from "./http"
import { Logger } from "./logger"
import { MatchMaker, setMatchMaker } from "./matchmaker"
import {
  type ClientMetrics,
  MetricsCollector,
  type RoomMetrics,
  type ServerMetrics,
} from "./metrics"
import { Room, type RoomHost } from "./room"
import { RoomManager } from "./room-manager"
import type { RoomTypeDef } from "./room-type"
import type {
  DefineRoomOptions,
  ErrorContext,
  RoomClass,
  ServerOptions,
} from "./types"

const DEFAULT_PORT = 6060

type Callback<A extends unknown[]> = (...args: A) => void

interface Joined {
  readonly room: Room
  readonly client: Client
  readonly reconnected: boolean
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

/**
 * A `JOIN` body (spec §6.7.3), or undefined if it has the wrong shape.
 * Trailing elements past the known four are ignored (spec §6.7.7), so a
 * newer client can add fields without breaking this server.
 */
function parseJoin(value: unknown): JoinRequest | undefined {
  if (!Array.isArray(value) || value.length < 2) return undefined
  const [mode, target, options, hash] = value
  if (
    typeof mode !== "number" ||
    !Number.isInteger(mode) ||
    mode < JoinMode.JOIN_OR_CREATE ||
    mode > JoinMode.CONSUME_RESERVATION ||
    typeof target !== "string" ||
    (hash !== undefined && hash !== null && typeof hash !== "string")
  ) {
    return undefined
  }
  return [mode as JoinRequest[0], target, options ?? {}, hash ?? null]
}

/**
 * The game server (spec §6.1): owns the transport, the connections, the
 * rooms and the matchmaker, and speaks the §6.7 wire protocol.
 */
export class BungohanServer {
  private readonly _options: ServerOptions
  private readonly _clock: Clock
  private readonly _logger: Logger
  private readonly _serializer: ISerializer
  private readonly _stateCodec: IStateCodec
  private readonly _transport: ITransport
  private readonly _store: IStore | undefined
  private readonly _ownsStore: boolean
  private readonly _metrics: MetricsCollector | undefined
  private readonly _processId: string
  private readonly _manager: RoomManager
  private readonly _matchMaker: MatchMaker
  private readonly _host: RoomHost
  private readonly _connections = new Map<string, Connection>()
  private readonly _onConnect = new Set<Callback<[Connection]>>()
  private readonly _onJoin = new Set<Callback<[Client, Room]>>()
  private readonly _onLeave = new Set<Callback<[Client, Room, boolean]>>()
  private readonly _onError = new Set<Callback<[Error, ErrorContext]>>()
  private _http: HttpServer | undefined
  private _running = false
  private _shuttingDown = false
  private _signalled = false
  private _startedAt = 0

  public constructor(options: ServerOptions = {}) {
    this._options = options
    this._clock = options.clock ?? new SystemClock()
    this._logger = new Logger(options.logger)
    this._serializer = options.serializer ?? new MessagePackSerializer()
    this._stateCodec = options.stateCodec ?? new SchemaCodec()
    const config = options.transport?.config ?? {}
    this._transport =
      options.transport?.provider ??
      new WebSocketTransport({
        ...(config.maxPayloadLength !== undefined && {
          maxPayloadLength: config.maxPayloadLength,
        }),
        ...(config.idleTimeout !== undefined && {
          idleTimeout: config.idleTimeout,
        }),
        ...(config.compression !== undefined && {
          compression: config.compression,
        }),
        ...(config.compressionThreshold !== undefined && {
          compressionThreshold: config.compressionThreshold,
        }),
      })
    if (options.store?.provider !== undefined) {
      this._store = options.store.provider
      this._ownsStore = false
    } else if (options.store?.config !== undefined) {
      this._store = new RedisStore(options.store.config)
      this._ownsStore = true
    } else {
      this._store = undefined
      this._ownsStore = false
    }
    this._metrics =
      options.metrics?.enabled === true
        ? new MetricsCollector(this._clock)
        : undefined
    this._processId = options.cluster?.processId ?? nanoid(10)
    this._host = this._createHost()
    this._manager = new RoomManager(this._host, (error) =>
      this._report(error, { source: "callback" }),
    )
    this._matchMaker = new MatchMaker({
      manager: this._manager,
      clock: this._clock,
      processId: this._processId,
      clusterEnabled: options.cluster?.enabled === true,
      createId: (size) => nanoid(size),
    })
    setMatchMaker(this._matchMaker)
  }

  // ==========================================================================
  // Setup and lifecycle
  // ==========================================================================

  /**
   * Registers a room type. **Throws** (a `TypeError` listing every problem)
   * if the room's contract or any Schema class reachable from its state is
   * malformed, or if the name is taken: a definition-time error (spec §6.8).
   */
  public defineRoomType<R extends Room>(
    name: string,
    RoomClass: RoomClass<R>,
    options?: DefineRoomOptions,
  ): void {
    this._matchMaker.registerRoomType(name, RoomClass, options)
  }

  public async start(): Promise<Result<void, BungohanError>> {
    if (this._running) {
      return err(this._error("INVALID_STATE", "already running"))
    }
    if (this._options.cluster?.enabled === true) {
      return err(
        this._error(
          "CLUSTER_NOT_IMPLEMENTED",
          "cluster mode (spec §6.4) is not implemented yet",
        ),
      )
    }
    const transport = this._transport
    transport.acceptProtocols([PROTOCOL_VERSION])
    transport.onConnection?.((id, context) =>
      this._handleConnection(id, context),
    )
    transport.onMessage?.((id, data) => this._handleFrame(id, data))
    transport.onDisconnect?.((id) => this._handleDisconnect(id))
    transport.onError?.((error) => this._report(error, { source: "transport" }))
    const port = this._options.transport?.config?.port ?? DEFAULT_PORT
    const listening = await transport.listen(port)
    if (listening.isErr()) {
      return err(
        this._error(
          "CONNECTION_FAILED",
          listening.error.message,
          listening.error,
        ),
      )
    }
    const http = this._options.http
    if (http?.enabled === true) {
      this._http = new HttpServer(
        {
          port: http.port ?? 8080,
          hostname: http.hostname ?? "0.0.0.0",
          cors: http.cors ?? true,
          enableMetrics: http.enableMetrics ?? true,
          enableHealthCheck: http.enableHealthCheck ?? true,
          enableRoomsList: http.enableRoomsList ?? true,
        },
        {
          health: () => ({
            status: this._shuttingDown ? "shutting_down" : "ok",
            processId: this._processId,
            uptime: (this._clock.now() - this._startedAt) / 1000,
            rooms: this._manager.getRoomCount(),
            connections: this._connections.size,
          }),
          metrics: () => {
            const server = this.getServerMetrics()
            if (server.isErr()) return undefined
            return {
              server: server.value,
              rooms: this.getAllRoomMetrics().unwrapOr([]),
            }
          },
          rooms: () =>
            this._manager
              .getRooms()
              .filter((room) => room._isReady && !room.isDisposed)
              .map((room) => ({
                id: room.id,
                type: room.roomType,
                clients: room.getClientCount(),
                maxClients: room.maxClients,
                visibility: room.visibility,
                locked: room.locked,
                metadata: room.metadata,
              })),
        },
      )
      const started = this._http.start()
      if (started.isErr()) {
        await transport.close()
        this._http = undefined
        return err(
          this._error(
            "CONNECTION_FAILED",
            started.error.message,
            started.error,
          ),
        )
      }
    }
    if (this._options.gracefulShutdown?.handleSignals !== false) {
      process.on("SIGTERM", this._onSignal)
      process.on("SIGINT", this._onSignal)
    }
    this._running = true
    this._startedAt = this._clock.now()
    if (this._metrics !== undefined) this._metrics.startedAt = this._startedAt
    return ok(undefined)
  }

  /**
   * Graceful stop: joins are refused, every room is disposed (its clients
   * get `LEAVE(4001 SERVER_SHUTDOWN)` and `onLeave`, then `onDispose`),
   * then the transport closes every connection with 1001.
   */
  public async stop(): Promise<Result<void, BungohanError>> {
    if (!this._running) return err(this._error("INVALID_STATE", "not running"))
    this._shuttingDown = true
    await Promise.all(this._manager.getRooms().map((room) => room.dispose()))
    const closed = await this._transport.close()
    if (closed.isErr()) this._report(closed.error, { source: "transport" })
    await this._http?.stop()
    this._http = undefined
    if (this._ownsStore) await this._store?.close()
    process.off("SIGTERM", this._onSignal)
    process.off("SIGINT", this._onSignal)
    this._connections.clear()
    this._running = false
    this._shuttingDown = false
    return ok(undefined)
  }

  public isRunning(): boolean {
    return this._running
  }

  public get processId(): string {
    return this._processId
  }

  public getRoomManager(): RoomManager {
    return this._manager
  }

  public getMatchMaker(): MatchMaker {
    return this._matchMaker
  }

  public getTransport(): ITransport {
    return this._transport
  }

  public getClock(): Clock {
    return this._clock
  }

  public getMetricsCollector(): MetricsCollector | undefined {
    return this._metrics
  }

  public getHttpServer(): HttpServer | undefined {
    return this._http
  }

  // ==========================================================================
  // Events
  // ==========================================================================

  /** A transport connection opened (before any join). */
  public onConnect(cb: (connection: Connection) => void): () => void {
    this._onConnect.add(cb)
    return () => this._onConnect.delete(cb)
  }

  /** A client joined a room (after its `JOIN_SUCCESS`; not on reconnect). */
  public onJoin(cb: (client: Client, room: Room) => void): () => void {
    this._onJoin.add(cb)
    return () => this._onJoin.delete(cb)
  }

  /** A client's seat was released (after `onLeave`). */
  public onLeave(
    cb: (client: Client, room: Room, consented: boolean) => void,
  ): () => void {
    this._onLeave.add(cb)
    return () => this._onLeave.delete(cb)
  }

  /**
   * Every error the framework caught: throwing hooks and handlers, failed
   * sends, transport errors. Without a callback, errors are logged.
   */
  public onError(
    cb: (error: Error, context: ErrorContext) => void,
  ): () => void {
    this._onError.add(cb)
    return () => this._onError.delete(cb)
  }

  // ==========================================================================
  // Metrics
  // ==========================================================================

  public getServerMetrics(): Result<ServerMetrics, BungohanError> {
    const m = this._metrics
    if (m === undefined) return err(this._metricsDisabled())
    const now = this._clock.now()
    const uptime = (now - m.startedAt) / 1000
    const memory = process.memoryUsage()
    return ok({
      processId: this._processId,
      uptime,
      activeConnections: this._connections.size,
      totalConnections: m.totalConnections,
      totalDisconnections: m.totalDisconnections,
      activeRooms: this._manager.getRoomCount(),
      totalRoomsCreated: m.totalRoomsCreated,
      totalRoomsDisposed: m.totalRoomsDisposed,
      totalMessages: m.totalMessages,
      messagesPerSecond: uptime > 0 ? m.totalMessages / uptime : 0,
      bytesReceived: m.bytesReceived,
      bytesSent: m.bytesSent,
      totalErrors: m.totalErrors,
      memoryUsage: {
        heapUsed: memory.heapUsed,
        heapTotal: memory.heapTotal,
        external: memory.external,
        rss: memory.rss,
      },
      timestamp: now,
    })
  }

  public getAllRoomMetrics(): Result<RoomMetrics[], BungohanError> {
    if (this._metrics === undefined) return err(this._metricsDisabled())
    const now = this._clock.now()
    const out: RoomMetrics[] = []
    for (const room of this._manager.getRooms()) {
      const metrics = room._metrics(now)
      if (metrics !== undefined) out.push(metrics)
    }
    return ok(out)
  }

  public getAllClientMetrics(): Result<ClientMetrics[], BungohanError> {
    if (this._metrics === undefined) return err(this._metricsDisabled())
    const now = this._clock.now()
    const out: ClientMetrics[] = []
    for (const room of this._manager.getRooms()) {
      for (const client of room.getClients()) {
        const stats = client._stats
        if (stats === undefined) continue
        const metrics: ClientMetrics = {
          clientId: client.sessionId,
          roomId: room.id,
          connected: client.connected,
          uptime: (now - stats.joinedAt) / 1000,
          totalMessagesSent: stats.framesSent,
          totalMessagesReceived: stats.messagesReceived,
          bytesSent: stats.bytesSent,
          bytesReceived: stats.bytesReceived,
          timestamp: now,
        }
        if (stats.latency.count > 0) metrics.avgLatency = stats.latency.value
        if (stats.lastMessageAt !== undefined) {
          metrics.lastMessageAt = stats.lastMessageAt
        }
        out.push(metrics)
      }
    }
    return ok(out)
  }

  // ==========================================================================
  // Transport events
  // ==========================================================================

  private _handleConnection(id: string, context: Connection["context"]): void {
    // The transport already refused other versions (acceptProtocols). This
    // also covers a transport that doesn't negotiate at all: no frame of a
    // connection without the right version is ever parsed (spec §6.7.7).
    if (context.protocol !== PROTOCOL_VERSION) {
      const offered = context.protocol ?? "none"
      this._logger.warn(`rejected ${id}: protocol version ${offered}`)
      this._transport.disconnect(
        id,
        CloseCode.PROTOCOL_ERROR,
        `unsupported protocol ${offered}; expected ${PROTOCOL_VERSION}`,
      )
      return
    }
    const connection = new Connection(id, context, this._clock.now())
    this._connections.set(id, connection)
    if (this._metrics !== undefined) this._metrics.totalConnections++
    this._emit(this._onConnect, connection)
  }

  private _handleDisconnect(id: string): void {
    const connection = this._connections.get(id)
    if (connection === undefined) return
    this._connections.delete(id)
    connection._open = false
    if (this._metrics !== undefined) this._metrics.totalDisconnections++
    for (const client of [...connection._seats.values()]) {
      client._room?._connectionLost(client)
    }
  }

  private _handleFrame(id: string, data: Uint8Array): void {
    const connection = this._connections.get(id)
    if (connection === undefined || !connection._open) return
    const metrics = this._metrics
    if (metrics !== undefined) {
      metrics.totalMessages++
      metrics.bytesReceived += data.byteLength
    }
    const frame = decodeFrame(data, CLIENT_FRAME_HEADERS)
    if (frame.isErr()) {
      this._violation(connection, frame.error.message)
      return
    }
    const { type, header, body } = frame.value
    const ref = header[0] ?? 0
    switch (type) {
      case ClientFrameType.ROOM_MESSAGE:
      case ClientFrameType.ROOM_MESSAGE_RAW: {
        const client = connection._seats.get(ref)
        if (client?._room === undefined || client._status !== "joined") return
        const received =
          type === ClientFrameType.ROOM_MESSAGE
            ? client._room._receive(client, header[1] ?? 0, body)
            : client._room._receiveRaw(client, body)
        if (received.isErr()) {
          this._violation(connection, received.error.message)
        }
        return
      }
      case ClientFrameType.JOIN:
        void this._handleJoin(connection, ref, body).catch((error: unknown) =>
          this._report(error, { source: "protocol", connection }),
        )
        return
      case ClientFrameType.LEAVE: {
        const client = connection._seats.get(ref)
        if (client?._room === undefined || client._status !== "joined") return
        void client._room._release(client, true, LeaveCode.CONSENTED)
        return
      }
      case ClientFrameType.PING: {
        const pong = encodeFrame(ServerFrameType.PONG, [ref])
        if (pong.isOk()) this._host.sendFrame(connection, pong.value)
        const rtt = header[1] ?? 0
        if (metrics !== undefined && rtt > 0) {
          for (const client of connection._seats.values()) {
            client._room?._recordLatency(client, rtt)
          }
        }
        return
      }
    }
  }

  /**
   * Protocol violation (spec §6.7.6): explain with `ERROR(0)`, close with
   * 1008. Frames still in flight from this connection are ignored.
   *
   * `why` goes in **both** the `ERROR` body and the close reason. A client
   * must not depend on receiving the `ERROR` (PROTOCOL.md §8.2): some
   * WebSocket stacks drop whatever they have buffered the moment a close
   * frame arrives, so a client that only ever sees the close would
   * otherwise be left with a bare 1008 and no explanation.
   */
  private _violation(connection: Connection, why: string): void {
    this._logger.warn(`protocol violation from ${connection.id}: ${why}`)
    const body = this._serializer.encode(["INVALID_MESSAGE", why])
    if (body.isOk()) {
      const frame = encodeFrame(ServerFrameType.ERROR, [0], body.value)
      if (frame.isOk()) this._host.sendFrame(connection, frame.value)
    }
    connection._open = false
    this._transport.disconnect(
      connection.id,
      CloseCode.POLICY_VIOLATION,
      clipCloseReason(why),
    )
  }

  // ==========================================================================
  // Joining (spec §6.7.2–6.7.5)
  // ==========================================================================

  private async _handleJoin(
    connection: Connection,
    requestId: number,
    body: Uint8Array,
  ): Promise<void> {
    const decoded = this._serializer.decode(body)
    if (decoded.isErr() || !Array.isArray(decoded.value)) {
      this._violation(connection, "JOIN body must be an array")
      return
    }
    const request = parseJoin(decoded.value)
    if (request === undefined) {
      this._joinError(
        connection,
        requestId,
        "INVALID_OPTIONS",
        "malformed JOIN",
      )
      return
    }
    const joined = await this._join(connection, request)
    if (joined.isErr()) {
      this._joinError(
        connection,
        requestId,
        joined.error.code,
        joined.error.message,
      )
      return
    }
    const { room, client, reconnected } = joined.value
    if (!connection._open) {
      // Closed while joining. onJoin ran, so onLeave will too; without a
      // token the seat isn't held.
      if (reconnected) room._reconnected(client)
      else room._activate(client)
      room._connectionLost(client)
      return
    }
    const token = room._issueToken(client)
    const handshake = this._serializer.encode(room._handshake(client, token))
    const frame = handshake.isOk()
      ? encodeFrame(
          ServerFrameType.JOIN_SUCCESS,
          [requestId, client._roomRef],
          handshake.value,
        )
      : handshake
    if (frame.isErr()) {
      this._report(frame.error, { source: "protocol", room, client })
      return
    }
    this._host.sendFrame(connection, frame.value)
    if (reconnected) {
      room._reconnected(client)
      return
    }
    room._activate(client)
    this._emit(this._onJoin, client, room)
  }

  private _joinError(
    connection: Connection,
    requestId: number,
    code: ErrorCode,
    message: string,
  ): void {
    const body = this._serializer.encode([code, message])
    if (body.isErr()) return
    const frame = encodeFrame(
      ServerFrameType.JOIN_ERROR,
      [requestId],
      body.value,
    )
    if (frame.isOk()) this._host.sendFrame(connection, frame.value)
  }

  private async _join(
    connection: Connection,
    [mode, target, options, hash]: JoinRequest,
  ): Promise<Result<Joined, BungohanError>> {
    if (this._shuttingDown || !this._running) {
      return err(
        this._error("SERVER_SHUTTING_DOWN", "the server is shutting down"),
      )
    }
    switch (mode) {
      case JoinMode.RECONNECT:
        return this._reconnect(connection, target, hash)
      case JoinMode.CONSUME_RESERVATION:
        return this._joinReservation(connection, target, hash)
      case JoinMode.JOIN_BY_ID: {
        const room = this._manager.getRoom(target)
        if (room === undefined || room.isDisposed) {
          return err(
            this._error("ROOM_NOT_FOUND", `room "${target}" not found`),
          )
        }
        const checked = this._checkRoom(connection, room, hash)
        if (checked.isErr()) return checked
        const client = new Client(nanoid(12), connection)
        return this._joinExisting(connection, room, client, options, false)
      }
      default:
        return this._joinByType(connection, mode, target, options, hash)
    }
  }

  private async _joinByType(
    connection: Connection,
    mode: JoinMode,
    typeName: string,
    options: unknown,
    hash: string | null,
  ): Promise<Result<Joined, BungohanError>> {
    const type = this._matchMaker._getType(typeName)
    if (type === undefined) {
      return err(
        this._error(
          "ROOM_TYPE_NOT_DEFINED",
          `room type "${typeName}" is not defined`,
        ),
      )
    }
    const contract = this._checkContract(type, hash)
    if (contract.isErr()) return contract
    if (mode !== JoinMode.CREATE) {
      const room = this._manager
        .getRooms()
        .find(
          (r) =>
            r.roomType === typeName &&
            r.isAvailable() &&
            !this._seatedIn(connection, r),
        )
      if (room !== undefined) {
        const client = new Client(nanoid(12), connection)
        return this._joinExisting(connection, room, client, options, false)
      }
      if (mode === JoinMode.JOIN) {
        return err(
          this._error(
            "ROOM_NOT_FOUND",
            `no available room of type "${typeName}"`,
          ),
        )
      }
    }

    // Create: the static onAuth decides before the room exists.
    const client = new Client(nanoid(12), connection)
    const auth = await Room._authorizeCreate(
      type.ctor,
      client,
      options,
      connection.context,
      (error) => this._report(error, { source: "onAuth", client, connection }),
      (code, message) => this._error(code, message),
    )
    if (auth.isErr()) return auth
    const room = this._manager._create(type, options)
    const seated = room._seat(client, connection, false)
    if (seated.isErr()) return seated
    const ready = await room._readyPromise
    if (ready?.isErr()) {
      room._unseat(client)
      return err(this._error("JOIN_FAILED", "the room could not be created"))
    }
    const joined = await room._runJoin(client, options, auth.value)
    return joined.isErr() ? joined : ok({ room, client, reconnected: false })
  }

  /** Seat, wait for the room, instance onAuth, onJoin. */
  private async _joinExisting(
    connection: Connection,
    room: Room,
    client: Client,
    options: unknown,
    reserved: boolean,
  ): Promise<Result<Joined, BungohanError>> {
    const seated = room._seat(client, connection, reserved)
    if (seated.isErr()) return seated
    const ready = await room._readyPromise
    if (ready?.isErr()) {
      room._unseat(client)
      return err(this._error("JOIN_FAILED", "the room could not be created"))
    }
    const auth = await room._authorize(client, options, connection.context)
    if (auth.isErr()) {
      room._unseat(client)
      return auth
    }
    if (!connection._open || client._status !== "joining") {
      room._unseat(client)
      return err(this._error("JOIN_FAILED", "the join was abandoned"))
    }
    const joined = await room._runJoin(client, options, auth.value)
    return joined.isErr() ? joined : ok({ room, client, reconnected: false })
  }

  private async _joinReservation(
    connection: Connection,
    reservationId: string,
    hash: string | null,
  ): Promise<Result<Joined, BungohanError>> {
    const taken = this._matchMaker._consume(reservationId)
    if (taken.isErr()) return taken
    const { room, reservation, options } = taken.value
    const checked = this._checkRoom(connection, room, hash)
    if (checked.isErr()) return checked
    const client = new Client(reservation.sessionId, connection)
    return this._joinExisting(connection, room, client, options, true)
  }

  private async _reconnect(
    connection: Connection,
    token: string,
    hash: string | null,
  ): Promise<Result<Joined, BungohanError>> {
    const roomId = token.slice(0, Math.max(0, token.indexOf(".")))
    const room = this._manager.getRoom(roomId)
    const client = room?._heldSeat(token)
    if (room === undefined || client === undefined) {
      return err(this._error("INVALID_TOKEN", "unknown or expired token"))
    }
    const checked = this._checkRoom(connection, room, hash)
    if (checked.isErr()) return checked
    room._reconnect(client, connection)
    return ok({ room, client, reconnected: true })
  }

  /** Contract hash and one-seat-per-room checks for a known room. */
  private _checkRoom(
    connection: Connection,
    room: Room,
    hash: string | null,
  ): Result<void, BungohanError> {
    const type = this._matchMaker._getType(room.roomType)
    if (type !== undefined) {
      const contract = this._checkContract(type, hash)
      if (contract.isErr()) return contract
    }
    if (this._seatedIn(connection, room)) {
      return err(
        this._error("ALREADY_JOINED", "this connection is already in the room"),
      )
    }
    return ok(undefined)
  }

  private _checkContract(
    type: RoomTypeDef,
    hash: string | null,
  ): Result<void, BungohanError> {
    if (hash === null || hash === type.contractHash) return ok(undefined)
    return err(
      this._error(
        "CONTRACT_MISMATCH",
        `client contract ${hash} does not match room type "${type.name}" ` +
          `(${type.contractHash}); rebuild the client against the server's contract`,
      ),
    )
  }

  private _seatedIn(connection: Connection, room: Room): boolean {
    for (const client of connection._seats.values()) {
      if (client._room === room && client._status !== "left") return true
    }
    return false
  }

  // ==========================================================================
  // Host, errors, signals
  // ==========================================================================

  private _createHost(): RoomHost {
    const options = this._options
    return {
      clock: this._clock,
      logger: this._logger,
      serializer: this._serializer,
      stateCodec: this._stateCodec,
      store: this._store,
      metrics: this._metrics,
      simulationTickRate: options.simulation?.tickRate ?? 60,
      maxCatchUpSteps: options.simulation?.maxCatchUpSteps ?? 5,
      syncTickRate: options.sync?.tickRate ?? 20,
      isShuttingDown: () => this._shuttingDown,
      sendFrame: (connection, frame) => {
        if (!connection._open) return
        if (this._metrics !== undefined) {
          this._metrics.bytesSent += frame.byteLength
        }
        const sent = this._transport.send(connection.id, frame)
        if (sent.isErr())
          this._logger.debug(`send failed: ${sent.error.message}`)
      },
      broadcastFrame: (connections, frame) => {
        const ids: string[] = []
        for (const connection of connections) {
          if (connection._open) ids.push(connection.id)
        }
        if (ids.length === 0) return
        if (this._metrics !== undefined) {
          this._metrics.bytesSent += frame.byteLength * ids.length
        }
        const sent = this._transport.broadcast(ids, frame)
        if (sent.isErr()) {
          this._logger.debug(`broadcast failed: ${sent.error.message}`)
        }
      },
      reportError: (error, context) => this._report(error, context),
      createId: (size) => nanoid(size),
      seatReleased: (room, client, consented) =>
        this._emit(this._onLeave, client, room, consented),
      roomDisposed: (room) => this._manager._removed(room),
    }
  }

  private _report(error: unknown, context: ErrorContext): void {
    const wrapped = toError(error)
    if (this._metrics !== undefined) this._metrics.totalErrors++
    if (this._onError.size === 0) {
      this._logger.error(`error in ${context.source}:`, wrapped)
      return
    }
    for (const cb of [...this._onError]) {
      try {
        cb(wrapped, context)
      } catch (inner) {
        this._logger.error("server.onError callback threw:", inner)
      }
    }
  }

  private _emit<A extends unknown[]>(callbacks: Set<Callback<A>>, ...args: A) {
    for (const cb of [...callbacks]) {
      try {
        cb(...args)
      } catch (error) {
        this._report(error, { source: "callback" })
      }
    }
  }

  private _error(
    code: ErrorCode,
    message: string,
    context?: unknown,
  ): BungohanError {
    return new BungohanError(code, message, this._clock.now(), context)
  }

  private _metricsDisabled(): BungohanError {
    return this._error(
      "METRICS_DISABLED",
      "metrics are disabled; pass metrics: { enabled: true }",
    )
  }

  private readonly _onSignal = (signal: NodeJS.Signals): void => {
    void this._shutdown(signal)
  }

  /** SIGTERM/SIGINT: stop gracefully, run `onShutdown`, exit. */
  private async _shutdown(signal: string): Promise<void> {
    if (this._signalled) return
    this._signalled = true
    this._logger.info(`${signal} received; shutting down`)
    const graceful = this._options.gracefulShutdown
    const timer: TimerId = this._clock.setTimeout(() => {
      this._logger.error("graceful shutdown timed out")
      process.exit(1)
    }, graceful?.timeout ?? 30_000)
    await this.stop()
    try {
      await graceful?.onShutdown?.()
    } catch (error) {
      this._report(error, { source: "callback" })
    }
    this._clock.clearTimeout(timer)
    process.exit(0)
  }
}

export function createBungohanServer(
  options: ServerOptions = {},
): BungohanServer {
  return new BungohanServer(options)
}
