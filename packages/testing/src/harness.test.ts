/**
 * The harness itself (spec §11.2): it drives the server only through its
 * own loops and clock, as a real deployment would, with no shortcuts.
 */
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import {
  type Client,
  createFiltered,
  createSchemaMap,
  createString,
  f,
  Room,
  Schema,
  type ServerOptions,
} from "@bungohan/core"
import {
  calls,
  GameRoom,
  GameState,
  gameContract,
  resetFaults,
} from "./core/fixtures"
import { createTestHarness, type TestHarness } from "./harness"
import { snapshotFor } from "./snapshot"

const game = { state: GameState, contract: gameContract }
const quiet = { warn() {}, error() {} }

let h: TestHarness | undefined

beforeEach(() => {
  resetFaults()
  calls.length = 0
})

afterEach(async () => {
  await h?.stop()
  h = undefined
})

async function harness(
  server: Omit<ServerOptions, "transport" | "clock"> = {},
  room: { reconnectionTimeout?: number } = {},
): Promise<TestHarness> {
  h = await createTestHarness({
    rooms: { game: [GameRoom, room] },
    server,
    client: { pingInterval: 0, logger: quiet },
  })
  return h
}

function serverRoom(harness: TestHarness, roomId: string): GameRoom {
  const room = harness.server.getMatchMaker().getRoom(roomId)
  if (!(room instanceof GameRoom)) throw new Error("no such room")
  return room
}

test("a join completes at the room's own sync boundary, as time passes", async () => {
  // One sync every 5 s.
  const t = await harness({ sync: { tickRate: 0.2 } })
  const start = t.clock.now()
  const room = (
    await (await t.connect()).joinOrCreate("game", {}, game)
  ).unwrap()
  const waited = t.clock.now() - start
  expect(room.state.players.has(room.sessionId)).toBe(true)
  expect(waited).toBeGreaterThan(0)
  expect(waited).toBeLessThanOrEqual(5000)
})

test("a join that the room's loop can't serve in time times out", async () => {
  const t = await harness({ sync: { tickRate: 0.2 } })
  const client = await t.connect({ joinTimeout: 1000 })
  const joined = await client.joinOrCreate("game", {}, game)
  expect(joined.isErr() && joined.error.code).toBe("TIMEOUT")
})

test("a join into a paused room completes through the loops", async () => {
  const t = await harness({}, { reconnectionTimeout: 30 })
  const aClient = await t.connect({ reconnection: { enabled: false } })
  const a = (await aClient.joinOrCreate("game", {}, game)).unwrap()
  const server = serverRoom(t, a.id)
  await t.dropConnection(aClient)
  expect(server.isPaused).toBe(true)

  const start = t.clock.now()
  const b = (await (await t.connect()).joinById(a.id, {}, game)).unwrap()
  // Served by the next sync of the resumed loop, not by the held seat
  // expiring 30 s later.
  expect(t.clock.now() - start).toBeLessThanOrEqual(50)
  expect(b.state.players.has(b.sessionId)).toBe(true)
  expect(server.isPaused).toBe(false)
})

test("flushSync runs every room's sync loop (time moves one period)", async () => {
  const t = await harness({ sync: { tickRate: 0.2 } })
  const room = (
    await (await t.connect()).joinOrCreate("game", {}, game)
  ).unwrap()
  serverRoom(t, room.id).game.turn.set(9)
  const start = t.clock.now()
  await t.flushSync()
  expect(room.state.turn.get()).toBe(9)
  expect(t.clock.now() - start).toBe(5000)
})

test("tick() delivers what clients sent before advancing time", async () => {
  const t = await harness()
  const room = (
    await (await t.connect()).joinOrCreate("game", {}, game)
  ).unwrap()
  await t.tick(50) // everything from the join is delivered and settled
  room.send("move", { dx: 1.5 })
  await t.tick(50) // one sync at 20 Hz
  expect(room.state.players.get(room.sessionId)?.x.get()).toBe(1.5)
})

/** A room whose state is `protected`, as `Room` declares it. */
class SealedRoom extends Room<GameState> {
  protected override state = new GameState()
}

test("stateOf reads a room's state without making it public", async () => {
  h = await createTestHarness({ rooms: { sealed: SealedRoom } })
  const client = await h.connect()
  const view = (
    await client.joinOrCreate("sealed", {}, { state: GameState })
  ).unwrap()

  const state: GameState = h.stateOf(SealedRoom, view) // or view.id
  expect(state).toBe(h.stateOf(SealedRoom, view.id))
  state.turn.set(3)
  await h.flushSync()
  expect(view.state.turn.get()).toBe(3)

  expect(() => h?.stateOf(GameRoom, view)).toThrow(/not a GameRoom/)
  expect(() => h?.stateOf(SealedRoom, "nope")).toThrow(/no room "nope"/)
})

/**
 * A room whose onJoin awaits `gate`, standing in for real I/O (a fetch to
 * another process): something the harness clock can't move along.
 */
let gate: Promise<void> = Promise.resolve()

class SlowJoinRoom extends GameRoom {
  protected override async onJoin(client: Client): Promise<void> {
    await gate
    await super.onJoin(client)
  }
}

function gated(): () => void {
  let open = () => {}
  gate = new Promise((resolve) => {
    open = resolve
  })
  return open
}

test("a join whose hooks await real I/O outruns simulated time without joinRealWait", async () => {
  const open = gated()
  const warn = spyOn(console, "warn").mockImplementation(() => {})
  h = await createTestHarness({
    rooms: { game: SlowJoinRoom },
    client: { pingInterval: 0, logger: quiet },
  })
  try {
    const joined = await (await h.connect()).joinOrCreate("game", {}, game)
    // The clock ran to the client's joinTimeout before the "fetch" was back.
    expect(joined.isErr() && joined.error.code).toBe("TIMEOUT")
    await h.flush() // delivery gives up, and says why
    expect(warn.mock.calls.flat().join()).toContain("joinRealWait")
  } finally {
    open()
    warn.mockRestore()
  }
})

test("joinRealWait holds the clock while a join's hooks do real I/O", async () => {
  const open = gated()
  h = await createTestHarness({
    rooms: { game: SlowJoinRoom },
    client: { pingInterval: 0, logger: quiet },
    joinRealWait: 5000,
  })
  const client = await h.connect()
  // The "fetch" answers after 20 ms of real time.
  setTimeout(open, 20)
  const room = (await client.joinOrCreate("game", {}, game)).unwrap()
  expect(room.state.players.has(room.sessionId)).toBe(true)
  // Only the sync boundary after the join cost simulated time.
  expect(h.clock.now()).toBeLessThanOrEqual(50)
})

test("autoJoin: false on one client leaves its join to the test", async () => {
  const t = await harness()
  const held = await t.connect({ autoJoin: false })
  let settled = false
  const pending = held.joinOrCreate("game", {}, game).then((r) => {
    settled = true
    return r
  })
  // Another client's join still completes by itself.
  const other = (
    await (await t.connect()).joinOrCreate("game", {}, game)
  ).unwrap()
  expect(other.state.players.has(other.sessionId)).toBe(true)
  const clock = t.clock.now()
  await t.flush()
  expect(t.clock.now()).toBe(clock) // nothing moved the clock for it
  if (!settled) await t.tick(50)
  const room = (await pending).unwrap()
  expect(room.state.players.has(room.sessionId)).toBe(true)
})

class Hero extends Schema {
  public static override readonly schemaName = "Harness.Hero"
  public owner = createString("")
  public quest = createFiltered(
    createString(""),
    function (this: Hero, client) {
      return this.owner.get() === client.id
    },
  )
}

class Party extends Schema {
  public static override readonly schemaName = "Harness.Party"
  public leader = createString("")
  public heroes = createSchemaMap(f.string, Hero)
}

test("snapshotFor shows what one client would receive", () => {
  const party = new Party()
  party.leader.set("carol")
  const hero = new Hero()
  hero.owner.set("alice")
  hero.quest.set("find the lost map")
  party.heroes.set("alice", hero)

  const alice = snapshotFor(party, "alice")
  const bob = snapshotFor(party, { id: "bob" })
  expect(alice).not.toBe(party)
  expect(alice.heroes.get("alice")?.quest.get()).toBe("find the lost map")
  expect(bob.heroes.get("alice")?.quest.get()).toBe("")
  expect(bob.leader.get()).toBe("carol")

  // Later changes show up too: the state needn't be fresh.
  hero.owner.set("bob")
  expect(snapshotFor(party, "bob").heroes.get("alice")?.quest.get()).toBe(
    "find the lost map",
  )
  expect(snapshotFor(party, "alice").heroes.get("alice")?.quest.get()).toBe("")
})
