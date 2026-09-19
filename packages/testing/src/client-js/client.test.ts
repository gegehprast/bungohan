/**
 * End-to-end: real client-js clients against a real server, over the
 * loopback, on a manual clock (spec §11.2). Everything a client does here
 * goes through bytes: frames, the handshake, codec sessions, `applyDelta`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  type BungohanClient,
  type ClientLogger,
  Room as ClientRoom,
  type IRoom,
} from "@bungohan/client-js"
import { Room } from "@bungohan/core"
import { encodeFrame, MessagePackSerializer } from "@bungohan/serializer"
import {
  createNumber,
  createSchemaMap,
  createString,
  Schema,
  SchemaRegistry,
} from "@bungohan/state"
import {
  type Contract,
  defineContract,
  defineMessage,
  f,
  LeaveCode,
  ServerFrameType,
} from "@bungohan/types"
import {
  calls,
  GameRoom,
  GameState,
  gameContract,
  type Player,
  resetFaults,
} from "../core/fixtures"
import { createTestHarness, type TestHarness } from "../harness"

type GameView = IRoom<GameState, typeof gameContract>

const game = { state: GameState, contract: gameContract }

let h: TestHarness
let warnings: string[]
let logger: ClientLogger

beforeEach(async () => {
  resetFaults()
  calls.length = 0
  warnings = []
  logger = {
    warn: (message) => warnings.push(message),
    error: (message) => warnings.push(`error: ${message}`),
  }
  h = await createTestHarness({
    rooms: { game: GameRoom },
    client: { logger, pingInterval: 0 },
  })
})

afterEach(async () => {
  await h.stop()
})

/** Delivers what clients sent, then runs a sync boundary. */
async function sync(): Promise<void> {
  await h.flush()
  await h.flushSync()
}

async function join(client?: BungohanClient): Promise<GameView> {
  const c = client ?? (await h.connect())
  return (await c.joinOrCreate("game", {}, game)).unwrap()
}

function serverRoom(view: { id: string }): GameRoom {
  const room = h.server.getMatchMaker().getRoom(view.id)
  if (!(room instanceof GameRoom)) throw new Error("no such room")
  return room
}

function roomRef(view: IRoom<GameState, Contract>): number {
  if (!(view instanceof ClientRoom)) throw new Error("not a client-js room")
  return view._ref
}

function player(view: GameView, sessionId = view.sessionId): Player {
  const found = view.state.players.get(sessionId)
  if (found === undefined) throw new Error(`no player ${sessionId}`)
  return found
}

describe("join", () => {
  test("completes with the first snapshot, replica populated", async () => {
    const client = await h.connect()
    expect(client.connectionState).toBe("connected")
    const room = await join(client)

    expect(room.status).toBe("joined")
    expect(room.roomType).toBe("game")
    expect(room.sessionId).not.toBe("")
    expect(room.reconnectionToken).toBeString()
    expect(player(room).name.get()).toBe(room.sessionId)
    expect(client.getRoom(room.id)).toBe(room)
    expect(calls).toEqual([
      "static onAuth",
      "onCreate",
      `onJoin ${room.sessionId}`,
    ])
  })

  test("a second client joins the same room; the first sees it", async () => {
    const a = await join()
    const joinedA: string[] = []
    a.onClientJoin(({ sessionId }) => joinedA.push(sessionId))
    const b = await join()
    await h.flush()

    expect(b.id).toBe(a.id)
    expect(joinedA).toEqual([b.sessionId])
    await h.flushSync()
    expect([...a.state.players.keys()].sort()).toEqual(
      [a.sessionId, b.sessionId].sort(),
    )
  })

  test("a server join error comes back as a Result", async () => {
    const client = await h.connect()
    const result = await client.join("game", {}, game)
    expect(result.isErr() && result.error.code).toBe("ROOM_NOT_FOUND")
    const unknown = await client.joinOrCreate("nope")
    expect(unknown.isErr() && unknown.error.code).toBe("ROOM_TYPE_NOT_DEFINED")
  })

  test("contract mismatch fails the join before any hook runs", async () => {
    const Extra = defineMessage("extra", { n: f.uint8 })
    const stale = defineContract({
      client: { ...gameContract.client, extra: Extra },
      server: gameContract.server,
    })
    const client = await h.connect()
    const result = await client.joinOrCreate(
      "game",
      {},
      {
        state: GameState,
        contract: stale,
      },
    )
    expect(result.isErr() && result.error.code).toBe("CONTRACT_MISMATCH")
    expect(calls).toEqual([])
    expect(h.server.getMatchMaker().getRoomCount()).toBe(0)
  })

  test("an unknown state codec fails locally with CODEC_MISMATCH", async () => {
    await h.stop()
    const { MessagePackStateCodec } = await import("@bungohan/serializer")
    class RenamedCodec extends MessagePackStateCodec {
      public override getName(): string {
        return "schema-v9"
      }
    }
    h = await createTestHarness({
      rooms: { game: GameRoom },
      client: { logger, pingInterval: 0 },
      server: { stateCodec: new RenamedCodec() },
    })
    const client = await h.connect()
    const result = await client.joinOrCreate("game", {}, game)
    expect(result.isErr() && result.error.code).toBe("CODEC_MISMATCH")
    await h.flush()
    // The client left the seat the server had given it.
    expect(calls.some((call) => /^onLeave .* true$/.test(call))).toBe(true)
    expect(client.getRooms().size).toBe(0)
  })
})

describe("messages", () => {
  test("typed client → server: move updates state", async () => {
    const room = await join()
    expect(room.send("move", { dx: 1.25 }).isOk()).toBe(true)
    await sync()
    expect(player(room).x.get()).toBe(1.25)
  })

  test("typed server → client: said reaches every member", async () => {
    const a = await join()
    const b = await join()
    const heardA: { from: string; text: string }[] = []
    const heardB: string[] = []
    a.onMessage("said", (message) => heardA.push(message))
    b.onMessage("said", ({ text }) => heardB.push(text))

    a.send("say", { text: "hello" })
    await h.flush()
    expect(heardA).toEqual([{ from: a.sessionId, text: "hello" }])
    expect(heardB).toEqual(["hello"])
  })

  test("a message sent in onJoin reaches a handler registered after the join", async () => {
    const client = await h.connect()
    const room = (await client.joinOrCreate("game", {}, game)).unwrap()
    const welcomes: { sessionId: string; players: number }[] = []
    room.onMessage("welcome", (message) => welcomes.push(message))
    expect(welcomes).toEqual([]) // held until the clock's next turn
    await h.tick(0)
    expect(welcomes).toEqual([{ sessionId: room.sessionId, players: 1 }])
  })

  test("an early message nobody handled waits for the first handler", async () => {
    const client = await h.connect()
    const room = (await client.joinOrCreate("game", {}, game)).unwrap()
    await h.flush() // held frames released: "welcome" finds no handler
    expect(warnings).toEqual([])
    const welcomes: number[] = []
    room.onMessage("welcome", ({ players }) => welcomes.push(players))
    await h.flush()
    expect(welcomes).toEqual([1])
    // Delivered once; later messages without a handler are just dropped.
    room.onMessage("welcome", ({ players }) => welcomes.push(players))
    await h.flush()
    expect(welcomes).toEqual([1])
  })

  test("raw messages both ways", async () => {
    const room = await join()
    const raw: [string, unknown][] = []
    room.onMessageRaw((type, message) => raw.push([type, message]))
    room.sendRaw("echo", { any: ["shape", 1] })
    await h.flush()
    expect(raw).toEqual([["echo", { any: ["shape", 1] }]])
  })

  test("sending a name outside the contract is a Result error", async () => {
    const room = await join()
    const bogus: string = "said" // a server message: wrong direction
    const sent = (
      room.send as (t: string, m: unknown) => ReturnType<GameView["send"]>
    )(bogus, {})
    expect(sent.isErr() && sent.error.code).toBe("UNKNOWN_MESSAGE")
  })
})

describe("state", () => {
  test("listen: onAdd/onRemove/onChange fire on the replica", async () => {
    const a = await join()
    const added: string[] = []
    const removed: string[] = []
    const xs: number[] = []
    let changes = 0
    a.onStateChange(() => changes++)
    a.listen((state) => {
      const offAdd = state.players.onAdd((p, id) => {
        added.push(id)
        p.x.onChange((x) => xs.push(x))
      })
      const offRemove = state.players.onRemove((_, id) => removed.push(id))
      return () => {
        offAdd()
        offRemove()
      }
    })

    const client = await h.connect()
    const b = await join(client)
    await h.flushSync()
    expect(added).toEqual([b.sessionId])

    b.send("move", { dx: 2 })
    await sync()
    expect(xs).toEqual([2])
    expect(player(a, b.sessionId).x.get()).toBe(2)

    await b.leave()
    await sync()
    expect(removed).toEqual([b.sessionId])
    expect(changes).toBeGreaterThanOrEqual(3)
  })

  test("a snapshot mid-game resets the replica and re-attaches listen()", async () => {
    const room = await join()
    const first = room.state
    const cleanups: number[] = []
    const seen: string[][] = []
    let attaches = 0
    room.listen((state) => {
      const n = ++attaches
      const names: string[] = []
      seen.push(names)
      const off = state.players.onAdd((p) => names.push(p.name.get()))
      return () => {
        off()
        cleanups.push(n)
      }
    })
    expect(attaches).toBe(1) // attached to the current replica at once

    // The server replaces its whole state object.
    const next = new GameState()
    const { Player } = await import("../core/fixtures")
    const ghost = new Player()
    ghost.name.set("ghost")
    next.players.set("ghost", ghost)
    serverRoom(room).state = next
    await h.flushSync()

    expect(room.state).not.toBe(first)
    expect([...room.state.players.keys()]).toEqual(["ghost"])
    expect(cleanups).toEqual([1])
    expect(attaches).toBe(2)
    // Attached before the snapshot was applied: its content came through.
    expect(seen[1]).toEqual(["ghost"])
  })

  test("leaving removes every listener", async () => {
    const room = await join()
    const events: string[] = []
    room.onMessage("said", () => events.push("said"))
    room.onStateChange(() => events.push("state"))
    room.onLeave((code) => events.push(`leave ${code}`))
    room.listen(() => () => events.push("cleanup"))

    expect((await room.leave()).isOk()).toBe(true)
    expect(room.status).toBe("left")
    expect(events).toEqual([`leave ${LeaveCode.CONSENTED}`, "cleanup"])
    await h.flushSync()
    // The seat is gone (and with it the room, which auto-disposed).
    expect(h.server.getMatchMaker().getRoom(room.id)).toBeUndefined()

    // Nothing registered on the room survives.
    events.length = 0
    const internal = room as unknown as ClientRoom<GameState>
    internal._left(LeaveCode.KICKED)
    internal._fail("X", "y")
    expect(events).toEqual([])
    expect((await room.leave()).isErr()).toBe(true)
    expect(room.send("say", { text: "x" }).isErr()).toBe(true)
  })

  test("kicked by the server: onLeave(4000)", async () => {
    const room = await join()
    const codes: number[] = []
    room.onLeave((code) => codes.push(code))
    const server = serverRoom(room)
    const seat = server.getClient(room.sessionId)
    if (seat === undefined) throw new Error("no seat")
    server.disconnectClient(seat)
    await h.flush()
    expect(codes).toEqual([LeaveCode.KICKED])
    expect(room.status).toBe("left")
  })
})

describe("reconnection", () => {
  test("an unexpected drop reconnects with the token, on the clock", async () => {
    const client = await h.connect()
    const room = await join(client)
    room.send("move", { dx: 3 })
    await sync()
    const token = room.reconnectionToken
    const sessionId = room.sessionId
    const events: string[] = []
    client.onDisconnect(() => events.push("disconnect"))
    client.onReconnect(() => events.push("reconnect"))
    let attaches = 0
    room.listen(() => {
      attaches++
      return undefined
    })

    await h.dropConnection(client)
    expect(events).toEqual(["disconnect"])
    expect(client.connectionState).toBe("reconnecting")
    expect(room.status).toBe("reconnecting")
    expect(room.send("move", { dx: 1 }).isErr()).toBe(true)
    expect(serverRoom(room).getClient(sessionId)?.connected).toBe(false)

    await h.tick(999) // default delay: 1000 ms
    expect(client.connectionState).toBe("reconnecting")
    await h.tick(1)
    expect(events).toEqual(["disconnect", "reconnect"])
    expect(client.connectionState).toBe("connected")
    expect(room.status).toBe("joined")
    expect(room.sessionId).toBe(sessionId)
    expect(room.reconnectionToken).toBeString()
    expect(room.reconnectionToken).not.toBe(token) // replaced on every rejoin
    expect(attaches).toBe(2) // fresh replica from the resume's snapshot
    expect(player(room).x.get()).toBe(3)
    expect(calls.filter((c) => c.startsWith("onJoin"))).toHaveLength(1)

    // Working again, and the old token is dead.
    room.send("move", { dx: 1 })
    await sync()
    expect(player(room).x.get()).toBe(4)
    const driver = h.driver()
    const stale = await driver.reconnect(token ?? "")
    expect(stale.isErr() && stale.error.code).toBe("INVALID_TOKEN")
  })

  test("backoff: delay × factor^n while the server is unreachable", async () => {
    const client = await h.connect()
    const room = await join(client)
    h.offline = true
    await h.dropConnection(client)

    await h.tick(1000) // attempt 1 fails
    await h.tick(1999)
    expect(client.connectionState).toBe("reconnecting")
    h.offline = false
    await h.tick(1) // attempt 2, 2000 ms after the first
    expect(client.connectionState).toBe("connected")
    expect(room.status).toBe("joined")
  })

  test("gives up after maxAttempts: rooms leave, onError reports it", async () => {
    const client = await h.connect({ reconnection: { maxAttempts: 2 } })
    const room = await join(client)
    const errors: string[] = []
    const codes: number[] = []
    client.onError((error) => errors.push(error.code))
    room.onLeave((code) => codes.push(code))
    h.offline = true
    await h.dropConnection(client)
    await h.tick(1000)
    await h.tick(2000)
    expect(client.connectionState).toBe("disconnected")
    expect(errors).toEqual(["RECONNECTION_FAILED"])
    expect(codes).toEqual([LeaveCode.DISCONNECTED])
  })

  test("a room without reconnection is left on a drop", async () => {
    await h.stop()
    h = await createTestHarness({
      rooms: { game: [GameRoom, { allowReconnection: false }] },
      client: { logger, pingInterval: 0 },
    })
    const client = await h.connect()
    const room = await join(client)
    expect(room.reconnectionToken).toBeUndefined()
    const codes: number[] = []
    room.onLeave((code) => codes.push(code))
    await h.dropConnection(client)
    await h.tick(1000)
    expect(client.connectionState).toBe("connected")
    expect(codes).toEqual([LeaveCode.DISCONNECTED])
    expect(client.getRooms().size).toBe(0)
  })
})

describe("explicit resumes", () => {
  test("reconnect() with a token for another room fails and gives the seat back", async () => {
    const first = await h.connect({ reconnection: { enabled: false } })
    const room = await join(first)
    const token = room.reconnectionToken ?? ""
    await h.dropConnection(first) // no automatic reconnection: seat held
    expect(first.connectionState).toBe("disconnected")

    const second = await h.connect()
    const wrongRoom = await second.reconnect("not-this-room", token, game)
    expect(wrongRoom.isErr() && wrongRoom.error.code).toBe("INVALID_TOKEN")
    // The server had resumed the seat (the token was valid); the client
    // left it rather than keep a seat nobody holds a handle to.
    await h.flush()
    expect(calls).toContain(`onLeave ${room.sessionId} true`)
  })

  test("reconnect(roomId, token) restores the same seat", async () => {
    const first = await h.connect({ reconnection: { enabled: false } })
    const room = await join(first)
    await h.dropConnection(first)

    const second = await h.connect()
    const resumed = (
      await second.reconnect(room.id, room.reconnectionToken ?? "", game)
    ).unwrap()
    expect(resumed.sessionId).toBe(room.sessionId)
    expect(resumed.state.players.has(room.sessionId)).toBe(true)
    expect(calls.filter((c) => c.startsWith("onJoin"))).toHaveLength(1)
  })

  test("consumeReservation takes a reserved seat", async () => {
    const reservation = (
      await h.server.getMatchMaker().reserve("game", { vip: true })
    ).unwrap()
    const client = await h.connect()
    const room = (await client.consumeReservation(reservation, game)).unwrap()
    expect(room.id).toBe(reservation.roomId)
    expect(room.sessionId).toBe(reservation.sessionId)
    expect(room.state.players.has(reservation.sessionId)).toBe(true)
  })
})

describe("forward compatibility (§6.7.7)", () => {
  test("an unknown frame type is dropped and logged, not fatal", async () => {
    const client = await h.connect()
    const room = await join(client)
    const { clientId } = h.socketOf(client)
    h.transport.send(clientId, Uint8Array.of(200, 1, 2, 3))
    await h.flush()
    expect(warnings).toContain("dropped frame: unknown frame type 200")
    expect(client.connectionState).toBe("connected")

    // Still fully working.
    const heard: string[] = []
    room.onMessage("said", ({ text }) => heard.push(text))
    room.send("say", { text: "still here" })
    await h.flush()
    expect(heard).toEqual(["still here"])
  })

  test("a message id the client can't map is dropped", async () => {
    const client = await h.connect()
    const room = await join(client)
    const body = new MessagePackSerializer().encode([]).unwrap()
    const frame = encodeFrame(
      ServerFrameType.ROOM_MESSAGE,
      [roomRef(room), 99],
      body,
    ).unwrap()
    h.transport.send(h.socketOf(client).clientId, frame)
    await h.flush()
    expect(warnings).toContain("dropped message: unknown message id 99")
    expect(room.status).toBe("joined")
  })
})

describe("schema classes (§7.5)", () => {
  class RegVec extends Schema {
    public static override schemaName = "Reg.Vec"
    public x = createNumber()
  }
  class RegItem extends Schema {
    public static override schemaName = "Reg.Item"
    public label = createString()
    public pos = new RegVec()
  }
  /** A subclass: no declaration names it, so nothing can reach it. */
  class RegExtra extends RegItem {
    public static override schemaName = "Reg.Extra"
    public bonus = createNumber()
  }
  class RegState extends Schema {
    public static override schemaName = "Reg.State"
    public items = createSchemaMap(f.string, RegItem)
  }
  const ours = new Set(["Reg.State", "Reg.Item", "Reg.Vec", "Reg.Extra"])
  const options = { extra: false }

  class RegRoom extends Room<RegState> {
    public override state = new RegState()
    protected override async onJoin(): Promise<void> {
      const item = new RegItem()
      item.label.set("a")
      item.pos.x.set(2)
      this.state.items.set("a", item)
      if (options.extra) this.state.items.set("b", new RegExtra())
      // Stand in for a client process that never constructed these
      // classes (the server just did, in this same process).
      const others = SchemaRegistry.getNames()
        .filter((name) => !ours.has(name))
        .map((name) => SchemaRegistry.get(name))
      SchemaRegistry.clear()
      for (const ctor of others)
        if (ctor !== undefined) SchemaRegistry.register(ctor)
    }
  }

  test("classes reachable from the join's state class are registered", async () => {
    options.extra = false
    h.server.defineRoomType("reg", RegRoom)
    const room = (
      await (await h.connect()).joinOrCreate("reg", {}, { state: RegState })
    ).unwrap()
    expect(room.state.items.get("a")?.label.get()).toBe("a")
    expect(room.state.items.get("a")?.pos.x.get()).toBe(2)
    expect(warnings.filter((w) => w.startsWith("error:"))).toEqual([])
  })

  test("an unknown class is logged and reported through onError", async () => {
    options.extra = true
    h.server.defineRoomType("reg", RegRoom)
    const room = (
      await (await h.connect()).joinOrCreate("reg", {}, { state: RegState })
    ).unwrap()
    // Reported during the join's snapshot; a handler registered after the
    // join still receives it.
    const errors: [string, string][] = []
    room.onError((code, message) => errors.push([code, message]))
    await h.flush()
    expect(errors).toHaveLength(1)
    expect(errors[0]?.[0]).toBe("UNKNOWN_CLASS")
    expect(errors[0]?.[1]).toContain("Reg.Extra")
    expect(
      warnings.some((w) => w.startsWith("error:") && w.includes("Reg.Extra")),
    ).toBe(true)
    // The rest of the state still arrived; only the unknown instance is left out.
    expect(room.state.items.get("a")?.label.get()).toBe("a")
    expect(room.state.items.has("b")).toBe(false)
    expect(room.status).toBe("joined")
  })
})
