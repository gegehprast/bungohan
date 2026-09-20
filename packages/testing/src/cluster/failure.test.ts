/**
 * What happens when a process goes away (spec §6.4, point 3). The rule is
 * "a clear error, never a hang": every wait is a deadline on the server's
 * clock, and a peer that stops heartbeating is dropped, which ends the
 * seats and the requests that depended on it.
 */
import { describe, expect, test } from "bun:test"
import { LeaveCode } from "@bungohan/client-js"
import type { DefineRoomOptions, RoomProxy } from "@bungohan/core"
import { type ClusterHarness, createClusterHarness } from "../cluster"
import { GameRoom } from "../core/fixtures"
import { game, joinOrCreate } from "./helpers"

/** Short timings: the point is the deadlines, not how long they are. */
const TIMINGS = {
  heartbeatInterval: 500,
  peerTimeout: 1_500,
  requestTimeout: 1_000,
  gatherTimeout: 100,
}

async function cluster(
  size = 2,
  room: DefineRoomOptions = { autoDispose: false },
  timings: Partial<typeof TIMINGS> = {},
): Promise<ClusterHarness> {
  return createClusterHarness({
    size,
    rooms: { game: [GameRoom, room] },
    cluster: { ...TIMINGS, ...timings },
  })
}

function mm(c: ClusterHarness, index: number) {
  return c.node(index).server.getMatchMaker()
}

/** The cluster's only room, created on node 1, plus a seat from node 0. */
async function seatAcross(c: ClusterHarness) {
  const created = (await c.run(mm(c, 1).createRoom("game"))).unwrap()
  const client = await c.connect(0)
  const room = (await joinOrCreate(client)).unwrap()
  expect(room.id).toBe(created.id)
  return { client, room }
}

describe("the owning process dies", () => {
  test("clients elsewhere are told the room ended (LEAVE 4002)", async () => {
    const c = await cluster()
    const { room } = await seatAcross(c)
    const codes: number[] = []
    room.onLeave((code) => codes.push(code))

    await c.kill(1)
    // Nothing yet: p0 has not missed enough heartbeats.
    await c.tick(TIMINGS.heartbeatInterval)
    expect(codes).toEqual([])

    await c.tick(TIMINGS.peerTimeout)
    expect(codes).toEqual([LeaveCode.ROOM_DISPOSED])
    expect(room.status).toBe("left")
    await c.stop()
  })

  test("the connection survives and can join a room here", async () => {
    const c = await cluster()
    const { client, room } = await seatAcross(c)
    await c.kill(1)
    await c.tick(TIMINGS.peerTimeout * 2)
    expect(room.status).toBe("left")

    // Same connection, same client: p0 can now serve the room itself.
    const fresh = (await joinOrCreate(client)).unwrap()
    expect(fresh.id).not.toBe(room.id)
    expect(mm(c, 0).getRoomCount()).toBe(1)
    await c.stop()
  })

  test("a call in flight to it fails as soon as the peer is declared dead", async () => {
    // A request outliving the peer deadline: it fails with `peer-lost`
    // rather than waiting out its own timeout.
    const c = await cluster(
      2,
      { autoDispose: false },
      {
        requestTimeout: 10_000,
      },
    )
    const created = (await c.run(mm(c, 1).createRoom("game"))).unwrap()
    const proxy = (await c.run(mm(c, 0).joinById(created.id))).unwrap()

    const pending = (proxy as RoomProxy).refresh()
    await c.kill(1)
    await c.tick(TIMINGS.peerTimeout * 2)

    const answered = await pending
    expect(answered.isErr() && answered.error.code).toBe("CONNECTION_LOST")
    expect(answered.isErr() && answered.error.message).toContain("p1")
    await c.stop()
  })

  test("its rooms and reservations are no longer reachable", async () => {
    const c = await cluster(2)
    const created = (await c.run(mm(c, 1).createRoom("game"))).unwrap()
    const reservation = (await c.run(mm(c, 0).reserve("game"))).unwrap()
    await c.kill(1)
    await c.tick(TIMINGS.peerTimeout * 2)

    const byId = await c.run(mm(c, 0).joinById(created.id))
    expect(byId.isErr() && byId.error.code).toBe("ROOM_NOT_FOUND")

    const taken = await (await c.connect(0)).consumeReservation(
      reservation,
      game,
    )
    expect(taken.isErr() && taken.error.code).toBe("RESERVATION_NOT_FOUND")

    const listed = (await c.run(mm(c, 0).query({ type: "game" }))).unwrap()
    expect(listed).toEqual([])
    await c.stop()
  })

  test("a request with no answer gives up after requestTimeout", async () => {
    const c = await cluster()
    const node = c.node(0).server.getCluster()
    if (node === undefined) throw new Error("cluster mode is off")

    // A process that never existed: nothing will ever answer, and the
    // peer registry has nothing to declare dead either.
    const pending = node.roomOp("ghost", "room", { op: "info" })
    await c.tick(TIMINGS.requestTimeout + 100)
    const answered = await pending
    expect(answered.isErr() && answered.error.code).toBe("TIMEOUT")

    const join = node.forwardJoin("ghost", {
      connectionId: "c1",
      roomRef: 1,
      requestId: 1,
      target: { kind: "room", roomId: "room", mode: 3 },
      options: {},
      hash: null,
      context: { ip: "127.0.0.1", searchParams: [], headers: [] },
    })
    await c.tick(TIMINGS.requestTimeout + 100)
    expect((await join).isErr()).toBe(true)
    await c.stop()
  })
})

describe("the owning process stops gracefully", () => {
  test("clients elsewhere get LEAVE 4001 before the process says goodbye", async () => {
    const c = await cluster()
    const { room } = await seatAcross(c)
    const codes: number[] = []
    room.onLeave((code) => codes.push(code))

    await c.node(1).server.stop()
    await c.flush()

    expect(codes).toEqual([LeaveCode.SERVER_SHUTDOWN])
    // The goodbye dropped it at once; no heartbeat timeout was needed.
    expect(c.node(0).server.getCluster()?.peers()).toEqual([])
    await c.stop()
  })
})

describe("the process holding the socket dies", () => {
  test("the owning process holds the seat for reconnection", async () => {
    const c = await cluster()
    const { room } = await seatAcross(c)
    const owned = mm(c, 1).getRoom(room.id)
    if (!(owned instanceof GameRoom)) throw new Error("not the local room")

    await c.kill(0)
    await c.tick(TIMINGS.peerTimeout * 2)

    expect(owned.getClientCount()).toBe(1)
    expect(owned.getClient(room.sessionId)?.status).toBe("reconnecting")
    expect(owned.getClient(room.sessionId)?.connected).toBe(false)
    await c.stop()
  })

  test("a held seat still expires on the owning process's clock", async () => {
    const c = await cluster(2, {
      autoDispose: false,
      allowReconnection: true,
      reconnectionTimeout: 2,
    })
    const { room } = await seatAcross(c)
    const owned = mm(c, 1).getRoom(room.id)
    if (!(owned instanceof GameRoom)) throw new Error("not the local room")

    await c.kill(0)
    // The peer deadline first, then the room's own reconnection grace.
    await c.tick(TIMINGS.peerTimeout * 2 + 2_000 + 500)
    expect(owned.getClientCount()).toBe(0)
    await c.stop()
  })
})
