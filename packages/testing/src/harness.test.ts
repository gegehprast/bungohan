/**
 * The harness itself (spec §11.2): it drives the server only through its
 * own loops and clock, as a real deployment would, with no shortcuts.
 */
import { afterEach, beforeEach, expect, test } from "bun:test"
import { Room, type ServerOptions } from "@bungohan/core"
import {
  calls,
  GameRoom,
  GameState,
  gameContract,
  resetFaults,
} from "./core/fixtures"
import { createTestHarness, type TestHarness } from "./harness"

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
