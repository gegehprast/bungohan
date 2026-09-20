/**
 * Cross-process reservations and reconnection (spec §6.4, point 4). A seat
 * is held where its room is, so a client may take it — or resume it — from
 * whichever process it happens to reach.
 */
import { describe, expect, test } from "bun:test"
import type { DefineRoomOptions } from "@bungohan/core"
import type { Reservation } from "@bungohan/types"
import { type ClusterHarness, createClusterHarness } from "../cluster"
import { GameRoom } from "../core/fixtures"
import { game, joinOrCreate } from "./helpers"

async function cluster(
  size = 3,
  room: DefineRoomOptions = { autoDispose: false },
): Promise<ClusterHarness> {
  return createClusterHarness({ size, rooms: { game: [GameRoom, room] } })
}

function mm(c: ClusterHarness, index: number) {
  return c.node(index).server.getMatchMaker()
}

/** Creates the cluster's only room, on node 1. */
async function roomOnNode1(c: ClusterHarness): Promise<GameRoom> {
  const created = (await c.run(mm(c, 1).createRoom("game"))).unwrap()
  const room = mm(c, 1).getRoom(created.id)
  if (!(room instanceof GameRoom)) throw new Error("not the local room")
  return room
}

describe("reservations", () => {
  test("a reservation made here is held where the room is", async () => {
    const c = await cluster()
    const owned = await roomOnNode1(c)
    const reservation = (await c.run(mm(c, 0).reserve("game"))).unwrap()

    expect(reservation.roomId).toBe(owned.id)
    expect(reservation.roomType).toBe("game")
    // The seat is held on the owning process, against its maxClients.
    expect(owned.getSeatCount()).toBe(1)
    expect(mm(c, 0).getRoomCount()).toBe(0)
    await c.stop()
  })

  test("a reservation is consumable from a third process", async () => {
    const c = await cluster()
    const owned = await roomOnNode1(c)
    const reservation = (await c.run(mm(c, 0).reserve("game"))).unwrap()

    const client = await c.connect(2)
    const room = (await client.consumeReservation(reservation, game)).unwrap()

    expect(room.id).toBe(owned.id)
    expect(room.sessionId).toBe(reservation.sessionId)
    expect(owned.getClientCount()).toBe(1)
    expect(room.state.players.get(room.sessionId)).toBeDefined()
    await c.stop()
  })

  test("consuming a reservation twice fails the second time", async () => {
    const c = await cluster()
    await roomOnNode1(c)
    const reservation = (await c.run(mm(c, 0).reserve("game"))).unwrap()

    ;(await (await c.connect(2)).consumeReservation(reservation, game)).unwrap()
    const again = await (await c.connect(0)).consumeReservation(
      reservation,
      game,
    )
    expect(again.isErr() && again.error.code).toBe("RESERVATION_NOT_FOUND")
    await c.stop()
  })

  test("an unknown reservation id is refused after the lookup window", async () => {
    const c = await cluster()
    await roomOnNode1(c)
    const fake: Reservation = {
      id: "not-a-reservation",
      roomId: "nowhere",
      roomType: "game",
      sessionId: "x",
      expiresAt: Number.POSITIVE_INFINITY,
    }
    const taken = await (await c.connect(0)).consumeReservation(fake, game)
    expect(taken.isErr() && taken.error.code).toBe("RESERVATION_NOT_FOUND")
    await c.stop()
  })
})

describe("reconnection", () => {
  test("a held seat resumes through a different process", async () => {
    const c = await cluster()
    const owned = await roomOnNode1(c)
    const first = await c.connect(0)
    const room = (await joinOrCreate(first)).unwrap()
    const token = room.reconnectionToken
    if (token === undefined) throw new Error("no reconnection token")
    room.send("move", { dx: 4 })
    await c.flushSync()

    await c.node(0).dropConnection(first, 1006)
    await c.flush()
    expect(owned.getClient(room.sessionId)?.status).toBe("reconnecting")

    // A brand new connection, on a third process.
    const second = await c.connect(2)
    const resumed = (await second.reconnect(room.id, token, game)).unwrap()

    expect(resumed.sessionId).toBe(room.sessionId)
    expect(resumed.id).toBe(owned.id)
    expect(resumed.reconnectionToken).not.toBe(token)
    // A resume always brings a full snapshot, so the state survived.
    expect(resumed.state.players.get(room.sessionId)?.x.get()).toBe(4)
    expect(owned.getClient(room.sessionId)?.status).toBe("joined")
    expect(owned.getClientCount()).toBe(1)
    await c.stop()
  })

  test("the resumed seat receives state again and can still send", async () => {
    const c = await cluster()
    const owned = await roomOnNode1(c)
    const first = await c.connect(0)
    const room = (await joinOrCreate(first)).unwrap()
    const token = room.reconnectionToken ?? ""
    await c.node(0).dropConnection(first, 1006)
    await c.flush()

    const second = await c.connect(2)
    const resumed = (await second.reconnect(room.id, token, game)).unwrap()
    resumed.send("move", { dx: 1.5 })
    await c.flushSync()
    await c.flushSync()

    expect(owned.game.players.get(resumed.sessionId)?.x.get()).toBe(1.5)
    expect(resumed.state.players.get(resumed.sessionId)?.x.get()).toBe(1.5)
    await c.stop()
  })

  test("automatic reconnection resumes a remote seat on the same process", async () => {
    const c = await cluster()
    const owned = await roomOnNode1(c)
    const client = await c.connect(0)
    const room = (await joinOrCreate(client)).unwrap()
    const before = room.sessionId

    await c.node(0).dropConnection(client, 1006)
    await c.flush()
    expect(room.status).toBe("reconnecting")

    // The client's own backoff (1 s by default) runs on the shared clock.
    await c.tick(1_100)
    await c.flushSync()

    expect(room.status).toBe("joined")
    expect(room.sessionId).toBe(before)
    expect(owned.getClient(before)?.connected).toBe(true)
    await c.stop()
  })

  test("a stale token is INVALID_TOKEN wherever it is presented", async () => {
    const c = await cluster()
    await roomOnNode1(c)
    const first = await c.connect(0)
    const room = (await joinOrCreate(first)).unwrap()
    const stale = room.reconnectionToken ?? ""
    await room.leave()
    await c.flush()

    const resumed = await (await c.connect(2)).reconnect(room.id, stale, game)
    expect(resumed.isErr() && resumed.error.code).toBe("INVALID_TOKEN")
    await c.stop()
  })
})
