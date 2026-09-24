/**
 * `ClusterHarness`: several `BungohanServer` processes in one `bun test`
 * process (spec §6.4).
 */
import {
  type IBackplane,
  MemoryBackplane,
  MemoryBus,
} from "@bungohan/backplane"
import type { Room, ServerOptions } from "@bungohan/core"
import { ManualClock } from "./clock"
import { type RoomTypes, TestHarness, type TestHarnessOptions } from "./harness"
import { settle } from "./settle"

type ClusterOptions = NonNullable<ServerOptions["cluster"]>

/** `createClusterHarness`'s options: a test harness's, plus the cluster's. */
export interface ClusterHarnessOptions<
  T extends Record<string, Room> = Record<string, Room>,
> extends Omit<TestHarnessOptions<T>, "clock"> {
  /** How many processes. Default 2. */
  size?: number
  /**
   * `IBackplane`s, one per node, in node order. Default: `MemoryBackplane`s
   * on one shared `MemoryBus`. Pass real `RedisBackplane`s to exercise that
   * path.
   */
  backplanes?: IBackplane[]
  /**
   * Channel prefix. Default: a fresh random one per harness, so parallel
   * runs (and leftovers in a real Redis) can't see each other.
   */
  namespace?: string
  /** Cluster timings for every node. */
  cluster?: Omit<ClusterOptions, "enabled" | "processId" | "backplane">
  /**
   * How `flush()` waits for backplane messages in flight. The default only
   * lets promise continuations run, which is all a `MemoryBackplane`
   * needs. A backplane that goes over a socket needs real time, so pass
   * something that waits for it — `flush()` then also requires several
   * consecutive quiet passes before it calls the cluster settled.
   */
  settle?: () => Promise<void>
}

/** How many full passes `flush()` makes before it gives up. */
const MAX_FLUSH_PASSES = 1_000

/** Simulated time `run()` gives work before declaring it stuck. */
const RUN_LIMIT_MS = 60_000

/**
 * Several server processes in one `bun test` process, for cluster mode
 * (see docs/guides/scaling.md#testing-a-cluster).
 *
 * Each node is a full {@link TestHarness}: its own server, its own
 * `LoopbackTransport`, its own clients. They share two things: one
 * `ManualClock`, so every heartbeat, timeout and sync loop in the cluster
 * runs on the same time a test advances, and one backplane bus, so they
 * actually talk. `flush()` covers every node's transport, because a frame
 * for a client on node 0 may be produced on node 1 and relayed back.
 *
 * ```ts
 * const cluster = await createClusterHarness({ size: 2, rooms: { game: GameRoom } })
 * const a = await cluster.connect(0) // socket on process 0
 * const room = (await a.joinOrCreate("game", {}, { state, contract })).unwrap()
 * ```
 */
export class ClusterHarness {
  /** The one clock every process runs on. */
  public readonly clock: ManualClock
  /** The processes, in order; node `i` has process id `p<i>`. */
  public readonly nodes: TestHarness[]
  /** The backplane channel prefix every node uses. */
  public readonly namespace: string
  private readonly _backplanes: IBackplane[]
  private readonly _ownsBackplanes: boolean
  private readonly _settle: () => Promise<void>
  private readonly _quietPasses: number

  public constructor(options: ClusterHarnessOptions = {}) {
    const size = options.size ?? 2
    this.clock = new ManualClock()
    this.namespace =
      options.namespace ?? `bgh-${crypto.randomUUID().slice(0, 8)}`
    this._ownsBackplanes = options.backplanes === undefined
    this._settle = options.settle ?? settle
    this._quietPasses = options.settle === undefined ? 1 : 3
    if (options.backplanes === undefined) {
      const bus = new MemoryBus()
      this._backplanes = Array.from({ length: size }, () => {
        return new MemoryBackplane(bus)
      })
    } else {
      this._backplanes = options.backplanes
    }
    const {
      size: _size,
      backplanes,
      namespace,
      cluster,
      settle: _settle,
      ...rest
    } = options
    this.nodes = this._backplanes.slice(0, size).map((backplane, index) => {
      const server: ServerHarnessServerOptions = {
        ...rest.server,
        cluster: {
          ...cluster,
          enabled: true,
          processId: `p${index}`,
          namespace: this.namespace,
          backplane: { provider: backplane },
        },
      }
      // The per-entry RoomClass checks happened at the call site.
      const erased: unknown = { ...rest, server, clock: this.clock }
      return new TestHarness(erased as TestHarnessOptions)
    })
    const network = (): Promise<void> => this._flushAll()
    for (const node of this.nodes) node._setNetwork(network)
  }

  /** Starts every process, in order. */
  public async start(): Promise<this> {
    for (const node of this.nodes) await node.start()
    // Let the HELLO/heartbeat round trip settle, so the first matchmaking
    // call sees the cluster rather than an empty peer list.
    await this.flush()
    return this
  }

  /** Node `index`. Throws (fails the test) if there is none. */
  public node(index: number): TestHarness {
    const node = this.nodes[index]
    if (node === undefined) throw new Error(`no node ${index} in the cluster`)
    return node
  }

  /** A connected client-js client whose socket is on `index`. */
  public connect(
    index: number,
    ...args: Parameters<TestHarness["connect"]>
  ): ReturnType<TestHarness["connect"]> {
    return this.node(index).connect(...args)
  }

  /** Delivers every queued frame on every process, and runs due timers. */
  public async flush(): Promise<void> {
    for (const node of this.nodes) await node.flush()
  }

  /**
   * Awaits work that needs the cluster to run: a cross-process call waits
   * for replies, and a collection window is a timer on the shared clock.
   * Delivers frames and advances timer by timer until `work` settles, so
   * nothing is short-circuited — it takes exactly the simulated time it
   * would take on real processes.
   */
  public async run<T>(work: Promise<T>, limitMs = RUN_LIMIT_MS): Promise<T> {
    let settled = false
    const tracked = work.then(
      (value) => {
        settled = true
        return { ok: true as const, value }
      },
      (error: unknown) => {
        settled = true
        return { ok: false as const, error }
      },
    )
    const limit = this.clock.now() + limitMs
    for (;;) {
      await this._flushAll()
      await settle()
      if (settled) break
      // A join's hooks awaiting real I/O: give them `joinRealWait` of real
      // time before the clock races past (to the client's joinTimeout).
      if (await this._realJoinProgress()) continue
      const due = this.clock.nextDue()
      if (due === undefined || due > limit) break
      await this.clock.advanceTo(due)
    }
    if (!settled) {
      throw new Error(
        `cluster.run(): the work never settled within ${limitMs} ms of ` +
          "simulated time, and no timer is left to fire",
      )
    }
    const outcome = await tracked
    if (!outcome.ok) throw outcome.error
    return outcome.value
  }

  /**
   * Delivers everything in flight, advances the shared clock by `ms`, then
   * delivers again, across every node.
   */
  public async tick(ms: number): Promise<void> {
    await this.flush()
    await this.clock.advance(ms)
    await this.flush()
  }

  /** Advances by the longest running sync period anywhere in the cluster. */
  public async flushSync(): Promise<void> {
    let period = 0
    for (const node of this.nodes) {
      for (const room of node.server.getRoomManager().getRooms()) {
        period = Math.max(period, room._syncPeriodMs ?? 0)
      }
    }
    await this.tick(period)
  }

  /**
   * Stops a process the way a crash does: it says no goodbye, so its peers
   * only notice when it stops heartbeating (`cluster.peerTimeout`). Its
   * backplane is closed behind its back and its sockets are dropped.
   */
  public async kill(index: number): Promise<void> {
    const node = this.node(index)
    const backplane = this._backplanes[index]
    await backplane?.close()
    await node.transport.close()
    await this.flush()
  }

  /** Stops every process gracefully, clients first. */
  public async stop(): Promise<void> {
    for (const node of this.nodes) {
      try {
        await node.stop()
      } catch {
        // A node killed mid-test has nothing left to stop.
      }
    }
    if (this._ownsBackplanes) {
      for (const backplane of this._backplanes) await backplane.close()
    }
    await this._flushAll()
  }

  /**
   * One delivery pass over every node's transport, repeated until nothing
   * is queued anywhere: a frame relayed through the backplane lands on
   * another node's transport after that node was already flushed.
   */
  /** True once a join some process was running finished in real time. */
  private async _realJoinProgress(): Promise<boolean> {
    for (const node of this.nodes) {
      if (await node._serverJoinFinished()) return true
    }
    return false
  }

  private async _flushAll(): Promise<void> {
    let quiet = 0
    for (let pass = 0; pass < MAX_FLUSH_PASSES; pass++) {
      for (const node of this.nodes) (await node.transport.flush()).unwrap()
      await this._settle()
      if (this.nodes.some((node) => node.transport.pending() > 0)) {
        quiet = 0
        continue
      }
      if (++quiet >= this._quietPasses) return
    }
    throw new Error(
      `cluster flush made ${MAX_FLUSH_PASSES} passes and frames kept ` +
        "arriving; processes may be replying to each other forever",
    )
  }
}

type ServerHarnessServerOptions = Omit<ServerOptions, "transport" | "clock">

/** Creates and starts a {@link ClusterHarness}. */
export async function createClusterHarness<T extends Record<string, Room>>(
  options: ClusterHarnessOptions<T> = {},
): Promise<ClusterHarness> {
  return new ClusterHarness(options).start()
}

export type { RoomTypes }
