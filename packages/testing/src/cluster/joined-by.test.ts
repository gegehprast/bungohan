/** `client.joinedBy` when the seat's socket is on another process. */
import { expect, test } from "bun:test"
import { createClusterHarness } from "../cluster"
import { GameRoom } from "../core/fixtures"
import { game } from "./helpers"

test("a remote seat says how it was taken", async () => {
  const c = await createClusterHarness({
    size: 2,
    rooms: { game: [GameRoom, { autoDispose: false }] },
  })
  const owner = c.node(1).server.getMatchMaker()
  const room = (await c.run(owner.createRoom("game"))).unwrap()
  const byId = (
    await c.run((await c.connect(0)).joinById(room.id, {}, game))
  ).unwrap()
  const reservation = (await c.run(owner.reserveById(room.id))).unwrap()
  const reserved = (
    await c.run((await c.connect(0)).consumeReservation(reservation, game))
  ).unwrap()
  expect(room.getClient(byId.sessionId)?.joinedBy).toBe("join")
  expect(room.getClient(reserved.sessionId)?.joinedBy).toBe("reservation")
  await c.stop()
})
