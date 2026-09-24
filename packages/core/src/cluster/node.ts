/**
 * One process's half of the cluster (spec §6.4): the backplane
 * subscriptions, the peer registry, the request/response bookkeeping, and
 * the routing of everything that crosses between processes.
 *
 * It owns no policy. What to do with an incoming request is the server's
 * ({@link ClusterHandlers}); this class decides only *where* a message goes
 * and *when* a caller gives up.
 */
import type { IBackplane } from "@bungohan/backplane"
import { err, ok, type Result } from "@bungohan/result"
import type { ISerializer } from "@bungohan/serializer"
import type { Clock, Reservation } from "@bungohan/types"
import { BungohanError, type ErrorCode } from "../errors"
import type { Logger } from "../logger"
import type { ProcessInfo, RoomListingInfo } from "../types"
import {
  allChannel,
  asClusterMessage,
  binaryRoundTripProblem,
  CLUSTER_PROTOCOL,
  type ClusterPayload,
  type JoinForwardRequest,
  type JoinTarget,
  processChannel,
  type RoomInfo,
  type RoomOp,
  type WireContext,
} from "./protocol"
import { PeerRegistry } from "./registry"
import { PendingRequests, type RequestFailure } from "./requests"

/**
 * The cluster's timings, all in milliseconds on the server's `Clock`. Set
 * them through `ServerOptions.cluster`.
 */
export interface ClusterTimings {
  /** How often this process announces itself. Default 2,000 ms. */
  heartbeatInterval: number
  /** Silence after which a peer is declared dead. Default 6,000 ms. */
  peerTimeout: number
  /** How long a directed request waits for its reply. Default 5,000 ms. */
  requestTimeout: number
  /**
   * How long a broadcast (process list, room lookup, query) collects
   * answers. Default 200 ms.
   */
  gatherTimeout: number
}

/** The defaults `ServerOptions.cluster` falls back to. */
export const DEFAULT_CLUSTER_TIMINGS: ClusterTimings = {
  heartbeatInterval: 2_000,
  peerTimeout: 6_000,
  requestTimeout: 5_000,
  gatherTimeout: 200,
}

/** What the owning or edge process does with what arrives. */
export interface ClusterHandlers {
  /** This process's own `ProcessInfo`, with no round trip. */
  localProcessInfo(): ProcessInfo
  /** True if this process owns that room (and it isn't being disposed). */
  hasRoom(roomId: string): boolean
  /** True if this process holds that reservation (consumed or not). */
  hasReservation(reservationId: string): boolean
  /** An available room of the type on this process, if any. */
  findAvailable(
    roomType: string,
    exclude: readonly string[],
  ): string | undefined
  /** This process's listings for a `query`. */
  listRooms(
    roomType: string,
    metadata: Record<string, unknown> | undefined,
    includePrivate: boolean,
    includeDraining: boolean,
  ): RoomListingInfo[]
  /** Creates a room here, for a peer's `createRoom`. */
  createRoom(
    roomType: string,
    options: unknown,
  ): Promise<Result<RoomInfo, BungohanError>>
  /** Reserves a seat in a room here, for a peer's `reserve`. */
  reserve(
    roomId: string,
    options: unknown,
  ): Promise<Result<Reservation, BungohanError>>
  /** Runs one `RoomProxy` operation against a room here. */
  roomOp(roomId: string, call: RoomOp): Result<unknown, BungohanError>
  /** Owner side: runs a join a peer resolved to a room here. */
  remoteJoin(request: JoinForwardRequest): Promise<void>
  /** Owner side: a room message from a seat whose socket is elsewhere. */
  remoteMessage(
    edgeProcessId: string,
    roomId: string,
    sessionId: string,
    connectionId: string,
    raw: boolean,
    messageId: number,
    body: Uint8Array,
  ): void
  /** Owner side: the client asked to leave. */
  remoteLeave(edgeProcessId: string, roomId: string, sessionId: string): void
  /** Owner side: an edge connection closed (or its process died). */
  edgeConnectionClosed(processId: string, connectionId: string): void
  /** Owner side: the whole edge process is gone. */
  edgeProcessLost(processId: string): void
  /** Edge side: relay finished frames to local connections. */
  relayFrames(connectionIds: string[], frame: Uint8Array): void
  /** Edge side: the owner refused a frame as a protocol violation. */
  relayViolation(connectionId: string, why: string): void
  /** Edge side: the process owning some of our seats is gone. */
  ownerProcessLost(processId: string): void
}

export interface ClusterNodeOptions {
  readonly backplane: IBackplane
  /**
   * The server's serializer (MessagePack by default). The same one that
   * decoded a value off the wire re-encodes it for the backplane, so a
   * handler on the owning process receives exactly what a handler here
   * would (spec §6.4.1).
   */
  readonly serializer: ISerializer
  readonly processId: string
  readonly namespace: string
  readonly clock: Clock
  readonly logger: Logger
  readonly timings: ClusterTimings
  readonly createId: () => string
  readonly handlers: ClusterHandlers
}

/**
 * Cluster mode for one `BungohanServer`: this process's backplane
 * subscriptions, its view of the other processes, and the routing of
 * everything that crosses between them. Created by `server.start()` when
 * `cluster.enabled` is set, torn down by `stop()`; `server.getCluster()`
 * returns it. You rarely call it directly: the matchmaker and
 * `RoomProxy` use it.
 */
export class ClusterNode {
  private readonly _options: ClusterNodeOptions
  private readonly _all: string
  private readonly _own: string
  private readonly _pending: PendingRequests
  private readonly _registry: PeerRegistry
  private _running = false

  public constructor(options: ClusterNodeOptions) {
    this._options = options
    this._all = allChannel(options.namespace)
    this._own = processChannel(options.namespace, options.processId)
    this._pending = new PendingRequests(options.clock, options.createId)
    this._registry = new PeerRegistry({
      clock: options.clock,
      heartbeatInterval: options.timings.heartbeatInterval,
      peerTimeout: options.timings.peerTimeout,
      beat: () => this._beat(),
      onLost: (peer) => this._peerLost(peer),
    })
  }

  /** This process's id in the cluster. */
  public get processId(): string {
    return this._options.processId
  }

  /** True between a successful `start()` and `stop()`. */
  public get isRunning(): boolean {
    return this._running
  }

  /** Peers this process currently believes are alive. */
  public peers(): string[] {
    return this._registry.list().map((peer) => peer.id)
  }

  /**
   * Peers that said in their last heartbeat that they take new rooms,
   * least loaded first (rooms, then seats). No round trip: a draining
   * process uses it to place a client's new room elsewhere without adding
   * a collection window to the join. It can be a heartbeat stale, so the
   * chosen peer may still refuse.
   */
  public placementCandidates(): ProcessInfo[] {
    return this._registry
      .list()
      .filter((peer) => !peer.draining)
      .sort(
        (a, b) => a.roomCount - b.roomCount || a.clientCount - b.clientCount,
      )
      .map((peer) => ({
        id: peer.id,
        roomCount: peer.roomCount,
        clientCount: peer.clientCount,
        metadata: peer.metadata,
        draining: peer.draining,
      }))
  }

  /**
   * Publishes a heartbeat now rather than at the next interval, so peers
   * learn at once that this process started or stopped draining, or
   * changed its metadata.
   */
  public announce(): void {
    if (this._running) this._beat()
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  /**
   * Subscribes to the backplane and announces this process. Fails with
   * `INVALID_OPTIONS` for a serializer that doesn't round-trip binary
   * (frames are relayed inside backplane messages), or
   * `CONNECTION_FAILED` when the backplane can't subscribe.
   */
  public async start(): Promise<Result<void, BungohanError>> {
    // Before anything else, and exactly once: a serializer that can't
    // carry binary would break frame relay at runtime, in cluster mode
    // only, with no other symptom (spec §6.4.1).
    const { serializer } = this._options
    const problem = binaryRoundTripProblem(serializer)
    if (problem !== undefined) {
      return err(
        new BungohanError(
          "INVALID_OPTIONS",
          `cluster mode relays client frames as binary inside backplane ` +
            `messages, but the "${serializer.getName()}" serializer does ` +
            `not round-trip a Uint8Array: ${problem}. Use the default ` +
            `MessagePackSerializer, or a serializer whose encode/decode ` +
            `preserves binary exactly (ServerOptions.serializer).`,
          this._options.clock.now(),
        ),
      )
    }
    const { backplane } = this._options
    const receive = (data: Uint8Array): void => this._receive(data)
    const own = await backplane.subscribe(this._own, receive)
    if (own.isErr()) return err(this._error("CONNECTION_FAILED", own.error))
    const all = await backplane.subscribe(this._all, receive)
    if (all.isErr()) {
      await backplane.unsubscribe(this._own)
      return err(this._error("CONNECTION_FAILED", all.error))
    }
    this._running = true
    this._registry.start()
    // Announce ourselves and ask everyone else to do the same, so the
    // first matchmaking call doesn't wait for a heartbeat interval.
    this._publish(this._all, { t: "hello" })
    this._beat()
    return ok(undefined)
  }

  /**
   * Says goodbye to the other processes, fails requests still waiting
   * (with `INVALID_STATE`), and unsubscribes.
   */
  public async stop(): Promise<void> {
    if (!this._running) return
    this._running = false
    this._publish(this._all, { t: "bye" })
    this._registry.stop()
    this._pending.stop()
    const { backplane } = this._options
    await backplane.unsubscribe(this._all)
    await backplane.unsubscribe(this._own)
  }

  // ==========================================================================
  // Outbound: matchmaking
  // ==========================================================================

  /**
   * Every process that answers within `gatherTimeout`, plus this one,
   * which is included without a round trip.
   */
  public async processes(): Promise<ProcessInfo[]> {
    const local = this._options.handlers.localProcessInfo()
    if (!this._running) return [local]
    const { rid, answer } = this._pending.gather<ProcessInfo>(
      this._options.timings.gatherTimeout,
    )
    this._publish(this._all, { t: "pi?", rid })
    const replies = await answer
    const seen = new Set([local.id])
    const out = [local]
    for (const info of replies) {
      if (seen.has(info.id)) continue
      seen.add(info.id)
      out.push(info)
    }
    return out
  }

  /** The process that owns a room id, or holds a reservation id. */
  public async locate(
    kind: "room" | "reservation",
    key: string,
  ): Promise<string | undefined> {
    if (!this._running) return undefined
    const { rid, answer } = this._pending.first<string>(
      this._options.timings.gatherTimeout,
    )
    this._publish(this._all, { t: "loc?", rid, kind, key })
    const found = await answer
    return found.ok ? found.value : undefined
  }

  /** The first peer with an available room of the type, and that room. */
  public async findAvailable(
    roomType: string,
    exclude: string[] = [],
  ): Promise<{ processId: string; roomId: string } | undefined> {
    if (!this._running) return undefined
    const { rid, answer } = this._pending.first<{
      processId: string
      roomId: string
    }>(this._options.timings.gatherTimeout)
    this._publish(this._all, { t: "find?", rid, roomType, exclude })
    const found = await answer
    return found.ok ? found.value : undefined
  }

  /** Listings from every peer that answers within the window. */
  public async query(
    roomType: string,
    metadata: Record<string, unknown> | undefined,
    includePrivate: boolean,
    includeDraining: boolean,
  ): Promise<RoomListingInfo[]> {
    if (!this._running) return []
    const { rid, answer } = this._pending.gather<RoomListingInfo[]>(
      this._options.timings.gatherTimeout,
    )
    this._publish(this._all, {
      t: "q?",
      rid,
      roomType,
      ...(metadata === undefined ? {} : { metadata }),
      includePrivate,
      includeDraining,
    })
    return (await answer).flat()
  }

  /**
   * Asks `processId` to create a room of `roomType` with already-encoded
   * options. Fails with the owner's error, `TIMEOUT` after
   * `requestTimeout`, or `CONNECTION_LOST` if that process dies first.
   */
  public async createRoom(
    processId: string,
    roomType: string,
    options: unknown,
  ): Promise<Result<RoomInfo, BungohanError>> {
    return this._call<RoomInfo>(processId, (rid) => ({
      t: "create?",
      rid,
      roomType,
      options,
    }))
  }

  /** Asks `processId` to reserve a seat in its room (see `createRoom`). */
  public async reserve(
    processId: string,
    roomId: string,
    options: unknown,
  ): Promise<Result<Reservation, BungohanError>> {
    return this._call<Reservation>(processId, (rid) => ({
      t: "reserve?",
      rid,
      roomId,
      options,
    }))
  }

  /** Runs a `RoomProxy` operation on the room's process (see `createRoom`). */
  public async roomOp(
    processId: string,
    roomId: string,
    call: RoomOp,
  ): Promise<Result<unknown, BungohanError>> {
    return this._call<unknown>(processId, (rid) => ({
      t: "op?",
      rid,
      roomId,
      call,
    }))
  }

  // ==========================================================================
  // Outbound: a seat whose room is on another process
  // ==========================================================================

  /**
   * Hands a resolved `JOIN` to the owning process. The reply only says
   * whether the seat exists and what it is called; the owner sends
   * `JOIN_SUCCESS` (and everything after it) as ordinary frames on the same
   * channel, so the edge has the mapping before the first frame arrives.
   */
  public async forwardJoin(
    processId: string,
    request: {
      connectionId: string
      roomRef: number
      requestId: number
      target: JoinTarget
      options: unknown
      hash: string | null
      context: WireContext
      auth?: Record<string, unknown>
    },
  ): Promise<Result<{ roomId: string; sessionId: string }, BungohanError>> {
    const { rid, answer } = this._pending.single<{
      roomId?: string
      sessionId?: string
      code?: ErrorCode
      message?: string
    }>(processId, this._options.timings.requestTimeout)
    this._publish(processChannel(this._options.namespace, processId), {
      t: "join?",
      rid,
      ...request,
    })
    const reply = await answer
    if (!reply.ok) return err(this._failure(processId, reply.reason))
    const { roomId, sessionId, code, message } = reply.value
    if (roomId === undefined || sessionId === undefined) {
      return err(
        new BungohanError(
          code ?? "JOIN_FAILED",
          message ?? "the remote join failed",
          this._options.clock.now(),
        ),
      )
    }
    return ok({ roomId, sessionId })
  }

  /** A room message for a seat the owner holds. */
  public forwardMessage(
    processId: string,
    roomId: string,
    sessionId: string,
    connectionId: string,
    raw: boolean,
    messageId: number,
    body: Uint8Array,
  ): void {
    this._publish(processChannel(this._options.namespace, processId), {
      t: "msg",
      roomId,
      sessionId,
      connectionId,
      raw,
      messageId,
      body,
    })
  }

  /** A consented `LEAVE` for a seat the owner holds. */
  public forwardLeave(
    processId: string,
    roomId: string,
    sessionId: string,
  ): void {
    this._publish(processChannel(this._options.namespace, processId), {
      t: "leave",
      roomId,
      sessionId,
    })
  }

  /** One of our connections closed; its remote seats are the owner's now. */
  public notifyConnectionClosed(processId: string, connectionId: string): void {
    this._publish(processChannel(this._options.namespace, processId), {
      t: "conn",
      connectionId,
    })
  }

  /** Owner → edge: finished frames, relayed verbatim. */
  public sendFrames(
    processId: string,
    connectionIds: string[],
    frame: Uint8Array,
  ): void {
    if (connectionIds.length === 0) return
    this._publish(processChannel(this._options.namespace, processId), {
      t: "frames",
      to: connectionIds,
      body: frame,
    })
  }

  /** Owner → edge: this connection broke the protocol; close it. */
  public sendViolation(
    processId: string,
    connectionId: string,
    why: string,
  ): void {
    this._publish(processChannel(this._options.namespace, processId), {
      t: "violation",
      connectionId,
      why,
    })
  }

  /** Owner → edge: a join reply (see {@link forwardJoin}). */
  public sendJoinReply(
    processId: string,
    rid: string,
    reply: {
      roomId?: string
      sessionId?: string
      code?: ErrorCode
      message?: string
    },
  ): void {
    this._publish(processChannel(this._options.namespace, processId), {
      t: "join!",
      rid,
      ...reply,
    })
  }

  // ==========================================================================
  // Inbound
  // ==========================================================================

  private _receive(data: Uint8Array): void {
    const decoded = this._options.serializer.decode(data)
    if (decoded.isErr()) {
      this._options.logger.error(
        "[cluster] dropped an undecodable message:",
        decoded.error,
      )
      return
    }
    const message = asClusterMessage(decoded.value)
    if (message === undefined) return
    if (message.from === this._options.processId) return
    if (!this._running) return
    // Anything from a peer proves it is alive.
    if (message.t !== "bye") this._registry.seen(message.from)
    const handlers = this._options.handlers
    const { namespace } = this._options
    const back = processChannel(namespace, message.from)
    switch (message.t) {
      case "hello":
        this._beat()
        return
      case "hb":
        this._registry.seen(message.from, {
          rooms: message.rooms,
          clients: message.clients,
          draining: message.draining === true,
          meta: isRecord(message.meta) ? message.meta : {},
        })
        return
      case "bye":
        this._registry.gone(message.from)
        return

      case "pi?":
        this._publish(back, {
          t: "pi!",
          rid: message.rid,
          info: handlers.localProcessInfo(),
        })
        return
      case "loc?": {
        const found =
          message.kind === "room"
            ? handlers.hasRoom(message.key)
            : handlers.hasReservation(message.key)
        if (found) this._publish(back, { t: "loc!", rid: message.rid })
        return
      }
      case "find?": {
        const roomId = handlers.findAvailable(message.roomType, message.exclude)
        if (roomId !== undefined) {
          this._publish(back, { t: "find!", rid: message.rid, roomId })
        }
        return
      }
      case "q?":
        this._publish(back, {
          t: "q!",
          rid: message.rid,
          rooms: handlers.listRooms(
            message.roomType,
            message.metadata,
            message.includePrivate,
            message.includeDraining === true,
          ),
        })
        return
      case "create?":
        void handlers
          .createRoom(message.roomType, message.options)
          .then((created) =>
            this._publish(back, {
              t: "create!",
              rid: message.rid,
              ...this._outcome(created, "info"),
            }),
          )
        return
      case "reserve?":
        void handlers
          .reserve(message.roomId, message.options)
          .then((reserved) =>
            this._publish(back, {
              t: "reserve!",
              rid: message.rid,
              ...this._outcome(reserved, "reservation"),
            }),
          )
        return
      case "op?": {
        const done = handlers.roomOp(message.roomId, message.call)
        this._publish(back, {
          t: "op!",
          rid: message.rid,
          ...this._outcome(done, "value"),
        })
        return
      }

      case "join?":
        void handlers.remoteJoin(message)
        return
      case "msg":
        handlers.remoteMessage(
          message.from,
          message.roomId,
          message.sessionId,
          message.connectionId,
          message.raw,
          message.messageId,
          message.body,
        )
        return
      case "leave":
        handlers.remoteLeave(message.from, message.roomId, message.sessionId)
        return
      case "conn":
        handlers.edgeConnectionClosed(message.from, message.connectionId)
        return

      case "frames":
        handlers.relayFrames(message.to, message.body)
        return
      case "violation":
        handlers.relayViolation(message.connectionId, message.why)
        return

      case "pi!":
        this._pending.deliver(message.rid, message.info)
        return
      case "loc!":
        this._pending.deliver(message.rid, message.from)
        return
      case "find!":
        this._pending.deliver(message.rid, {
          processId: message.from,
          roomId: message.roomId,
        })
        return
      case "q!":
        this._pending.deliver(message.rid, message.rooms)
        return
      case "create!":
      case "reserve!":
      case "op!":
      case "join!":
        this._pending.deliver(message.rid, message)
        return
    }
  }

  private _peerLost(processId: string): void {
    this._pending.failPeer(processId)
    const handlers = this._options.handlers
    handlers.edgeProcessLost(processId)
    handlers.ownerProcessLost(processId)
  }

  // ==========================================================================
  // Helpers
  // ==========================================================================

  private async _call<T>(
    processId: string,
    build: (rid: string) => ClusterPayload,
  ): Promise<Result<T, BungohanError>> {
    if (!this._running) {
      return err(
        new BungohanError(
          "INVALID_STATE",
          "cluster mode is not running",
          this._options.clock.now(),
        ),
      )
    }
    const { rid, answer } = this._pending.single<{
      value?: unknown
      info?: unknown
      reservation?: unknown
      code?: ErrorCode
      message?: string
    }>(processId, this._options.timings.requestTimeout)
    this._publish(
      processChannel(this._options.namespace, processId),
      build(rid),
    )
    const reply = await answer
    if (!reply.ok) return err(this._failure(processId, reply.reason))
    const { code, message } = reply.value
    if (code !== undefined) {
      return err(
        new BungohanError(
          code,
          message ?? "the remote call failed",
          this._options.clock.now(),
        ),
      )
    }
    const carried =
      "info" in reply.value
        ? reply.value.info
        : "reservation" in reply.value
          ? reply.value.reservation
          : reply.value.value
    // The peer answered with the shape its handler returned.
    return ok(carried as T)
  }

  /** `{ code, message }` on failure, `{ [key]: value }` on success. */
  private _outcome<T>(
    result: Result<T, BungohanError>,
    key: string,
  ): Record<string, unknown> {
    if (result.isErr()) {
      return { code: result.error.code, message: result.error.message }
    }
    return { [key]: result.value }
  }

  /** Why a request ended without a reply. Never a hang (spec §6.4). */
  private _failure(processId: string, reason: RequestFailure): BungohanError {
    const now = this._options.clock.now()
    switch (reason) {
      case "peer-lost":
        return new BungohanError(
          "CONNECTION_LOST",
          `process ${processId} is gone`,
          now,
        )
      case "stopped":
        return new BungohanError(
          "INVALID_STATE",
          `this process stopped while waiting for ${processId}`,
          now,
        )
      default:
        return new BungohanError(
          "TIMEOUT",
          `process ${processId} did not answer in time`,
          now,
        )
    }
  }

  private _beat(): void {
    const info = this._options.handlers.localProcessInfo()
    this._publish(this._all, {
      t: "hb",
      rooms: info.roomCount,
      clients: info.clientCount,
      draining: info.draining,
      meta: info.metadata,
    })
  }

  /**
   * Publishes without awaiting: `sendFrame` is synchronous, and ordering
   * comes from the order commands are issued on one connection, not from
   * awaiting each one. A failure is logged, never thrown.
   */
  private _publish(channel: string, message: ClusterPayload): void {
    const full = {
      ...message,
      v: CLUSTER_PROTOCOL,
      from: this._options.processId,
    }
    const encoded = this._options.serializer.encode(full)
    if (encoded.isErr()) {
      this._options.logger.error(
        `[cluster] cannot encode a ${message.t} for ${channel}:`,
        encoded.error,
      )
      return
    }
    void this._options.backplane
      .publish(channel, encoded.value)
      .then((sent) => {
        if (sent.isErr()) {
          this._options.logger.error(
            `[cluster] publish to ${channel} failed:`,
            sent.error,
          )
        }
      })
      .catch((error: unknown) => {
        this._options.logger.error(`[cluster] publish threw:`, error)
      })
  }

  private _error(code: ErrorCode, error: Error): BungohanError {
    return new BungohanError(
      code,
      `cluster backplane: ${error.message}`,
      this._options.clock.now(),
      error,
    )
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
