// #region setup
import { afterEach, beforeEach, expect, test } from "bun:test"
import type { BungohanClient } from "@bungohan/client-js"
import { createTestHarness, type TestHarness } from "@bungohan/testing"
import {
  ARENA,
  ArenaState,
  arenaContract,
  ROOM_TYPE,
} from "@bungohan/tutorial-shared"
import { ArenaRoom } from "./ArenaRoom"

const arena = { state: ArenaState, contract: arenaContract }

let h: TestHarness

beforeEach(async () => {
  // A real server and real clients, in-process, on a manual clock.
  h = await createTestHarness({
    rooms: { [ROOM_TYPE]: ArenaRoom },
    client: { pingInterval: 0 },
  })
})

afterEach(async () => {
  await h.stop()
})

async function join(name: string, client?: BungohanClient) {
  const c = client ?? (await h.connect())
  const options = { create: { gems: 3 }, join: { name } }
  return (await c.joinOrCreate(ROOM_TYPE, options, arena)).unwrap()
}
// #endregion setup

// #region see-each-other
test("two players join the same arena and see each other", async () => {
  const alice = await join("Alice")
  const bob = await join("Bob")
  await h.tick(50) // one sync period (20 Hz) brings Alice's replica up to date

  expect(bob.id).toBe(alice.id)
  const names = [...alice.state.players.values()].map((p) => p.name.get())
  expect(names.sort()).toEqual(["Alice", "Bob"])
  expect(alice.state.gems.size).toBe(3)
})
// #endregion see-each-other

// #region collect
test("walking onto a gem scores it and spawns another", async () => {
  const room = await join("Alice")
  const scores: number[] = []
  room.onMessage("gemCollected", ({ score }) => scores.push(score))

  // Steer toward the nearest gem using only what the client can see.
  for (let i = 0; i < 200 && scores.length === 0; i++) {
    const me = room.state.players.get(room.sessionId)
    const gem = [...room.state.gems.values()][0]
    if (me === undefined || gem === undefined) throw new Error("no state")
    const toward = (d: number) => (Math.abs(d) < 5 ? 0 : Math.sign(d))
    room.send("move", {
      dx: toward(gem.x.get() - me.x.get()),
      dy: toward(gem.y.get() - me.y.get()),
    })
    await h.tick(50)
  }

  expect(scores[0]).toBe(1)
  expect(room.state.players.get(room.sessionId)?.score.get()).toBeGreaterThan(0)
  expect(room.state.gems.size).toBe(3)
})
// #endregion collect

test("join options are checked as game rules, not trusted", async () => {
  const room = await join("   ")
  expect(room.state.players.get(room.sessionId)?.name.get()).toBe("Anonymous")
  const long = await join("a name far longer than sixteen characters")
  expect(long.state.players.get(long.sessionId)?.name.get()).toHaveLength(16)
})

test("a huge dx moves no faster than the normal speed", async () => {
  const room = await join("Speedy")
  const me = room.state.players.get(room.sessionId)
  if (me === undefined) throw new Error("no player")
  const x0 = me.x.get()
  const right = x0 < ARENA.WIDTH / 2
  room.send("move", { dx: right ? 127 : -128, dy: 0 })
  await h.tick(500)
  const travelled = Math.abs(me.x.get() - x0)
  expect(travelled).toBeGreaterThan(ARENA.PLAYER_SPEED * 0.4)
  expect(travelled).toBeLessThanOrEqual(ARENA.PLAYER_SPEED * 0.5 + 1)
})

// #region disconnect
test("a dropped player stops walking while their seat is held", async () => {
  const aliceClient = await h.connect({ reconnection: { enabled: false } })
  const alice = await join("Alice", aliceClient)
  const bob = await join("Bob")
  const seen = bob.state.players.get(alice.sessionId)
  if (seen === undefined) throw new Error("Bob can't see Alice")

  alice.send("move", { dx: seen.x.get() < ARENA.WIDTH / 2 ? 1 : -1, dy: 0 })
  await h.tick(100)
  await h.dropConnection(aliceClient)
  await h.tick(50)
  const x = seen.x.get()
  await h.tick(1000)

  expect(bob.state.players.has(alice.sessionId)).toBe(true) // seat held
  expect(seen.x.get()).toBe(x) // but not moving
})
// #endregion disconnect
