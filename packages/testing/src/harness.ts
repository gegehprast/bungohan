/**
 * The test harness: a real `BungohanServer` on a `LoopbackTransport`,
 * driven by a `ManualClock`. Deterministic: time moves only through
 * `tick()`, `flushSync()` and automatic join delivery, frames only through
 * `flush()` (which those call). The server runs exactly as deployed: its
 * rooms sync only from their own loops, on the shared clock.
 *
 * - `ServerHarness` pairs it with the wire-level `TestClient` driver.
 * - `TestHarness` pairs it with real client-js clients.
 */
import {
  BungohanClient,
  type ClientOptions,
  type IBungohanClient,
} from "@bungohan/client-js"
import {
  BungohanServer,
  type DefineRoomOptions,
  type Room,
  type RoomClass,
  type RoomConstructor,
  type ServerOptions,
  type StateOf,
} from "@bungohan/core"
import { decodeFrame } from "@bungohan/serializer"
import {
  CLIENT_FRAME_HEADERS,
  ClientFrameType,
  PROTOCOL_VERSION,
  SERVER_FRAME_HEADERS,
  ServerFrameType,
} from "@bungohan/types"
import {
  LoopbackClientTransport,
  type LoopbackClientTransportOptions,
} from "./client-transport"
import { ManualClock } from "./clock"
import { type DriverOptions, TestClient } from "./driver"
import {
  type LoopbackConnectOptions,
  type LoopbackSocket,
  LoopbackTransport,
  type LoopbackTransportOptions,
} from "./loopback"

/** Options of both harnesses (`createServerHarness`, `createTestHarness`). */
export interface ServerHarnessOptions {
  /** Room types to define: `(server) => server.defineRoomType(…)`. */
  define?: (server: BungohanServer) => void
  /**
   * Anything but transport and clock, which the harness provides. Logging
   * defaults to silent and signal handlers are never installed.
   */
  server?: Omit<ServerOptions, "transport" | "clock">
  /** Options of the harness's loopback transport. */
  transport?: LoopbackTransportOptions
  /**
   * A clock to share with other harnesses. A {@link ClusterHarness} passes
   * one, so every process in the cluster runs on the same time.
   */
  clock?: ManualClock
}

/** What both harnesses share: server, loopback, clock and their controls. */
abstract class HarnessBase {
  /** The real server under test, as deployed except for transport and clock. */
  public readonly server: BungohanServer
  /**
   * The loopback the server listens on: `stats()` for bandwidth,
   * `stall()`/`disconnect()` to play the network.
   */
  public readonly transport: LoopbackTransport
  /** The one clock server and clients run on; `tick()` advances it. */
  public readonly clock: ManualClock
  /**
   * How `flush()` delivers frames. By default this harness's own
   * transport; a {@link ClusterHarness} replaces it with one that covers
   * every process, since a frame may be produced on another one.
   */
  protected _network: () => Promise<void> = async () => {
    ;(await this.transport.flush()).unwrap()
  }

  public constructor(options: ServerHarnessOptions = {}) {
    this.clock = options.clock ?? new ManualClock()
    this.transport = new LoopbackTransport(options.transport)
    this.server = new BungohanServer({
      logger: { level: "silent" },
      ...options.server,
      gracefulShutdown: {
        ...options.server?.gracefulShutdown,
        handleSignals: false,
      },
      transport: { provider: this.transport },
      clock: this.clock,
    })
    options.define?.(this.server)
  }

  /** Defines a room type (see `server.defineRoomType`). */
  public define<R extends Room>(
    name: string,
    RoomClass: RoomClass<R>,
    options?: DefineRoomOptions,
  ): this {
    this.server.defineRoomType(name, RoomClass, options)
    return this
  }

  /**
   * Starts the server. Throws (fails the test) if it can't start. The
   * `create*Harness` functions call it for you.
   */
  public async start(): Promise<this> {
    ;(await this.server.start()).unwrap()
    return this
  }

  /**
   * The server-side state of a room on this harness's server, typed by the
   * room class, so a test can read or change it while the room keeps
   * `state` protected. `room` is its id, or anything with an `id` (a
   * client-js room). Throws (fails the test) if there is no such room here
   * or it isn't a `RoomClass`.
   */
  public stateOf<R extends Room>(
    RoomClass: RoomConstructor<R>,
    room: string | { readonly id: string },
  ): StateOf<R> {
    const id = typeof room === "string" ? room : room.id
    const found = this.server.getMatchMaker().getRoom(id)
    if (found === undefined) throw new Error(`no room "${id}" on this server`)
    if (!(found instanceof RoomClass)) {
      throw new Error(`room "${id}" is not a ${RoomClass.name}`)
    }
    // An R holds a StateOf<R>: that is what the type parameter says.
    const state: unknown = found._peekState()
    return state as StateOf<R>
  }

  /** @internal Replaces how frames are delivered (a cluster harness). */
  public _setNetwork(network: () => Promise<void>): void {
    this._network = network
  }

  /** Delivers every queued frame and close (both directions). */
  public async flush(): Promise<void> {
    await this._network()
  }

  /**
   * Delivers what clients sent, advances the clock by `ms` (the rooms'
   * loops run whatever falls due), then flushes again.
   */
  public async tick(ms: number): Promise<void> {
    await this.flush()
    // Delivered in slices, not all at the end: a real socket drains while
    // time passes, and a client that received nothing for the whole span
    // would look to the server like one that stopped reading (spec §6.9).
    const step = this._deliveryStep()
    for (let left = ms; left > 0; ) {
      const slice = Math.min(step, left)
      await this.clock.advance(slice)
      await this.flush()
      left -= slice
    }
    if (ms <= 0) await this.clock.advance(ms)
    await this.flush()
  }

  /** How far the clock may move between deliveries: one sync period. */
  private _deliveryStep(): number {
    let step = Number.POSITIVE_INFINITY
    for (const room of this.server.getRoomManager().getRooms()) {
      const period = room._syncPeriodMs
      if (period !== undefined && period > 0) step = Math.min(step, period)
    }
    return Number.isFinite(step) ? Math.max(1, step) : Number.POSITIVE_INFINITY
  }

  /**
   * Lets every room reach a sync boundary through its own sync loop:
   * delivers what clients sent, then advances the clock by the longest
   * sync period among the rooms whose loop is running (time moves), then
   * flushes. A paused room doesn't sync, exactly as on a real server.
   */
  public async flushSync(): Promise<void> {
    let period = 0
    for (const room of this.server.getRoomManager().getRooms()) {
      period = Math.max(period, room._syncPeriodMs ?? 0)
    }
    await this.tick(period)
  }

  /** Bytes the server sent to clients since the last reset. */
  public bytesSent(): number {
    return this.transport.stats().bytesToClients
  }

  /** Bytes clients sent to the server since the last reset. */
  public bytesReceived(): number {
    return this.transport.stats().bytesFromClients
  }

  /** Zeroes the byte counters, e.g. after the joins a test doesn't measure. */
  public resetStats(): void {
    this.transport.resetStats()
  }

  /**
   * Stops the server gracefully (rooms disposed, clients told) and
   * delivers the goodbyes. Call it after each test.
   */
  public async stop(): Promise<void> {
    if (this.server.isRunning()) (await this.server.stop()).unwrap()
    await this.flush()
  }
}

/** The server half, with the wire-level {@link TestClient} driver. */
export class ServerHarness extends HarnessBase {
  /**
   * A new client connection speaking the wire protocol. It offers
   * `PROTOCOL_VERSION` unless `options.protocols` says otherwise.
   */
  public connect(
    options: LoopbackConnectOptions & DriverOptions = {},
  ): TestClient {
    const socket = this.transport
      .connect({ protocols: [PROTOCOL_VERSION], ...options })
      .unwrap()
    return new TestClient(socket, () => this.flush(), options)
  }
}

/** Creates and starts a {@link ServerHarness}. */
export async function createServerHarness(
  options: ServerHarnessOptions = {},
): Promise<ServerHarness> {
  return new ServerHarness(options).start()
}

/** Room types for {@link createTestHarness}: a class, or `[class, options]`. */
export type RoomTypes<T extends Record<string, Room>> = {
  [K in keyof T]:
    | RoomClass<T[K]>
    | readonly [RoomClass<T[K]>, DefineRoomOptions]
}

/** `createTestHarness`'s options. */
export interface TestHarnessOptions<
  T extends Record<string, Room> = Record<string, Room>,
> extends ServerHarnessOptions {
  /** Room types to define, by name. */
  rooms?: RoomTypes<T>
  /** Defaults for every `harness.connect()` (overridable per call). */
  client?: TestClientOptions
  /**
   * Deliver a client's `JOIN` automatically (default true): flush, then
   * advance the clock timer by timer until the join is through (its first
   * `STATE_SNAPSHOT`, sent at the room's next sync boundary, or an error).
   * That is what lets `await client.joinOrCreate(…)` resolve with no
   * manual pumping. Time moves as it would on a real server, typically up
   * to one sync period. Nothing else a client sends is delivered until the
   * test flushes or ticks. `harness.connect({ autoJoin })` overrides it for
   * one client.
   */
  autoJoin?: boolean
  /**
   * Real (wall-clock) milliseconds automatic join delivery waits for the
   * server to finish a join before moving the clock on. Default 0: no
   * waiting, which is right while `onAuth`, `onCreate` and `onJoin` wait
   * only on the room's clock or on in-process fakes.
   *
   * Set it when they await real I/O (a `fetch` to another process, a
   * database). Without it, simulated time races past the round trip: the
   * client's `joinTimeout` fires first, or, with no timer left to run,
   * delivery stops and the reply is never delivered. With it, the clock
   * stands still while a join's hooks run, up to this long at a time. A
   * hook that waits on the clock itself then costs up to this long of real
   * time per timer, so keep it close to the I/O's real latency. See
   * docs/guides/testing.md#real-io-in-join-hooks.
   */
  joinRealWait?: number
}

/** Harness-only options of one client (see {@link TestClientOptions}). */
export interface TestClientExtras {
  /**
   * Deliver this client's joins automatically. Defaults to the harness's
   * `autoJoin`. With `false`, its `JOIN` waits in the loopback until the
   * test calls `flush()` or `tick()`, while other clients' joins still
   * complete by themselves: the way to hold one join in flight.
   */
  autoJoin?: boolean
}

/** client-js options a harness client can take (plus loopback extras). */
export type TestClientOptions = Partial<
  Omit<ClientOptions, "transport" | "clock">
> &
  Omit<
    LoopbackClientTransportOptions,
    "offline" | "onSend" | "onReceive" | "onClose"
  > &
  TestClientExtras

/**
 * The full harness (see docs/guides/testing.md): a real server and real
 * client-js clients over the loopback, on one `ManualClock` (so
 * reconnection backoff and PING are driven by `tick()` too). `TestClient`
 * stays available through {@link driver} as the byte-level reference.
 */
export class TestHarness extends HarnessBase {
  /** While true, harness clients can't connect (reconnection tests). */
  public offline = false
  private readonly _clientDefaults: TestClientOptions
  private readonly _autoJoin: boolean
  private readonly _joinRealWait: number
  private readonly _transports = new Map<
    IBungohanClient,
    LoopbackClientTransport
  >()
  private readonly _clients: BungohanClient[] = []
  private readonly _joins = new Set<JoinTracker>()
  /** Serializes automatic join delivery. */
  private _pumping: Promise<void> = Promise.resolve()

  public constructor(options: TestHarnessOptions = {}) {
    super(options)
    this._clientDefaults = options.client ?? {}
    this._autoJoin = options.autoJoin ?? true
    this._joinRealWait = Math.max(0, options.joinRealWait ?? 0)
    for (const [name, entry] of Object.entries(options.rooms ?? {})) {
      if (Array.isArray(entry)) {
        const [RoomClass, roomOptions] = entry
        this.server.defineRoomType(name, RoomClass, roomOptions)
      } else {
        this.server.defineRoomType(name, entry as RoomClass)
      }
    }
  }

  /**
   * A connected client-js client on this harness's loopback and clock.
   * Throws (fails the test) if it can't connect.
   */
  public async connect(
    options: TestClientOptions = {},
  ): Promise<BungohanClient> {
    const merged = { ...this._clientDefaults, ...options }
    const {
      ip,
      headers,
      searchParams,
      autoJoin = this._autoJoin,
      ...clientOptions
    } = merged
    const joins = new JoinTracker()
    // Only automatically delivered joins keep delivery going.
    if (autoJoin) this._joins.add(joins)
    const transport = new LoopbackClientTransport(this.transport, {
      ...(ip === undefined ? {} : { ip }),
      ...(headers === undefined ? {} : { headers }),
      ...(searchParams === undefined ? {} : { searchParams }),
      offline: () => this.offline,
      onSend: (data) => {
        if (joins.sent(data) && autoJoin) this._pumpJoins()
      },
      onReceive: (data) => joins.received(data),
      onClose: () => joins.reset(),
    })
    const client = new BungohanClient({
      url: "ws://loopback.test/",
      ...clientOptions,
      autoConnect: false,
      transport,
      clock: this.clock,
    })
    this._transports.set(client, transport)
    this._clients.push(client)
    ;(await client.connect()).unwrap()
    return client
  }

  /** A wire-level {@link TestClient} on the same server (byte assertions). */
  public driver(options: LoopbackConnectOptions & DriverOptions = {}) {
    const socket = this.transport
      .connect({ protocols: [PROTOCOL_VERSION], ...options })
      .unwrap()
    return new TestClient(socket, () => this.flush(), options)
  }

  /**
   * The loopback socket of a harness client's current connection, to act
   * on it from the server side (`transport.disconnect(socket.clientId)`,
   * inject frames with `transport.send`).
   */
  public socketOf(client: IBungohanClient): LoopbackSocket {
    const socket = this._transports.get(client)?.socket
    if (socket === undefined) throw new Error("not a connected harness client")
    return socket
  }

  /**
   * Drops a client's connection as the network would (the server sees an
   * unconsented disconnect, the client an abnormal close), then flushes.
   */
  public async dropConnection(client: IBungohanClient, code = 1006) {
    this.transport.disconnect(this.socketOf(client).clientId, code, "dropped")
    await this.flush()
  }

  /**
   * Delivers every queued frame and close, waits for automatic join
   * delivery in progress, and runs clock timers that are already due
   * (`advance(0)`): client-js defers work to its clock's next turn with
   * 0 ms timers (e.g. releasing a new room's held frames), which a real
   * clock runs on the next macrotask. Time does not move.
   */
  public override async flush(): Promise<void> {
    await super.flush()
    await this._settlePumps()
    await this.clock.advance(0)
    await super.flush()
    await this._settlePumps()
  }

  /** Disconnects every harness client, then stops the server. */
  public override async stop(): Promise<void> {
    for (const client of this._clients) await client.disconnect()
    await super.stop()
  }

  /**
   * Automatic join delivery. A join completes with its first snapshot,
   * which a room sends at its next sync boundary, so this moves the clock
   * timer by timer (every loop and timeout runs as it falls due) until
   * every join clients have in flight is through: snapshot received, join
   * refused, or given up by the client. Nothing is short-circuited, so a
   * join takes exactly as long as it would on a real server. With
   * `joinRealWait`, a join the server is still working on gets that much
   * real time to finish before the clock moves.
   */
  private _pumpJoins(): void {
    this._pumping = this._pumping.then(async () => {
      const limit = this.clock.now() + JOIN_DELIVERY_LIMIT_MS
      await this._network()
      while ([...this._joins].some((joins) => joins.pending)) {
        if (await this._serverJoinFinished()) {
          await this._network()
          continue
        }
        const due = this.clock.nextDue()
        if (due === undefined || due > limit) {
          if (this.server._joinActivity().running > 0) {
            console.warn(STUCK_JOIN_WARNING)
          }
          break
        }
        await this.clock.advanceTo(due)
        await this._network()
      }
    })
  }

  /**
   * Waits up to `joinRealWait` of real time while the server is working on
   * a join; true once one finished (without the clock moving).
   */
  private async _serverJoinFinished(): Promise<boolean> {
    if (this._joinRealWait <= 0) return false
    const before = this.server._joinActivity()
    if (before.running === 0) return false
    const deadline = performance.now() + this._joinRealWait
    while (performance.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1))
      if (this.server._joinActivity().settled !== before.settled) return true
    }
    return false
  }

  /** Waits for automatic join delivery, including deliveries it started. */
  private async _settlePumps(): Promise<void> {
    let pumping: Promise<void>
    do {
      pumping = this._pumping
      await pumping
    } while (pumping !== this._pumping)
  }
}

/**
 * Simulated time automatic join delivery gives up after (a join the server
 * never completes, e.g. one the client abandoned without telling it).
 */
const JOIN_DELIVERY_LIMIT_MS = 60_000

const STUCK_JOIN_WARNING =
  "[bungohan/testing] automatic join delivery stopped while the server was " +
  "still running a join's hooks: onAuth, onCreate or onJoin is awaiting " +
  "something other than the harness clock (a real fetch?). Pass " +
  "createTestHarness({ joinRealWait: <ms> }) so real I/O can finish; see " +
  "docs/guides/testing.md#real-io-in-join-hooks"

/**
 * One harness client's joins in flight, followed through its frames: a
 * `JOIN` is pending until its `JOIN_ERROR`, or until the `STATE_SNAPSHOT`
 * (or `LEAVE`) of the roomRef its `JOIN_SUCCESS` assigned.
 */
class JoinTracker {
  private readonly _requests = new Set<number>()
  private readonly _refs = new Set<number>()

  public get pending(): boolean {
    return this._requests.size > 0 || this._refs.size > 0
  }

  /** A frame the client sent; true if it is a `JOIN`. */
  public sent(data: Uint8Array): boolean {
    const frame = decodeFrame(data, CLIENT_FRAME_HEADERS)
    if (frame.isErr()) return false
    const [first = 0] = frame.value.header
    if (frame.value.type === ClientFrameType.JOIN) {
      this._requests.add(first)
      return true
    }
    // A client that gave up on a join (timeout) leaves the seat it got.
    if (frame.value.type === ClientFrameType.LEAVE) this._refs.delete(first)
    return false
  }

  public received(data: Uint8Array): void {
    const frame = decodeFrame(data, SERVER_FRAME_HEADERS)
    if (frame.isErr()) return
    const [first = 0, second = 0] = frame.value.header
    switch (frame.value.type) {
      case ServerFrameType.JOIN_SUCCESS:
        this._requests.delete(first)
        this._refs.add(second)
        return
      case ServerFrameType.JOIN_ERROR:
        this._requests.delete(first)
        return
      case ServerFrameType.STATE_SNAPSHOT:
      case ServerFrameType.LEAVE:
        this._refs.delete(first)
    }
  }

  /** The connection closed: nothing in flight on it completes. */
  public reset(): void {
    this._requests.clear()
    this._refs.clear()
  }
}

/**
 * Creates and starts a {@link TestHarness}:
 *
 * ```ts
 * const harness = await createTestHarness({ rooms: { shooter: ShooterRoom } })
 * const client = await harness.connect()
 * const room = (await client.joinOrCreate("shooter", {}, { state, contract })).unwrap()
 * ```
 */
export async function createTestHarness<T extends Record<string, Room>>(
  options: TestHarnessOptions<T> = {},
): Promise<TestHarness> {
  // The per-entry RoomClass<T[K]> checks happened at the call site.
  const erased: unknown = options
  return new TestHarness(erased as TestHarnessOptions).start()
}
