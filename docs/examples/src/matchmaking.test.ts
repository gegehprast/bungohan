import { afterEach, expect, test } from "bun:test"
import { createTestHarness, type TestHarness } from "@bungohan/testing"
import {
  LobbyRoom,
  MatchRoom,
  MatchState,
  matchContract,
  openMatches,
  reserveInBand,
  reserveInFullest,
  reserveInScheduled,
} from "./matchmaking"
import { findMatch } from "./matchmaking.client"

const match = { state: MatchState, contract: matchContract }

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

test("reserveById holds a seat in the room the query picked", async () => {
  h = await harness()
  const mm = h.server.getMatchMaker()
  const quiet = (await mm.createRoom(MatchRoom, { map: "docks" })).unwrap()
  const busy = (await mm.createRoom(MatchRoom, { map: "docks" })).unwrap()
  const player = await h.connect()
  const held = (await mm.reserveById(busy.id, { rating: 1000 })).unwrap()
  ;(await player.consumeReservation(held, match)).unwrap()
  const reservation = (await reserveInFullest("docks", 1200)).unwrap()
  expect(reservation.roomId).toBe(busy.id)
  expect(quiet.getSeatCount()).toBe(0)
})

test("where keeps pools apart within one room type", async () => {
  h = await harness()
  const bronze = (await reserveInBand("bronze", 900)).unwrap()
  const silver = (await reserveInBand("silver", 1400)).unwrap()
  const bronzeAgain = (await reserveInBand("bronze", 950)).unwrap()
  expect(silver.roomId).not.toBe(bronze.roomId)
  expect(bronzeAgain.roomId).toBe(bronze.roomId)
  const room = h.server.getMatchMaker().getRoom(bronze.roomId)
  expect(room?.metadata["band"]).toBe("bronze")
})

test("a key names one room", async () => {
  h = await harness()
  const first = (await reserveInScheduled("final-7", 1000)).unwrap()
  const second = (await reserveInScheduled("final-7", 1100)).unwrap()
  expect(second.roomId).toBe(first.roomId)
  // MatchRoom seats two: a third seat in that match is refused.
  const third = await reserveInScheduled("final-7", 1200)
  expect(third.isErr() && third.error.code).toBe("ROOM_FULL")
  expect(h.server.getMatchMaker().getRoom(first.roomId)?.key).toBe("final-7")
})
