import { afterEach, expect, test } from "bun:test"
import {
  createTestHarness,
  ManualClock,
  type TestHarness,
} from "@bungohan/testing"
import { ArenaRoom } from "@bungohan/tutorial-server/ArenaRoom"
import { ArenaState, arenaContract } from "@bungohan/tutorial-shared"

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

  // The real Room instance: narrow with instanceof to reach its state.
  const room = h.server.getMatchMaker().getRoom(view.id)
  if (!(room instanceof ArenaRoom)) throw new Error("no arena")
  room.state.players.get(view.sessionId)?.score.set(7)

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

  await h.tick(250) // delivers, advances 250 ms of loops, delivers again
  expect(Math.abs((me?.x.get() ?? 0) - x)).toBeCloseTo(50, -1)
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
  const room = h.server.getMatchMaker().getRoom(slow.id)
  if (!(room instanceof ArenaRoom)) throw new Error("no arena")
  const truth = room.state.players.get(mover.sessionId)?.y.get()
  expect(slow.state.players.get(mover.sessionId)?.y.get()).not.toBe(truth)

  // Reading again: the backlog drains, then a fresh snapshot catches up.
  h.transport.unstall(h.socketOf(slowClient).clientId)
  mover.send("move", { dx: 0, dy: 0 })
  await h.tick(200)
  const now = room.state.players.get(mover.sessionId)?.y.get()
  expect(slow.state.players.get(mover.sessionId)?.y.get()).toBe(now)
  // Re-synced by a snapshot, which always builds a new replica.
  expect(slow.state).not.toBe(replica)
})
// #endregion stall
