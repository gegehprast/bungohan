/**
 * How a client's `JOIN` is routed in a cluster (spec §6.4): local first,
 * then the cluster, and the same answers a single process would give.
 */
import { describe, expect, test } from "bun:test"
import type { DefineRoomOptions } from "@bungohan/core"
import { type ClusterHarness, createClusterHarness } from "../cluster"
import { GameRoom } from "../core/fixtures"
import { game, joinOrCreate } from "./helpers"

async function cluster(
  size = 2,
  room: DefineRoomOptions = { autoDispose: false },
): Promise<ClusterHarness> {
  return createClusterHarness({ size, rooms: { game: [GameRoom, room] } })
}

function mm(c: ClusterHarness, index: number) {
  return c.node(index).server.getMatchMaker()
}

describe("joinOrCreate", () => {
  test("prefers a room on this process", async () => {
    const c = await cluster()
    ;(await c.run(mm(c, 1).createRoom("game"))).unwrap()
    const here = (await c.run(mm(c, 0).createRoom("game"))).unwrap()
    const room = (await joinOrCreate(await c.connect(0))).unwrap()
    expect(room.id).toBe(here.id)
    await c.stop()
  })

  test("creates here when no process has an available room", async () => {
    const c = await cluster()
    const full = (await c.run(mm(c, 1).createRoom("game"))).unwrap()
    full.lock()
    await c.flush()
    const room = (await joinOrCreate(await c.connect(0))).unwrap()
    expect(room.id).not.toBe(full.id)
    expect(mm(c, 0).getRoomCount()).toBe(1)
    await c.stop()
  })

  test("a second join on one connection gets a second room", async () => {
    // A local joinOrCreate skips the room the connection already sits in;
    // so must a cluster-wide one.
    const c = await cluster()
    ;(await c.run(mm(c, 1).createRoom("game"))).unwrap()
    const client = await c.connect(0)
    const first = (await joinOrCreate(client)).unwrap()
    const second = (await joinOrCreate(client)).unwrap()
    expect(second.id).not.toBe(first.id)
    await c.stop()
  })

  test("a full room elsewhere makes JOIN_OR_CREATE create one here", async () => {
    const c = await cluster(2, { autoDispose: false, maxClients: 1 })
    ;(await c.run(mm(c, 1).createRoom("game"))).unwrap()
    const taken = (await joinOrCreate(await c.connect(1))).unwrap()
    const next = (await joinOrCreate(await c.connect(0))).unwrap()
    expect(next.id).not.toBe(taken.id)
    expect(mm(c, 0).getRoomCount()).toBe(1)
    await c.stop()
  })
})

describe("concurrent find-or-create on one process", () => {
  // Asking the cluster is an await between "no room here" and "create
  // one", so without a registry of rooms being created each of these
  // would create its own (spec §6.7.2).
  test("client joins share one room", async () => {
    const c = await cluster()
    const [a, b] = [await c.connect(0), await c.connect(0)]
    const rooms = await c.run(Promise.all([joinOrCreate(a), joinOrCreate(b)]))
    const [first, second] = rooms.map((r) => r.unwrap().id)
    expect(second).toBe(first)
    expect(mm(c, 0).getRoomCount()).toBe(1)
    expect(mm(c, 1).getRoomCount()).toBe(0)
    await c.stop()
  })

  test("server-side calls and a client join share one room", async () => {
    const c = await cluster()
    const client = await c.connect(0)
    const [room, reservation, joined] = await c.run(
      Promise.all([
        mm(c, 0).joinOrCreate("game"),
        mm(c, 0).reserve("game"),
        joinOrCreate(client),
      ]),
    )
    const id = room.unwrap().id
    expect(reservation.unwrap().roomId).toBe(id)
    expect(joined.unwrap().id).toBe(id)
    expect(mm(c, 0).getRoomCount()).toBe(1)
    await c.stop()
  })

  test("a one-seat room being created: the others create their own", async () => {
    const c = await cluster(2, { autoDispose: false, maxClients: 1 })
    const [a, b] = [await c.connect(0), await c.connect(0)]
    const [reservation, ja, jb] = await c.run(
      Promise.all([mm(c, 0).reserve("game"), joinOrCreate(a), joinOrCreate(b)]),
    )
    const ids = [reservation.unwrap().roomId, ja.unwrap().id, jb.unwrap().id]
    expect(new Set(ids).size).toBe(3)
    await c.stop()
  })
})

describe("mode JOIN", () => {
  test("takes a room on another process", async () => {
    const c = await cluster()
    const there = (await c.run(mm(c, 1).createRoom("game"))).unwrap()
    const room = (await (await c.connect(0)).join("game", {}, game)).unwrap()
    expect(room.id).toBe(there.id)
    await c.stop()
  })

  test("is ROOM_NOT_FOUND when no process has one", async () => {
    const c = await cluster()
    const joined = await (await c.connect(0)).join("game", {}, game)
    expect(joined.isErr() && joined.error.code).toBe("ROOM_NOT_FOUND")
    await c.stop()
  })
})

describe("room types a process doesn't define", () => {
  test("a join is routed to a process that does define it", async () => {
    const c = await createClusterHarness({ size: 2 })
    c.node(1).define("game", GameRoom, { autoDispose: false })
    const there = (await c.run(mm(c, 1).createRoom("game"))).unwrap()

    // Node 0 has no "game" room type at all.
    const room = (await joinOrCreate(await c.connect(0))).unwrap()
    expect(room.id).toBe(there.id)
    await c.stop()
  })

  test("a type no process defines is ROOM_TYPE_NOT_DEFINED", async () => {
    const c = await createClusterHarness({ size: 2 })
    const joined = await (await c.connect(0)).joinOrCreate("game", {}, game)
    expect(joined.isErr() && joined.error.code).toBe("ROOM_TYPE_NOT_DEFINED")
    await c.stop()
  })
})

describe("connection bookkeeping", () => {
  test("the owning process forgets a connection that closed", async () => {
    const c = await cluster()
    ;(await c.run(mm(c, 1).createRoom("game"))).unwrap()
    const client = await c.connect(0)
    const room = (await joinOrCreate(client)).unwrap()

    expect(c.node(1).server.getRemoteConnectionCount()).toBe(1)

    // Leave the room but keep the connection: the owner still knows it,
    // since the connection may join again.
    await room.leave()
    await c.flush()
    expect(mm(c, 1).getRoom(room.id)?.getClientCount()).toBe(0)
    expect(c.node(1).server.getRemoteConnectionCount()).toBe(1)

    // Closing it is reported even though no seat was left to report.
    await client.disconnect()
    await c.flush()
    expect(c.node(1).server.getRemoteConnectionCount()).toBe(0)
    await c.stop()
  })
})
