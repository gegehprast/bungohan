/**
 * The §11.2 harness: a real `BungohanServer` on a `LoopbackTransport`,
 * driven by a `ManualClock`. Deterministic: time moves only through
 * `tick()`, frames only through `flush()`.
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
  type ServerOptions,
} from "@bungohan/core"
import { ClientFrameType, PROTOCOL_VERSION } from "@bungohan/types"
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

export interface ServerHarnessOptions {
  /** Room types to define: `(server) => server.defineRoomType(…)`. */
  define?: (server: BungohanServer) => void
  /** Anything but transport and clock, which the harness provides. */
  server?: Omit<ServerOptions, "transport" | "clock">
  transport?: LoopbackTransportOptions
}

/** What both harnesses share: server, loopback, clock and their controls. */
abstract class HarnessBase {
  public readonly server: BungohanServer
  public readonly transport: LoopbackTransport
  public readonly clock: ManualClock

  public constructor(options: ServerHarnessOptions = {}) {
    this.clock = new ManualClock()
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

  public async start(): Promise<this> {
    ;(await this.server.start()).unwrap()
    return this
  }

  /** Delivers every queued frame and close (both directions). */
  public async flush(): Promise<void> {
    ;(await this.transport.flush()).unwrap()
  }

  /** Advances the clock by `ms` (running due ticks), then flushes. */
  public async tick(ms: number): Promise<void> {
    await this.clock.advance(ms)
    await this.flush()
  }

  /** Runs one sync boundary in every room now, then flushes. */
  public async flushSync(): Promise<void> {
    for (const room of this.server.getRoomManager().getRooms()) {
      room._syncNow()
    }
    await this.flush()
  }

  /** Bytes the server sent to clients since the last reset. */
  public bytesSent(): number {
    return this.transport.stats().bytesToClients
  }

  /** Bytes clients sent to the server since the last reset. */
  public bytesReceived(): number {
    return this.transport.stats().bytesFromClients
  }

  public resetStats(): void {
    this.transport.resetStats()
  }

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

export interface TestHarnessOptions<
  T extends Record<string, Room> = Record<string, Room>,
> extends ServerHarnessOptions {
  /** Room types to define, by name. */
  rooms?: RoomTypes<T>
  /** Defaults for every `harness.connect()` (overridable per call). */
  client?: TestClientOptions
  /**
   * Deliver a client's `JOIN` automatically (default true): flush, run one
   * sync boundary, flush again. That is what lets
   * `await client.joinOrCreate(…)` resolve with no manual pumping, since a
   * join completes only with its first `STATE_SNAPSHOT`. Nothing else a
   * client sends is delivered until the test flushes or ticks.
   */
  autoJoin?: boolean
}

/** client-js options a harness client can take (plus loopback extras). */
export type TestClientOptions = Partial<
  Omit<ClientOptions, "transport" | "clock">
> &
  Omit<LoopbackClientTransportOptions, "offline" | "onSend">

/**
 * The full §11.2 harness: a real server and real client-js clients over
 * the loopback, on one `ManualClock` (so reconnection backoff and PING
 * are driven by `tick()` too). `TestClient` stays available through
 * {@link driver} as the byte-level reference.
 */
export class TestHarness extends HarnessBase {
  /** While true, harness clients can't connect (reconnection tests). */
  public offline = false
  private readonly _clientDefaults: TestClientOptions
  private readonly _autoJoin: boolean
  private readonly _transports = new Map<
    IBungohanClient,
    LoopbackClientTransport
  >()
  private readonly _clients: BungohanClient[] = []
  /** Serializes automatic join delivery. */
  private _pumping: Promise<void> = Promise.resolve()

  public constructor(options: TestHarnessOptions = {}) {
    super(options)
    this._clientDefaults = options.client ?? {}
    this._autoJoin = options.autoJoin ?? true
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
    const { ip, headers, searchParams, ...clientOptions } = merged
    const transport = new LoopbackClientTransport(this.transport, {
      ...(ip === undefined ? {} : { ip }),
      ...(headers === undefined ? {} : { headers }),
      ...(searchParams === undefined ? {} : { searchParams }),
      offline: () => this.offline,
      onSend: (data) => {
        if (this._autoJoin && data[0] === ClientFrameType.JOIN) {
          this._pumpJoin()
        }
      },
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
    await this._pumping
    await this.clock.advance(0)
    await super.flush()
  }

  /** Disconnects every harness client, then stops the server. */
  public override async stop(): Promise<void> {
    for (const client of this._clients) await client.disconnect()
    await super.stop()
  }

  private _pumpJoin(): void {
    this._pumping = this._pumping.then(async () => {
      ;(await this.transport.flush()).unwrap()
      for (const room of this.server.getRoomManager().getRooms()) {
        room._syncNow()
      }
      ;(await this.transport.flush()).unwrap()
    })
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
