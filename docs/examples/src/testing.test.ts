import { afterEach, expect, test } from "bun:test"
import {
  createTestHarness,
  ManualClock,
  snapshotFor,
  type TestHarness,
} from "@bungohan/testing"
import { ArenaRoom } from "@bungohan/tutorial-server/ArenaRoom"
import { ArenaState, arenaContract } from "@bungohan/tutorial-shared"
import { createPartyRoom, Hero, httpProfiles, PartyState } from "./dependencies"

const arena = { state: ArenaState, contract: arenaContract }
const options = (name: string) => ({ create: { gems: 3 }, join: { name } })

let h: TestHarness | undefined

afterEach(async () => {
  await h?.stop()
  h = undefined
})

// #region server-side
test("reading the room on the server", async () => {
  h = await createTestHarness({ rooms: { arena: ArenaRoom } })
  const client = await h.connect()
  const view = (
    await client.joinOrCreate("arena", options("Ada"), arena)
  ).unwrap()

  // The room's real state on the server, typed by the room class.
  const state = h.stateOf(ArenaRoom, view)
  state.players.get(view.sessionId)?.score.set(7)

  await h.flushSync() // runs every room to its next sync boundary
  expect(view.state.players.get(view.sessionId)?.score.get()).toBe(7)
})
// #endregion server-side

// #region time
test("time only moves when the test moves it", async () => {
  h = await createTestHarness({ rooms: { arena: ArenaRoom } })
  const view = (
    await (await h.connect()).joinOrCreate("arena", options("Ada"), arena)
  ).unwrap()
  const me = view.state.players.get(view.sessionId)
  const x = me?.x.get() ?? 0

  view.send("move", { dx: x < 400 ? 1 : -1, dy: 0 })
  await h.flush() // delivers frames and runs due timers; no time passes
  expect(me?.x.get()).toBe(x)

  await h.flushSync() // the next patch: one sync period passes, it arrives
  const next = me?.x.get() ?? 0
  expect(next).not.toBe(x)

  await h.tick(250) // game time: 250 ms of loops, delivered as they run
  expect(Math.abs((me?.x.get() ?? 0) - next)).toBeCloseTo(50, -1)
})
// #endregion time

// #region clock
test("a ManualClock on its own", async () => {
  const clock = new ManualClock()
  const fired: number[] = []
  clock.setTimeout(() => fired.push(clock.now()), 100)
  clock.setInterval(() => fired.push(clock.now()), 40)

  await clock.advance(100) // fires each due timer in order, at its due time
  expect(fired).toEqual([40, 80, 100])
})
// #endregion clock

// #region network
test("drops, outages and byte counts", async () => {
  h = await createTestHarness({
    rooms: { arena: ArenaRoom },
    client: { pingInterval: 0, logger: { warn() {}, error() {} } },
  })
  const client = await h.connect()
  const view = (
    await client.joinOrCreate("arena", options("Ada"), arena)
  ).unwrap()

  h.offline = true // new connections fail, like an unreachable server
  await h.dropConnection(client) // drop this one from the network side
  await h.tick(1000) // the first retry fails: still offline
  expect(view.status).toBe("reconnecting")

  h.offline = false
  await h.tick(2000) // the next retry (backoff doubled) gets through
  await h.tick(50)
  expect(view.status).toBe("joined")

  h.resetStats()
  await h.tick(1000) // nobody moves: an idle room sends nothing
  expect(h.bytesSent()).toBe(0)
})
// #endregion network

// #region stall
test("a client that stops reading is paused, then re-synced", async () => {
  h = await createTestHarness({
    rooms: { arena: ArenaRoom },
    client: { pingInterval: 0 },
    // Small thresholds, so a test reaches them quickly.
    server: {
      limits: { backpressure: { pauseBytes: 300, resumeBytes: 100 } },
    },
  })
  const mover = (
    await (await h.connect()).joinOrCreate("arena", options("Mover"), arena)
  ).unwrap()
  const slowClient = await h.connect()
  const slow = (
    await slowClient.joinOrCreate("arena", options("Slow"), arena)
  ).unwrap()

  const replica = slow.state
  // Stop delivering to `slow`: the server's queue for it grows.
  h.transport.stall(h.socketOf(slowClient).clientId)
  for (let i = 0; i < 60; i++) {
    mover.send("move", { dx: i % 20 < 10 ? 1 : -1, dy: 1 })
    await h.tick(50)
  }
  const server = h.stateOf(ArenaRoom, slow)
  const truth = server.players.get(mover.sessionId)?.y.get()
  expect(slow.state.players.get(mover.sessionId)?.y.get()).not.toBe(truth)

  // Reading again: the backlog drains, then a fresh snapshot catches up.
  h.transport.unstall(h.socketOf(slowClient).clientId)
  mover.send("move", { dx: 0, dy: 0 })
  await h.tick(200)
  const now = server.players.get(mover.sessionId)?.y.get()
  expect(slow.state.players.get(mover.sessionId)?.y.get()).toBe(now)
  // Re-synced by a snapshot, which always builds a new replica.
  expect(slow.state).not.toBe(replica)
})
// #endregion stall

// #region real-io
test("a join whose hooks call a real service", async () => {
  // A stand-in for the profile service, on a real port, as slow as a
  // round trip to another machine.
  const service = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      await Bun.sleep(20)
      return new URL(request.url).pathname === "/session"
        ? Response.json({ playerId: "p1" })
        : Response.json({ name: "Ada", level: 7 })
    },
  })
  try {
    const url = `http://127.0.0.1:${service.port}`
    h = await createTestHarness({
      rooms: { party: createPartyRoom(httpProfiles(url)) },
      // Real milliseconds a join's hooks get before the clock moves on.
      joinRealWait: 2000,
    })
    const client = await h.connect({ token: "session-1" })
    const view = (
      await client.joinOrCreate("party", {}, { state: PartyState })
    ).unwrap()
    expect(view.state.heroes.get(view.sessionId)?.level.get()).toBe(7)
  } finally {
    await service.stop(true)
  }
})
// #endregion real-io

// #region fake-deps
test("a fake service needs no network and no real time", async () => {
  const noHeroes = createPartyRoom({
    playerOf: async (token) => token,
    heroOf: async () => undefined,
  })
  h = await createTestHarness({
    rooms: { party: noHeroes },
    client: { logger: { warn() {}, error() {} } },
  })
  const client = await h.connect({ token: "p1" })
  const joined = await client.joinOrCreate("party", {}, { state: PartyState })
  expect(joined.isErr() && joined.error.code).toBe("JOIN_FAILED")
})
// #endregion fake-deps

// #region filters
test("each player receives only their own hero's quest", () => {
  const party = new PartyState()
  for (const id of ["ada", "bob"]) {
    const hero = new Hero()
    hero.owner.set(id)
    hero.quest.set(`${id}'s quest`)
    party.heroes.set(id, hero)
  }
  // What bob's client would decode from its join snapshot.
  const bob = snapshotFor(party, "bob")
  expect(bob.heroes.get("bob")?.quest.get()).toBe("bob's quest")
  expect(bob.heroes.get("ada")?.quest.get()).toBe("") // hidden: the zero value
})
// #endregion filters

// #region quick-start
test("one player's move reaches the other", async () => {
  const harness = await createTestHarness({ rooms: { arena: ArenaRoom } })
  const join = async (name: string) => {
    const client = await harness.connect()
    const joined = await client.joinOrCreate(
      "arena",
      { create: { gems: 3 }, join: { name } },
      { state: ArenaState, contract: arenaContract },
    )
    return joined.unwrap()
  }
  const ada = await join("Ada")
  const bob = await join("Bob")
  const before = bob.state.players.get(ada.sessionId)?.x.get()

  ada.send("move", { dx: 1, dy: 0 })
  await harness.tick(250) // 250 ms of game time, and no real waiting

  const seenByBob = bob.state.players.get(ada.sessionId)?.x.get()
  const onServer = harness.stateOf(ArenaRoom, ada).players.get(ada.sessionId)
  expect(seenByBob).not.toBe(before)
  // Positions are fixed-point on the wire: clients get them rounded.
  expect(seenByBob).toBeCloseTo(onServer?.x.get() ?? 0, 1)
  await harness.stop()
})
// #endregion quick-start
