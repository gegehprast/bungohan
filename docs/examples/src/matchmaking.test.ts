import { afterEach, expect, test } from "bun:test"
import { createTestHarness, type TestHarness } from "@bungohan/testing"
import { LobbyRoom, MatchRoom, openMatches } from "./matchmaking"
import { findMatch } from "./matchmaking.client"

let h: TestHarness | undefined

afterEach(async () => {
  await h?.stop()
  h = undefined
})

async function harness() {
  return createTestHarness({
    rooms: { lobby: [LobbyRoom, { autoDispose: false }], match: MatchRoom },
    client: { pingInterval: 0 },
  })
}

test("a lobby reserves seats; clients consume them", async () => {
  h = await harness()
  const first = findMatch(await h.connect())
  const second = findMatch(await h.connect())
  await h.tick(50)
  await h.tick(50)
  const a = (await first).unwrap()
  const b = (await second).unwrap()

  expect(a.id).toBe(b.id) // both went to the same match
  expect(a.state.map.get()).toBe("dunes")
  // Full and locked: it no longer shows up.
  expect((await openMatches("dunes")).unwrap()).toEqual([])

  const third = findMatch(await h.connect())
  await h.tick(50)
  await h.tick(50)
  const c = (await third).unwrap()
  expect(c.id).not.toBe(a.id)
})

test("query finds open rooms by metadata", async () => {
  h = await harness()
  const mm = h.server.getMatchMaker()
  const docks = (await mm.createRoom(MatchRoom, { map: "docks" })).unwrap()
  await mm.createRoom(MatchRoom, { map: "dunes" })
  const listed = (await openMatches("docks")).unwrap()
  expect(listed.map((room) => room.id)).toEqual([docks.id])
  expect(listed[0]?.metadata).toEqual({ map: "docks" })
})
