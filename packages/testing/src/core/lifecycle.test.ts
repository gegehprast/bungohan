/**
 * Room lifecycle end to end: throwing hooks, leaving, kicking, disposal,
 * shutdown, server callbacks, persistence and startup validation.
 */
import { describe, expect, spyOn, test } from "bun:test"
import {
  BungohanServer,
  type Client,
  type Connection,
  Room,
} from "@bungohan/core"
import {
  createMap,
  createNumber,
  createSchemaMap,
  Schema,
} from "@bungohan/state"
import { MemoryStore } from "@bungohan/store"
import { defineContract, defineMessage, f, LeaveCode } from "@bungohan/types"
import { ManualClock } from "../clock"
import { createServerHarness } from "../harness"
import { LoopbackTransport } from "../loopback"
import { calls, faults, GameRoom, type GameState } from "./fixtures"
import { serverRoom, setup } from "./helpers"

describe("user code that throws never takes the room down", () => {
  test("a throwing message handler is reported; the room keeps going", async () => {
    const { h, join, errors } = await setup()
    const room = await join()
    await h.tick(50)
    room.send("boom", {})
    room.send("move", { dx: 2 })
    await h.flush()
    await h.tick(50)
    expect(errors).toHaveLength(1)
    const [error, context] = errors[0] ?? []
    expect(error?.message).toBe("handler exploded")
    expect(context?.source).toBe("onMessage")
    expect(context?.messageType).toBe("boom")
    expect(context?.client?.sessionId).toBe(room.sessionId)
    expect(room.state?.players.get(room.sessionId)?.x.get()).toBe(2)
    await h.stop()
  })

  test("a throwing onTick is reported every step; sync continues", async () => {
    const { h, join, errors } = await setup()
    const room = await join()
    faults.onTick = true
    await h.tick(50) // 3 simulation steps at 60 Hz, 1 sync
    expect(errors.length).toBe(3)
    expect(errors.every(([, ctx]) => ctx.source === "onTick")).toBe(true)
    expect(room.snapshots).toBe(1)
    await h.stop()
  })

  test("a throwing onLeave still releases the seat", async () => {
    const { h, join, errors } = await setup()
    const a = await join()
    const b = await join()
    faults.onLeave = true
    await a.leave()
    expect(errors.map(([e]) => e.message)).toEqual(["onLeave failed"])
    expect(b.left).toEqual([a.sessionId])
    expect(serverRoom(h, b).getClientCount()).toBe(1)
    await h.stop()
  })

  test("a throwing server callback is reported, not propagated", async () => {
    const { h, join, errors } = await setup()
    h.server.onJoin(() => {
      throw new Error("callback bug")
    })
    const room = await join()
    expect(room.sessionId).not.toBe("")
    expect(errors.map(([e, ctx]) => [e.message, ctx.source])).toEqual([
      ["callback bug", "callback"],
    ])
    await h.stop()
  })
})

describe("leaving", () => {
  test("consented LEAVE is acknowledged; the last leave disposes the room", async () => {
    const { h, join } = await setup()
    const a = await join()
    const b = await join()
    await a.leave()
    expect(a.leaveCode).toBe(LeaveCode.CONSENTED)
    expect(b.left).toEqual([a.sessionId])
    expect(calls).toContain(`onLeave ${a.sessionId} true`)
    await b.leave()
    expect(calls.at(-1)).toBe("onDispose")
    expect(h.server.getMatchMaker().getRoomCount()).toBe(0)
    await h.stop()
  })

  test("a kick sends LEAVE(4000) and keeps the connection open", async () => {
    const { h, join } = await setup()
    const client = h.connect()
    const a = await join(client)
    const b = await join()
    const server = serverRoom(h, a)
    const seat = server.getClient(a.sessionId)
    if (seat === undefined) throw new Error("no seat")
    server.disconnectClient(seat, LeaveCode.KICKED, "cheating")
    await h.flush()
    expect(a.leaveCode).toBe(4000)
    expect(a.leaveReason).toBe("cheating")
    expect(calls).toContain(`onLeave ${a.sessionId} false`)
    expect(b.left).toEqual([a.sessionId])
    expect(client.connected).toBe(true)
    // The same connection can join again (with a new roomRef).
    const back = await join(client)
    expect(back.roomRef).toBe(2)
    await h.stop()
  })

  test("disposing a room sends LEAVE(4002) to everyone", async () => {
    const { h, join } = await setup()
    const a = await join()
    await serverRoom(h, a).dispose()
    await h.flush()
    expect(a.leaveCode).toBe(LeaveCode.ROOM_DISPOSED)
    expect(calls.slice(-2)).toEqual([
      `onLeave ${a.sessionId} false`,
      "onDispose",
    ])
    await h.stop()
  })

  test("graceful stop: LEAVE(4001), onLeave, onDispose, then close 1001", async () => {
    const { h, join } = await setup()
    const client = h.connect()
    const a = await join(client)
    ;(await h.server.stop()).unwrap()
    await h.flush()
    expect(a.leaveCode).toBe(LeaveCode.SERVER_SHUTDOWN)
    expect(client.closeCode).toBe(1001)
    expect(calls.slice(-2)).toEqual([
      `onLeave ${a.sessionId} false`,
      "onDispose",
    ])
    expect(h.server.isRunning()).toBe(false)
  })

  test("SIGTERM runs the graceful shutdown and exits", async () => {
    // The harness turns signal handling off; this server keeps it on.
    const onShutdown: string[] = []
    const server = new BungohanServer({
      transport: { provider: new LoopbackTransport() },
      clock: new ManualClock(),
      logger: { level: "silent" },
      gracefulShutdown: {
        onShutdown: async () => {
          onShutdown.push("done")
        },
      },
    })
    const before = process.listenerCount("SIGTERM")
    ;(await server.start()).unwrap()
    expect(process.listenerCount("SIGTERM")).toBe(before + 1)
    const exit = spyOn(process, "exit")
    const exited = new Promise<number>((resolve) => {
      exit.mockImplementation(((code?: number) => {
        resolve(code ?? 0)
      }) as typeof process.exit)
    })
    process.emit("SIGTERM")
    expect(await exited).toBe(0)
    exit.mockRestore()
    expect(onShutdown).toEqual(["done"])
    expect(server.isRunning()).toBe(false)
    expect(process.listenerCount("SIGTERM")).toBe(before)
  })
})

describe("server callbacks", () => {
  test("onConnect, onJoin and onLeave", async () => {
    const { h, join } = await setup()
    const events: string[] = []
    h.server.onConnect((connection: Connection) =>
      events.push(`connect ${connection.id}`),
    )
    h.server.onJoin((client: Client, room: Room) =>
      events.push(`join ${client.sessionId} ${room.roomType}`),
    )
    const off = h.server.onLeave((client, _room, consented) =>
      events.push(`leave ${client.sessionId} ${consented}`),
    )
    const client = h.connect()
    const a = await join(client)
    await a.leave()
    off()
    expect(events).toEqual([
      `connect ${client.socket.clientId}`,
      `join ${a.sessionId} game`,
      `leave ${a.sessionId} true`,
    ])
    await h.stop()
  })
})

describe("tick rates", () => {
  class Counted extends Schema {
    public static override schemaName = "Rates.Counted"
    public n = createNumber()
  }
  const counts = { ticks: 0, syncs: 0 }
  class SlowRoom extends Room<Counted> {
    public override state = new Counted()
    protected override async onCreate(): Promise<void> {
      // The loops don't exist yet here; the rates must still apply.
      this.setSimulationTickRate(10)
      this.setStateSyncTickRate(4)
    }
    protected override onTick(): void {
      counts.ticks++
    }
    protected override onBeforeSync(): void {
      counts.syncs++
    }
  }

  test("rates set in onCreate take effect when the loops start", async () => {
    const h = await createServerHarness({
      define: (s) => s.defineRoomType("slow", SlowRoom),
    })
    ;(await h.connect().joinOrCreate("slow")).unwrap()
    counts.ticks = 0
    counts.syncs = 0
    await h.tick(1000)
    expect(counts).toEqual({ ticks: 10, syncs: 4 })
    await h.stop()
  })

  test("rates changed later restart the running loops", async () => {
    class Later extends SlowRoom {
      public speedUp(): void {
        this.setSimulationTickRate(20)
        this.setStateSyncTickRate(10)
      }
    }
    const h = await createServerHarness({
      define: (s) => s.defineRoomType("later", Later),
    })
    const view = (await h.connect().joinOrCreate("later")).unwrap()
    const room = h.server.getMatchMaker().getRoom(view.roomId)
    if (!(room instanceof Later)) throw new Error("no room")
    room.speedUp()
    counts.ticks = 0
    counts.syncs = 0
    await h.tick(1000)
    expect(counts).toEqual({ ticks: 20, syncs: 10 })
    await h.stop()
  })

  test("a room without onTick runs no simulation loop, and still syncs", async () => {
    class TurnRoom extends Room<Counted> {
      public override state = new Counted()
      public act(): void {
        this.state.n.set(this.state.n.get() + 1)
      }
    }
    const h = await createServerHarness({
      server: { metrics: { enabled: true } },
      define: (s) => s.defineRoomType("turn", TurnRoom),
    })
    const view = (
      await h.connect().joinOrCreate("turn", {}, { state: Counted })
    ).unwrap()
    const room = h.server.getMatchMaker().getRoom(view.roomId)
    if (!(room instanceof TurnRoom)) throw new Error("no room")
    await h.tick(1000)
    room.act()
    await h.flushSync()
    expect(view.state?.n.get()).toBe(1)
    const [metrics] = h.server.getAllRoomMetrics().unwrap()
    expect(metrics?.simulationTicks).toBe(0)
    expect(metrics?.stateSyncCount).toBeGreaterThan(0)
    await h.stop()
  })

  test("setSimulationTickRate(0) stops onTick until a positive rate", async () => {
    class Stopped extends SlowRoom {
      protected override async onCreate(): Promise<void> {
        await super.onCreate()
        this.setSimulationTickRate(0)
      }
      public restart(): void {
        this.setSimulationTickRate(5)
      }
    }
    const h = await createServerHarness({
      define: (s) => s.defineRoomType("stopped", Stopped),
    })
    const view = (await h.connect().joinOrCreate("stopped")).unwrap()
    const room = h.server.getMatchMaker().getRoom(view.roomId)
    if (!(room instanceof Stopped)) throw new Error("no room")
    counts.ticks = 0
    counts.syncs = 0
    await h.tick(1000)
    expect(counts).toEqual({ ticks: 0, syncs: 4 })
    room.restart()
    await h.tick(1000)
    expect(counts.ticks).toBe(5)
    await h.stop()
  })
})

describe("persistence", () => {
  class Saved extends Schema {
    public static override schemaName = "E2E.Saved"
    public score = createNumber()
    public tags = createMap(f.string, f.bool)
  }

  class PersistentRoom extends Room<Saved> {
    public override state = new Saved()

    protected override stateKey(): string {
      return "persistent-room"
    }

    protected override async onCreate(): Promise<void> {
      const loaded = await this.loadState()
      if (loaded.isOk() && loaded.value !== undefined) this.state = loaded.value
    }

    protected override async onDispose(): Promise<void> {
      ;(await this.saveState()).unwrap()
    }

    public get saved(): Saved {
      return this.state
    }
  }

  test("saveState/loadState round-trip through the IStore", async () => {
    const store = new MemoryStore()
    const h = await createServerHarness({
      server: { store: { provider: store } },
      define: (s) => s.defineRoomType("p", PersistentRoom),
    })
    const first = (await h.connect().create("p")).unwrap()
    const room = h.server.getMatchMaker().getRoom(first.roomId)
    if (!(room instanceof PersistentRoom)) throw new Error("no room")
    room.saved.score.set(99)
    room.saved.tags.set("vip", true)
    await first.leave() // auto-dispose → saveState

    const second = (
      await h.connect().create("p", {}, { state: Saved })
    ).unwrap()
    await h.tick(50)
    expect(second.state?.score.get()).toBe(99)
    expect(second.state?.tags.get("vip")).toBe(true)
    await h.stop()
  })
})

describe("startup validation", () => {
  test("defineRoomType throws on malformed state and contracts", async () => {
    class Unnamed extends Schema {
      public v = createNumber()
    }
    class BadState extends Schema {
      public static override schemaName = "E2E.Bad"
      public items = createSchemaMap(f.string, Unnamed)
    }
    class BadRoom extends Room<BadState> {
      public override state = new BadState()
    }
    const bad = defineMessage("bad", { level: f.fixed(12 as 2) })
    const badContract = defineContract({ client: { bad }, server: {} })
    class BadContractRoom extends Room<GameState, typeof badContract> {
      public static override contract = badContract
    }

    const h = await createServerHarness()
    expect(() => h.define("bad", BadRoom)).toThrow(
      /Unnamed: missing its own static schemaName/,
    )
    expect(() => h.define("bad2", BadContractRoom)).toThrow(
      /client\.bad\.level: fixed decimals must be an integer 0\.\.9/,
    )
    h.define("game", GameRoom)
    expect(() => h.define("game", GameRoom)).toThrow(/already defined/)
    await h.stop()
  })

  test("a registered room never hits the state package's log-and-skip path", async () => {
    const error = spyOn(console, "error")
    const { h, join } = await setup()
    await join()
    await join()
    await h.tick(100)
    expect(error).not.toHaveBeenCalled()
    error.mockRestore()
    await h.stop()
  })

  test("a state first assigned in onCreate is validated when the room is created", async () => {
    class Unnamed extends Schema {
      public v = createNumber()
    }
    class Late extends Room<Unnamed> {
      protected override async onCreate(): Promise<void> {
        this.state = new Unnamed()
      }
    }
    const { h, errors } = await setup()
    h.define("late", Late)
    const result = await h.connect().create("late")
    expect(result.isErr() && result.error.code).toBe("JOIN_FAILED")
    expect(errors).toEqual([])
    await h.stop()
  })
})
