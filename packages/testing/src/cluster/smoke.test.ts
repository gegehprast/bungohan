import { expect, test } from "bun:test"
import { createClusterHarness } from "../cluster"
import { GameRoom } from "../core/fixtures"
import { joinOrCreate } from "./helpers"

test("a client on one process joins a room owned by another", async () => {
  const cluster = await createClusterHarness({
    size: 2,
    rooms: { game: GameRoom },
  })
  // Put the only room on process 1.
  const owned = (
    await cluster.node(1).server.getMatchMaker().createRoom("game")
  ).unwrap()
  await cluster.flush()

  const client = await cluster.connect(0)
  const room = (await joinOrCreate(client)).unwrap()

  expect(room.id).toBe(owned.id)
  expect(cluster.node(0).server.getRoomManager().getRoomCount()).toBe(0)
  expect(cluster.node(1).server.getRoomManager().getRoomCount()).toBe(1)
  expect(room.state.players.size).toBe(1)
  expect(room.state.players.get(room.sessionId)?.name.get()).toBe(
    room.sessionId,
  )

  await cluster.stop()
})
