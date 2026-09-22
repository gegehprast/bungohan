import { type IBackplane, RedisBackplane } from "@bungohan/backplane"
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
  type Reservation,
  SERVER_FRAME_HEADERS,
  ServerFrameType,
  SystemClock,
  type TimerId,
} from "@bungohan/types"
import { nanoid } from "nanoid"
import { Client, Connection } from "./client"
import {
  type ClusterHandlers,
  ClusterNode,
  type ClusterTimings,
  DEFAULT_CLUSTER_TIMINGS,
} from "./cluster/node"
import {
  type JoinForwardRequest,
  type JoinTarget,
  packContext,
  type RoomInfo,
  type RoomOp,
  unpackContext,
} from "./cluster/protocol"
import { isRemoteConnection, RemoteConnection } from "./cluster/remote"
import { BungohanError, type ErrorCode } from "./errors"
import { HttpServer } from "./http"
import { ConnectionLimiter } from "./limits"
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
import {
  type RoomTypeDef,
  readClientOptions,
  readServerOptions,
} from "./room-type"
import {
  type DefineRoomOptions,
  type ErrorContext,
  type ResolvedLimits,
  type RoomClass,
  resolveLimits,
  type ServerOptions,
} from "./types"

const DEFAULT_PORT = 6060

type Callback<A extends unknown[]> = (...args: A) => void

interface Joined {
  readonly room: Room
  readonly client: Client
  readonly reconnected: boolean
}

/**
 * Where a `JOIN` ended up. A `remote` join is finished by the process that
 * owns the room: it seats the client and sends every frame itself, and this
 * process only relays bytes (spec §6.4).
 */
type Routed =
  | { readonly kind: "local"; readonly joined: Joined }
  | { readonly kind: "remote" }

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

/** Wraps a local join outcome as a {@link Routed}. */
async function local(
  joining: Promise<Result<Joined, BungohanError>>,
): Promise<Result<Routed, BungohanError>> {
  const joined = await joining
  return joined.isErr() ? joined : ok({ kind: "local", joined: joined.value })
}

/** Rooms this connection already holds a seat in, here or elsewhere. */
function seatedRooms(connection: Connection): string[] {
  const ids: string[] = []
  for (const client of connection._seats.values()) {
    const id = client._room?.id
    if (id !== undefined && client._status !== "left") ids.push(id)
  }
  for (const seat of connection._remoteSeats.values()) ids.push(seat.roomId)
  return ids
}

/**
 * True when a forwarded join failed because the room it was sent to can no
 * longer take the client, rather than because the client was refused. Only
 * these are worth retrying locally (spec §6.4).
 */
function raceLost(forwarded: Result<Routed, BungohanError>): boolean {
  if (forwarded.isOk()) return false
  switch (forwarded.error.code) {
    case "ROOM_NOT_FOUND":
    case "ROOM_FULL":
    case "ROOM_LOCKED":
    case "SERVER_SHUTTING_DOWN":
    case "TIMEOUT":
    case "CONNECTION_LOST":
      return true
    default:
      return false
  }
}

/**
 * A `JOIN` body (spec §6.7.3), or undefined if it has the wrong shape.
 * Trailing elements past the known five are ignored (spec §6.7.7), so a
 * newer client can add fields without breaking this server. The options
 * stay as they came: typed ones can only be decoded once the room type is
 * known (PROTOCOL.md §6.2.1).
 */
function parseJoin(value: unknown): JoinRequest | undefined {
  if (!Array.isArray(value) || value.length < 2) return undefined
  const [mode, target, options, hash, createOptions] = value
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
  return [
    mode as JoinRequest[0],
    target,
    options ?? null,
    hash ?? null,
    createOptions ?? null,
  ]
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
  private readonly _limits: ResolvedLimits
  /** Inbound rate state, one per live connection (spec §6.9). */
  private readonly _limiters = new Map<string, ConnectionLimiter>()
  /** Connections of *other* processes holding seats in rooms here (§6.4). */
  private readonly _remoteConnections = new Map<string, RemoteConnection>()
  private readonly _clusterTimings: ClusterTimings
  private _backplane: IBackplane | undefined
  private _ownsBackplane = false
  private _cluster: ClusterNode | undefined
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
    this._limits = resolveLimits(options.limits)
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
    const cluster = options.cluster ?? {}
    this._clusterTimings = {
      heartbeatInterval:
        cluster.heartbeatInterval ?? DEFAULT_CLUSTER_TIMINGS.heartbeatInterval,
      peerTimeout: cluster.peerTimeout ?? DEFAULT_CLUSTER_TIMINGS.peerTimeout,
      requestTimeout:
        cluster.requestTimeout ?? DEFAULT_CLUSTER_TIMINGS.requestTimeout,
      gatherTimeout:
        cluster.gatherTimeout ?? DEFAULT_CLUSTER_TIMINGS.gatherTimeout,
    }
    this._host = this._createHost()
    this._manager = new RoomManager(this._host, (error) =>
      this._report(error, { source: "callback" }),
    )
    this._matchMaker = new MatchMaker({
      manager: this._manager,
      clock: this._clock,
      logger: this._logger,
      processId: this._processId,
      clusterEnabled: options.cluster?.enabled === true,
      cluster: () => this._cluster,
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
      const started = await this._startCluster()
      if (started.isErr()) return started
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
      await this._stopCluster()
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
            // A private room is reachable by its id, so the id is all
            // that keeps it private: counted here, never identified.
            const all: RoomMetrics[] = this.getAllRoomMetrics().unwrapOr([])
            const rooms = all.map(({ roomId, ...rest }) =>
              this._manager.getRoom(roomId)?.visibility === "public"
                ? { roomId, ...rest }
                : rest,
            )
            return { server: server.value, rooms }
          },
          // Public rooms only, for the same reason.
          rooms: () =>
            this._manager
              .getRooms()
              .filter(
                (room) =>
                  room._isReady &&
                  !room.isDisposed &&
                  room.visibility === "public",
              )
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
        await this._stopCluster()
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
    // After the rooms disposed, so their LEAVE(4001) frames were published
    // to the processes holding those connections before we say goodbye.
    await this._stopCluster()
    await this._http?.stop()
    this._http = undefined
    if (this._ownsStore) await this._store?.close()
    process.off("SIGTERM", this._onSignal)
    process.off("SIGINT", this._onSignal)
    this._connections.clear()
    this._remoteConnections.clear()
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

  /**
   * The port the transport listens on, so a server started with port `0`
   * can say which one it got. `undefined` before `start()`, after
   * `stop()`, and for a transport without ports (the test loopback).
   */
  public getPort(): number | undefined {
    return this._running ? this._transport.getPort?.() : undefined
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
      totalShed: m.totalShed,
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
    this._limiters.set(
      id,
      new ConnectionLimiter(this._limits, this._clock.now()),
    )
    if (this._metrics !== undefined) this._metrics.totalConnections++
    this._emit(this._onConnect, connection)
  }

  private _handleDisconnect(id: string): void {
    const connection = this._connections.get(id)
    if (connection === undefined) return
    this._connections.delete(id)
    this._limiters.delete(id)
    connection._open = false
    if (this._metrics !== undefined) this._metrics.totalDisconnections++
    for (const client of [...connection._seats.values()]) {
      client._room?._connectionLost(client)
    }
    // Seats this connection held in rooms on other processes: those
    // processes hold (or release) them, exactly as if the socket were
    // theirs (spec §6.4).
    const cluster = this._cluster
    if (cluster !== undefined && connection._remoteOwners.size > 0) {
      connection._remoteSeats.clear()
      for (const owner of connection._remoteOwners) {
        cluster.notifyConnectionClosed(owner, id)
      }
      connection._remoteOwners.clear()
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
    // Charged before decoding, so a flood costs a clock read, not a parse.
    const over = this._limiters
      .get(id)
      ?.frameProblem(data.byteLength, this._clock.now())
    if (over !== undefined) {
      this._shed(connection, over)
      return
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
        const raw = type === ClientFrameType.ROOM_MESSAGE_RAW
        const client = connection._seats.get(ref)
        if (client === undefined) {
          const seat = connection._remoteSeats.get(ref)
          if (seat !== undefined) {
            this._cluster?.forwardMessage(
              seat.processId,
              seat.roomId,
              seat.sessionId,
              connection.id,
              raw,
              header[1] ?? 0,
              body,
            )
          }
          return
        }
        if (client._room === undefined || client._status !== "joined") return
        const received = raw
          ? client._room._receiveRaw(client, body)
          : client._room._receive(client, header[1] ?? 0, body)
        if (received.isErr()) {
          this._violation(connection, received.error.message)
        }
        return
      }
      case ClientFrameType.JOIN: {
        const limiter = this._limiters.get(id)
        if (limiter !== undefined && !limiter.allowJoin(this._clock.now())) {
          this._joinError(
            connection,
            ref,
            "RATE_LIMITED",
            "too many join attempts; try again shortly",
          )
          return
        }
        void this._handleJoin(connection, ref, body).catch((error: unknown) =>
          this._report(error, { source: "protocol", connection }),
        )
        return
      }
      case ClientFrameType.LEAVE: {
        const client = connection._seats.get(ref)
        if (client === undefined) {
          const seat = connection._remoteSeats.get(ref)
          if (seat !== undefined) {
            this._cluster?.forwardLeave(
              seat.processId,
              seat.roomId,
              seat.sessionId,
            )
          }
          return
        }
        if (client._room === undefined || client._status !== "joined") return
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
  /**
   * Drops a connection that is over a limit (spec §6.9): 1013, not the
   * 1008 of a protocol violation, because nothing it sent was malformed
   * and it may come back. No `ERROR` frame: it is already reading too
   * slowly, or sending too fast to be listening.
   */
  private _shed(connection: Connection, why: string): void {
    if (!connection._open) return
    this._logger.warn(`shedding ${connection.id}: ${why}`)
    this._metrics?.countShed()
    connection._open = false
    this._transport.disconnect(
      connection.id,
      CloseCode.TRY_AGAIN_LATER,
      clipCloseReason(why),
    )
  }

  /**
   * Bytes queued for a connection, or `undefined` when this process can't
   * know: a seat whose socket lives on another process is that process's
   * to watch (spec §6.4, §6.9).
   */
  private _queuedFor(connection: Connection): number | undefined {
    if (isRemoteConnection(connection)) return undefined
    return this._transport.bufferedAmount(connection.id)
  }

  /** Sheds a connection whose queue has passed the hard limit. */
  private _checkQueue(connection: Connection): void {
    const limit = this._limits.disconnectBytes
    if (limit <= 0 || !connection._open) return
    const queued = this._queuedFor(connection)
    if (queued !== undefined && queued > limit) {
      this._shed(connection, `send queue over ${limit} bytes`)
    }
  }

  private _violation(connection: Connection, why: string): void {
    this._logger.warn(`protocol violation from ${connection.id}: ${why}`)
    if (isRemoteConnection(connection)) {
      // The socket is another process's; it sends the ERROR and closes.
      connection._open = false
      this._cluster?.sendViolation(
        connection.processId,
        connection.connectionId,
        why,
      )
      return
    }
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
    const routed = await this._route(connection, requestId, request)
    if (routed.isErr()) {
      this._joinError(
        connection,
        requestId,
        routed.error.code,
        routed.error.message,
      )
      return
    }
    // A remote join is completed by the process that owns the room: it
    // sends `JOIN_SUCCESS` itself, on this connection's `roomRef`.
    if (routed.value.kind === "local") {
      this._completeJoin(connection, requestId, routed.value.joined)
    }
  }

  /**
   * Sends `JOIN_SUCCESS` and admits the client (spec §6.7.2). The
   * `connection` may be a `RemoteConnection`, in which case every frame
   * built here is relayed to the process holding the socket (§6.4).
   */
  private _completeJoin(
    connection: Connection,
    requestId: number,
    joined: Joined,
  ): void {
    const { room, client, reconnected } = joined
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

  /**
   * Resolves a `JOIN` to a room and seats the client, here or on the
   * process that owns the room (spec §6.4). Every lookup is **local
   * first**: only when this process has nothing does it ask the cluster,
   * so an unclustered server behaves exactly as before.
   */
  private async _route(
    connection: Connection,
    requestId: number,
    [mode, target, options, hash, createOptions]: JoinRequest,
  ): Promise<Result<Routed, BungohanError>> {
    if (this._shuttingDown || !this._running) {
      return err(
        this._error("SERVER_SHUTTING_DOWN", "the server is shutting down"),
      )
    }
    switch (mode) {
      case JoinMode.RECONNECT: {
        // The token names its room (`<roomId>.<secret>`), so a client may
        // reconnect to any process in the cluster (spec §6.4).
        const roomId = target.slice(0, Math.max(0, target.indexOf(".")))
        if (this._manager.getRoom(roomId) !== undefined) {
          return local(this._reconnect(connection, target, hash))
        }
        const owner = await this._cluster?.locate("room", roomId)
        if (owner !== undefined) {
          return this._forwardJoin(
            connection,
            requestId,
            owner,
            options,
            hash,
            {
              kind: "reconnect",
              token: target,
            },
          )
        }
        return err(this._error("INVALID_TOKEN", "unknown or expired token"))
      }
      case JoinMode.CONSUME_RESERVATION: {
        if (this._matchMaker._hasReservation(target)) {
          return local(this._joinReservation(connection, target, hash))
        }
        const owner = await this._cluster?.locate("reservation", target)
        if (owner !== undefined) {
          return this._forwardJoin(
            connection,
            requestId,
            owner,
            options,
            hash,
            {
              kind: "reservation",
              reservationId: target,
            },
          )
        }
        return err(this._error("RESERVATION_NOT_FOUND", "unknown reservation"))
      }
      case JoinMode.JOIN_BY_ID: {
        const room = this._manager.getRoom(target)
        if (room !== undefined) {
          if (room.isDisposed) {
            return err(
              this._error("ROOM_NOT_FOUND", `room "${target}" not found`),
            )
          }
          const checked = this._checkRoom(connection, room, hash)
          if (checked.isErr()) return checked
          const joinOptions = this._readOptions(room, options)
          if (joinOptions.isErr()) return joinOptions
          const client = new Client(nanoid(12), connection)
          return local(
            this._joinExisting(
              connection,
              room,
              client,
              joinOptions.value,
              false,
            ),
          )
        }
        const owner = await this._cluster?.locate("room", target)
        if (owner !== undefined) {
          return this._forwardJoin(
            connection,
            requestId,
            owner,
            options,
            hash,
            {
              kind: "room",
              roomId: target,
              mode,
            },
          )
        }
        return err(this._error("ROOM_NOT_FOUND", `room "${target}" not found`))
      }
      default:
        return this._routeByType(
          connection,
          requestId,
          mode,
          target,
          options,
          hash,
          createOptions,
        )
    }
  }

  private async _routeByType(
    connection: Connection,
    requestId: number,
    mode: JoinMode,
    typeName: string,
    options: unknown,
    hash: string | null,
    createOptions: unknown,
  ): Promise<Result<Routed, BungohanError>> {
    const type = this._matchMaker._getType(typeName)
    // Typed join options are decoded as soon as the type is known: here,
    // before any room is looked for (PROTOCOL.md §6.2.1). A process that
    // doesn't define the type forwards them as they came, and the owner
    // decodes them.
    let joinOptions: unknown = options
    if (type !== undefined) {
      const contract = this._checkContract(type, hash)
      if (contract.isErr()) return contract
      const read = readClientOptions(type, "join", options)
      if (read.isErr()) {
        return err(this._error("INVALID_OPTIONS", read.error.message))
      }
      joinOptions = read.value
    } else if (mode === JoinMode.CREATE || this._cluster === undefined) {
      // A clustered server may not define every room type: a join can
      // still land on a process that does, so the check waits until the
      // cluster has been asked.
      return err(
        this._error(
          "ROOM_TYPE_NOT_DEFINED",
          `room type "${typeName}" is not defined`,
        ),
      )
    }
    // A client's JOIN_OR_CREATE and the matchmaker's joinOrCreate/reserve
    // share one registry of rooms being created, so none of them creates a
    // second room while another is creating one (spec §6.7.2).
    const matchMaker = this._matchMaker
    let askCluster = true
    for (;;) {
      let release: (() => void) | undefined
      if (mode !== JoinMode.CREATE) {
        const creating =
          mode === JoinMode.JOIN_OR_CREATE
            ? matchMaker._creation(typeName)
            : undefined
        if (creating !== undefined) {
          await creating
          continue
        }
        const room = this._manager
          .getRooms()
          .find(
            (r) =>
              r.roomType === typeName &&
              r.isAvailable() &&
              !this._seatedIn(connection, r),
          )
        if (room !== undefined) {
          // JOIN_OR_CREATE waits for a room still being created before
          // taking a seat, so a room that fails leaves it free to create
          // one; JOIN takes the seat now and shares the room's fate.
          if (mode === JoinMode.JOIN_OR_CREATE && !room._isReady) {
            await room._readyPromise
            continue
          }
          const client = new Client(nanoid(12), connection)
          return local(
            this._joinExisting(connection, room, client, joinOptions, false),
          )
        }
        if (mode === JoinMode.JOIN_OR_CREATE && type !== undefined) {
          release = matchMaker._claimCreation(typeName)
        }
        const found = askCluster
          ? await this._cluster?.findAvailable(
              typeName,
              seatedRooms(connection),
            )
          : undefined
        if (found !== undefined) {
          release?.() // it creates nothing: let the others look too
          const forwarded = await this._forwardJoin(
            connection,
            requestId,
            found.processId,
            options,
            hash,
            { kind: "room", roomId: found.roomId, mode },
          )
          // A room can fill up or vanish between answering and being
          // joined. `JOIN_OR_CREATE` then creates one here, as it would
          // locally; anything else is the client's answer.
          if (
            forwarded.isOk() ||
            mode === JoinMode.JOIN ||
            !raceLost(forwarded)
          ) {
            return forwarded
          }
          askCluster = false
          continue
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
      if (type === undefined) {
        return err(
          this._error(
            "ROOM_TYPE_NOT_DEFINED",
            `room type "${typeName}" is not defined`,
          ),
        )
      }
      try {
        return await this._createAndJoin(
          connection,
          type,
          joinOptions,
          createOptions,
          release,
        )
      } finally {
        release?.()
      }
    }
  }

  /**
   * The creating half of a join: static onAuth, create the room, seat,
   * onJoin. `release` ends this join's claim on creating a room of the
   * type (`JOIN_OR_CREATE`), once the room is ready or won't be.
   */
  private async _createAndJoin(
    connection: Connection,
    type: RoomTypeDef,
    joinOptions: unknown,
    createOptions: unknown,
    release: (() => void) | undefined,
  ): Promise<Result<Routed, BungohanError>> {
    // Create options are read only by a join that creates (untyped ones
    // are the join's own options, as they always were).
    const roomOptions =
      type.createOptions === undefined
        ? ok(joinOptions)
        : readClientOptions(type, "create", createOptions)
    if (roomOptions.isErr()) {
      return err(this._error("INVALID_OPTIONS", roomOptions.error.message))
    }
    // Create: the static onAuth decides before the room exists.
    const client = new Client(nanoid(12), connection)
    const auth = await Room._authorizeCreate(
      type.ctor,
      client,
      joinOptions,
      connection.context,
      (error) => this._report(error, { source: "onAuth", client, connection }),
      (code, message) => this._error(code, message),
    )
    if (auth.isErr()) return auth
    const room = this._manager._create(type, roomOptions.value)
    const seated = room._seat(client, connection, false)
    if (seated.isErr()) return seated
    const ready = await room._readyPromise
    // Ready (or failed), with this seat taken: the joins waiting on the
    // claim may look now, and see the room's real remaining capacity.
    release?.()
    if (ready?.isErr()) {
      room._unseat(client)
      return err(this._error("JOIN_FAILED", "the room could not be created"))
    }
    const joined = await room._runJoin(client, joinOptions, auth.value)
    return joined.isErr()
      ? joined
      : ok({ kind: "local", joined: { room, client, reconnected: false } })
  }

  /**
   * Seat, wait for the room, instance onAuth, onJoin. `ref` is set for a
   * clustered join: the `roomRef` the edge process already allocated on
   * the client's connection (spec §6.4).
   */
  private async _joinExisting(
    connection: Connection,
    room: Room,
    client: Client,
    options: unknown,
    reserved: boolean,
    ref?: number,
  ): Promise<Result<Joined, BungohanError>> {
    const seated = room._seat(client, connection, reserved, ref)
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
    ref?: number,
  ): Promise<Result<Joined, BungohanError>> {
    const taken = this._matchMaker._consume(reservationId)
    if (taken.isErr()) return taken
    const { room, reservation, options } = taken.value
    const checked = this._checkRoom(connection, room, hash)
    if (checked.isErr()) return checked
    const client = new Client(reservation.sessionId, connection)
    return this._joinExisting(connection, room, client, options, true, ref)
  }

  private async _reconnect(
    connection: Connection,
    token: string,
    hash: string | null,
    ref?: number,
  ): Promise<Result<Joined, BungohanError>> {
    const roomId = token.slice(0, Math.max(0, token.indexOf(".")))
    const room = this._manager.getRoom(roomId)
    const client = room?._heldSeat(token)
    if (room === undefined || client === undefined) {
      return err(this._error("INVALID_TOKEN", "unknown or expired token"))
    }
    const checked = this._checkRoom(connection, room, hash)
    if (checked.isErr()) return checked
    room._reconnect(client, connection, ref)
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

  /**
   * A client's join options for a room this process owns, decoded against
   * its type when they are typed (PROTOCOL.md §6.2.1).
   */
  private _readOptions(
    room: Room,
    options: unknown,
  ): Result<unknown, BungohanError> {
    const type = this._matchMaker._getType(room.roomType)
    if (type === undefined) return ok(options)
    const read = readClientOptions(type, "join", options)
    return read.isErr()
      ? err(this._error("INVALID_OPTIONS", read.error.message))
      : ok(read.value)
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
  // Cluster mode (spec §6.4)
  // ==========================================================================

  /** The cluster node while cluster mode runs, `undefined` otherwise. */
  public getCluster(): ClusterNode | undefined {
    return this._cluster
  }

  /**
   * Connections of *other* processes that currently hold seats in rooms
   * here (spec §6.4). One per remote client connection, not per seat.
   */
  public getRemoteConnectionCount(): number {
    return this._remoteConnections.size
  }

  private async _startCluster(): Promise<Result<void, BungohanError>> {
    const options = this._options.cluster ?? {}
    if (options.backplane?.provider !== undefined) {
      this._backplane = options.backplane.provider
      this._ownsBackplane = false
    } else if (options.backplane?.config !== undefined) {
      this._backplane = new RedisBackplane(options.backplane.config)
      this._ownsBackplane = true
    } else {
      return err(
        this._error(
          "INVALID_OPTIONS",
          "cluster.enabled needs a backplane: pass " +
            "cluster.backplane.provider (a RedisBackplane, a MemoryBackplane " +
            "on a shared MemoryBus, or your own IBackplane) or " +
            "cluster.backplane.config for Redis",
        ),
      )
    }
    const node = new ClusterNode({
      backplane: this._backplane,
      serializer: this._serializer,
      processId: this._processId,
      namespace: options.namespace ?? "bungohan",
      clock: this._clock,
      logger: this._logger,
      timings: this._clusterTimings,
      createId: () => nanoid(16),
      handlers: this._clusterHandlers(),
    })
    const started = await node.start()
    if (started.isErr()) {
      if (this._ownsBackplane) await this._backplane.close()
      this._backplane = undefined
      this._ownsBackplane = false
      return started
    }
    this._cluster = node
    return ok(undefined)
  }

  private async _stopCluster(): Promise<void> {
    await this._cluster?.stop()
    this._cluster = undefined
    if (this._ownsBackplane) await this._backplane?.close()
    this._backplane = undefined
    this._ownsBackplane = false
  }

  private _clusterHandlers(): ClusterHandlers {
    return {
      localProcessInfo: () => this._matchMaker._localProcess(),
      hasRoom: (roomId) => {
        const room = this._manager.getRoom(roomId)
        return room !== undefined && !room.isDisposed
      },
      hasReservation: (id) => this._matchMaker._hasReservation(id),
      findAvailable: (roomType, exclude) =>
        this._shuttingDown
          ? undefined
          : this._matchMaker._findAvailable(roomType, exclude)?.id,
      listRooms: (roomType, metadata, includePrivate) =>
        this._matchMaker._listLocal(roomType, metadata, includePrivate),
      createRoom: (roomType, options) =>
        this._clusterCreateRoom(roomType, options),
      reserve: (roomId, options) => this._clusterReserve(roomId, options),
      roomOp: (roomId, call) => this._clusterRoomOp(roomId, call),
      remoteJoin: (request) => this._clusterJoin(request),
      remoteMessage: (edge, roomId, sessionId, connectionId, raw, id, body) =>
        this._clusterMessage(
          edge,
          roomId,
          sessionId,
          connectionId,
          raw,
          id,
          body,
        ),
      remoteLeave: (_edge, roomId, sessionId) =>
        this._clusterLeave(roomId, sessionId),
      edgeConnectionClosed: (processId, connectionId) =>
        this._closeRemoteConnection(`${processId}|${connectionId}`),
      edgeProcessLost: (processId) => {
        for (const [key, connection] of [...this._remoteConnections]) {
          if (connection.processId === processId) {
            this._closeRemoteConnection(key)
          }
        }
      },
      relayFrames: (connectionIds, frame) =>
        this._relayFrames(connectionIds, frame),
      relayViolation: (connectionId, why) => {
        const connection = this._connections.get(connectionId)
        if (connection !== undefined) this._violation(connection, why)
      },
      ownerProcessLost: (processId) => this._ownerProcessLost(processId),
    }
  }

  // --- owner side ----------------------------------------------------------

  private async _clusterCreateRoom(
    roomType: string,
    options: unknown,
  ): Promise<Result<RoomInfo, BungohanError>> {
    if (this._shuttingDown || !this._running) {
      return err(
        this._error("SERVER_SHUTTING_DOWN", "the server is shutting down"),
      )
    }
    const type = this._matchMaker._getType(roomType)
    if (type === undefined) {
      return err(
        this._error(
          "ROOM_TYPE_NOT_DEFINED",
          `room type "${roomType}" is not defined on process ` +
            `${this._processId}`,
        ),
      )
    }
    // Typed create options arrive encoded from the requesting process (or,
    // from one that doesn't define the type, as the caller built them).
    const read = readServerOptions(type, "create", options)
    if (read.isErr()) {
      return err(this._error("INVALID_OPTIONS", read.error.message))
    }
    const created = await this._manager._createReady(type, read.value)
    return created.isErr()
      ? created
      : ok(this._matchMaker._roomInfo(created.value))
  }

  private async _clusterReserve(
    roomId: string,
    options: unknown,
  ): Promise<Result<Reservation, BungohanError>> {
    const room = this._manager.getRoom(roomId)
    if (room === undefined || room.isDisposed) {
      return err(this._error("ROOM_NOT_FOUND", `room "${roomId}" not found`))
    }
    const ready = await room._readyPromise
    if (ready?.isErr()) return err(ready.error)
    return this._matchMaker._reserveIn(room, options)
  }

  private _clusterRoomOp(
    roomId: string,
    call: RoomOp,
  ): Result<unknown, BungohanError> {
    const room = this._manager.getRoom(roomId)
    if (room === undefined) {
      return err(this._error("ROOM_NOT_FOUND", `room "${roomId}" not found`))
    }
    switch (call.op) {
      case "info":
        return ok(this._matchMaker._roomInfo(room))
      case "lock":
        if (call.locked) room.lock()
        else room.unlock()
        return ok(this._matchMaker._roomInfo(room))
      case "visibility":
        if (call.visibility === "private") room.makePrivate()
        else room.makePublic()
        return ok(this._matchMaker._roomInfo(room))
      case "dispose":
        void room.dispose()
        return ok(undefined)
      case "presenceSet":
        room.setPresence(call.clientId, call.data)
        return ok(undefined)
      case "presenceRemove":
        room.removePresence(call.clientId)
        return ok(undefined)
      case "presenceAll":
        return ok([...room.getAllPresence()])
      case "broadcast":
        room._broadcastByName(
          call.type,
          call.message,
          this._seatOf(room, call.except),
        )
        return ok(undefined)
      case "broadcastRaw":
        room._broadcastRawByName(
          call.type,
          call.message,
          this._seatOf(room, call.except),
        )
        return ok(undefined)
      case "kick": {
        const client = room.getClient(call.sessionId)
        if (client !== undefined) {
          room.disconnectClient(client, call.code, call.reason)
        }
        return ok(undefined)
      }
    }
  }

  private _seatOf(
    room: Room,
    sessionId: string | undefined,
  ): Client | undefined {
    return sessionId === undefined ? undefined : room.getClient(sessionId)
  }

  /**
   * Owner side of a forwarded `JOIN`. The reply names the seat and goes out
   * **before** `JOIN_SUCCESS`, and both travel on the same channel in
   * publish order, so the edge has the mapping before the first frame.
   */
  private async _clusterJoin(request: JoinForwardRequest): Promise<void> {
    const cluster = this._cluster
    if (cluster === undefined) return
    if (this._shuttingDown || !this._running) {
      cluster.sendJoinReply(request.from, request.rid, {
        code: "SERVER_SHUTTING_DOWN",
        message: "the server is shutting down",
      })
      return
    }
    const connection = this._remoteConnection(request)
    const joined = await this._joinResolved(connection, request)
    if (joined.isErr()) {
      cluster.sendJoinReply(request.from, request.rid, {
        code: joined.error.code,
        message: joined.error.message,
      })
      this._pruneRemoteConnection(connection)
      return
    }
    cluster.sendJoinReply(request.from, request.rid, {
      roomId: joined.value.room.id,
      sessionId: joined.value.client.sessionId,
    })
    this._completeJoin(connection, request.requestId, joined.value)
  }

  private async _joinResolved(
    connection: RemoteConnection,
    request: JoinForwardRequest,
  ): Promise<Result<Joined, BungohanError>> {
    const { target, options, hash, roomRef } = request
    switch (target.kind) {
      case "reconnect":
        return this._reconnect(connection, target.token, hash, roomRef)
      case "reservation":
        return this._joinReservation(
          connection,
          target.reservationId,
          hash,
          roomRef,
        )
      case "room": {
        const room = this._manager.getRoom(target.roomId)
        if (room === undefined || room.isDisposed) {
          return err(
            this._error("ROOM_NOT_FOUND", `room "${target.roomId}" not found`),
          )
        }
        // Matchmaking modes take any *available* room; JOIN_BY_ID may take
        // a private one, and `_seat` still refuses a locked or full room.
        if (target.mode !== JoinMode.JOIN_BY_ID && !room.isAvailable()) {
          return err(
            this._error("ROOM_NOT_FOUND", "the room is no longer available"),
          )
        }
        const checked = this._checkRoom(connection, room, hash)
        if (checked.isErr()) return checked
        const joinOptions = this._readOptions(room, options)
        if (joinOptions.isErr()) return joinOptions
        const client = new Client(nanoid(12), connection)
        return this._joinExisting(
          connection,
          room,
          client,
          joinOptions.value,
          false,
          roomRef,
        )
      }
    }
  }

  private _clusterMessage(
    edgeProcessId: string,
    roomId: string,
    sessionId: string,
    connectionId: string,
    raw: boolean,
    messageId: number,
    body: Uint8Array,
  ): void {
    const room = this._manager.getRoom(roomId)
    const client = room?.getClient(sessionId)
    // A frame for a seat this process no longer knows is dropped silently,
    // exactly as a local one is (PROTOCOL.md §7.1).
    if (room === undefined || client === undefined) return
    if (client._status !== "joined") return
    const received = raw
      ? room._receiveRaw(client, body)
      : room._receive(client, messageId, body)
    if (received.isErr()) {
      this._logger.warn(
        `protocol violation from ${edgeProcessId}|${connectionId}: ` +
          received.error.message,
      )
      this._cluster?.sendViolation(
        edgeProcessId,
        connectionId,
        received.error.message,
      )
    }
  }

  private _clusterLeave(roomId: string, sessionId: string): void {
    const room = this._manager.getRoom(roomId)
    const client = room?.getClient(sessionId)
    if (room === undefined || client === undefined) return
    if (client._status !== "joined") return
    void room._release(client, true, LeaveCode.CONSENTED)
  }

  private _remoteConnection(request: JoinForwardRequest): RemoteConnection {
    const key = `${request.from}|${request.connectionId}`
    const existing = this._remoteConnections.get(key)
    if (existing !== undefined) return existing
    const connection = new RemoteConnection(
      request.from,
      request.connectionId,
      unpackContext(request.context),
      this._clock.now(),
    )
    this._remoteConnections.set(key, connection)
    return connection
  }

  /** Forgets a remote connection that ended up holding no seat. */
  private _pruneRemoteConnection(connection: RemoteConnection): void {
    if (connection._seats.size > 0) return
    this._remoteConnections.delete(connection.id)
  }

  private _closeRemoteConnection(key: string): void {
    const connection = this._remoteConnections.get(key)
    if (connection === undefined) return
    this._remoteConnections.delete(key)
    connection._open = false
    for (const client of [...connection._seats.values()]) {
      client._room?._connectionLost(client)
    }
  }

  // --- edge side -----------------------------------------------------------

  /** Hands finished frames from the owning process to the real sockets. */
  private _relayFrames(connectionIds: string[], frame: Uint8Array): void {
    // A LEAVE ends the seat: no frame for that roomRef follows it
    // (PROTOCOL.md §5.2), so the mapping goes with it. Every other frame
    // costs one byte to rule out.
    const ends =
      frame[0] === ServerFrameType.LEAVE
        ? decodeFrame(frame, SERVER_FRAME_HEADERS)
        : undefined
    const ref = ends?.isOk() === true ? (ends.value.header[0] ?? 0) : undefined
    for (const connectionId of connectionIds) {
      const connection = this._connections.get(connectionId)
      if (connection === undefined) continue
      this._host.sendFrame(connection, frame)
      if (ref !== undefined) connection._remoteSeats.delete(ref)
    }
  }

  /**
   * The process owning some of our seats is gone (spec §6.4, failure).
   * Those rooms are unreachable, so the clients hear it the way they hear
   * any room ending: `LEAVE(roomRef, 4002 ROOM_DISPOSED)`. The connection
   * stays open — its other seats are unaffected.
   */
  private _ownerProcessLost(processId: string): void {
    for (const connection of this._connections.values()) {
      for (const [ref, seat] of [...connection._remoteSeats]) {
        if (seat.processId !== processId) continue
        connection._remoteSeats.delete(ref)
        this._logger.warn(
          `room ${seat.roomId} is unreachable: process ${processId} is gone`,
        )
        const frame = encodeFrame(ServerFrameType.LEAVE, [
          ref,
          LeaveCode.ROOM_DISPOSED,
        ])
        if (frame.isOk()) this._host.sendFrame(connection, frame.value)
      }
    }
  }

  /**
   * Hands a resolved `JOIN` to the process that owns the room. The
   * `roomRef` is allocated **here**, on the connection it belongs to, and
   * the owner builds every frame with it (PROTOCOL.md §3.1). Refs are
   * never reused on a connection, so a refused join simply burns one.
   */
  private async _forwardJoin(
    connection: Connection,
    requestId: number,
    processId: string,
    options: unknown,
    hash: string | null,
    target: JoinTarget,
  ): Promise<Result<Routed, BungohanError>> {
    const cluster = this._cluster
    if (cluster === undefined) {
      return err(this._error("ROOM_NOT_FOUND", "cluster mode is not running"))
    }
    const roomRef = connection._nextRoomRef++
    connection._remoteOwners.add(processId)
    const reply = await cluster.forwardJoin(processId, {
      connectionId: connection.id,
      roomRef,
      requestId,
      target,
      options,
      hash,
      context: packContext(connection.context),
    })
    if (reply.isErr()) {
      return err(this._error(reply.error.code, reply.error.message))
    }
    connection._remoteSeats.set(roomRef, {
      processId,
      roomId: reply.value.roomId,
      sessionId: reply.value.sessionId,
    })
    if (!connection._open) {
      // It closed while the owner was seating us; tell it now, since
      // `_handleDisconnect` had nothing to report yet.
      connection._remoteSeats.delete(roomRef)
      cluster.notifyConnectionClosed(processId, connection.id)
    }
    return ok({ kind: "remote" })
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
      limits: this._limits,
      queuedFor: (connection) => this._queuedFor(connection),
      shed: (connection, why) => this._shed(connection, why),
      sendFrame: (connection, frame) => {
        if (!connection._open) return
        if (this._metrics !== undefined) {
          this._metrics.bytesSent += frame.byteLength
        }
        // A seat whose socket is on another process: the frame is already
        // addressed with that connection's roomRef, so it is relayed
        // unchanged (spec §6.4).
        if (isRemoteConnection(connection)) {
          this._cluster?.sendFrames(
            connection.processId,
            [connection.connectionId],
            frame,
          )
          return
        }
        const sent = this._transport.send(connection.id, frame)
        if (sent.isErr())
          this._logger.debug(`send failed: ${sent.error.message}`)
        this._checkQueue(connection)
      },
      broadcastFrame: (connections, frame) => {
        const ids: string[] = []
        let remote: Map<string, string[]> | undefined
        let count = 0
        for (const connection of connections) {
          if (!connection._open) continue
          count++
          if (isRemoteConnection(connection)) {
            remote ??= new Map()
            const list = remote.get(connection.processId)
            if (list === undefined) {
              remote.set(connection.processId, [connection.connectionId])
            } else list.push(connection.connectionId)
          } else ids.push(connection.id)
        }
        if (count === 0) return
        if (this._metrics !== undefined) {
          this._metrics.bytesSent += frame.byteLength * count
        }
        if (remote !== undefined) {
          for (const [processId, connectionIds] of remote) {
            this._cluster?.sendFrames(processId, connectionIds, frame)
          }
        }
        if (ids.length === 0) return
        const sent = this._transport.broadcast(ids, frame)
        if (sent.isErr()) {
          this._logger.debug(`broadcast failed: ${sent.error.message}`)
        }
        for (const connection of connections) {
          if (!isRemoteConnection(connection)) this._checkQueue(connection)
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
