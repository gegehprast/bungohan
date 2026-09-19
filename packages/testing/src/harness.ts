/**
 * The server half of the §11.2 harness: a real `BungohanServer` on a
 * `LoopbackTransport`, driven by a `ManualClock`. Deterministic: time moves
 * only through `tick()`, frames only through `flush()`.
 */
import {
  BungohanServer,
  type DefineRoomOptions,
  type Room,
  type RoomClass,
  type ServerOptions,
} from "@bungohan/core"
import { PROTOCOL_VERSION } from "@bungohan/types"
import { ManualClock } from "./clock"
import { type DriverOptions, TestClient } from "./driver"
import {
  type LoopbackConnectOptions,
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

export class ServerHarness {
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

/** Creates and starts a {@link ServerHarness}. */
export async function createServerHarness(
  options: ServerHarnessOptions = {},
): Promise<ServerHarness> {
  return new ServerHarness(options).start()
}
