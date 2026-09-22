/**
 * Process metadata and draining across a cluster (spec §6.4.2): what every
 * `ProcessSelector` sees, and how a draining process stops taking new rooms
 * without breaking the games it already runs.
 */
import { describe, expect, spyOn, test } from "bun:test"
import type { ProcessInfo, ProcessSelector } from "@bungohan/core"
import { RoomProxy } from "@bungohan/core"
import { type ClusterHarness, createClusterHarness } from "../cluster"
import { calls, GameRoom } from "../core/fixtures"
import { game, gameRoomOf, joinOrCreate } from "./helpers"

async function cluster(size = 2, autoDispose = true): Promise<ClusterHarness> {
  return createClusterHarness({
    size,
    rooms: { game: [GameRoom, { autoDispose }] },
  })
}

function mm(c: ClusterHarness, index: number) {
  return c.node(index).server.getMatchMaker()
}

/** A selector that records what it was offered and picks by id. */
function recording(pick: (offered: ProcessInfo[]) => ProcessInfo | undefined) {
  const offers: ProcessInfo[][] = []
  const selector: ProcessSelector = (offered) => {
    offers.push(offered)
    const chosen = pick(offered)
    if (chosen === undefined) throw new Error("nothing to pick")
    return chosen
  }
  return { offers, selector }
}

function ids(processes: ProcessInfo[] | undefined): string[] {
  return (processes ?? []).map((p) => p.id).sort()
}

describe("process metadata", () => {
  test("the static option reaches every process's selector", async () => {
    const c = await createClusterHarness({
      size: 2,
      rooms: { game: GameRoom },
      cluster: { metadata: { region: "eu-west" } },
    })
    const { offers, selector } = recording((offered) => offered[0])
    ;(await c.run(mm(c, 0).createRoom("game", {}, selector))).unwrap()
    expect(offers[0]?.map((p) => p.metadata)).toEqual([
      { region: "eu-west" },
      { region: "eu-west" },
    ])
    await c.stop()
  })

  test("a runtime update reaches other selectors, and a region picker uses it", async () => {
    const c = await cluster(3)
    c.node(1).server.setProcessMetadata({ region: "us-east" }).unwrap()
    c.node(2).server.setProcessMetadata({ region: "eu-west" }).unwrap()
    await c.flush()
    const inRegion =
      (region: string): ProcessSelector =>
      (offered) => {
        const chosen =
          offered.find((p) => p.metadata["region"] === region) ?? offered[0]
        if (chosen === undefined) throw new Error("no process offered")
        return chosen
      }
    const eu = (
      await c.run(mm(c, 0).createRoom("game", {}, inRegion("eu-west")))
    ).unwrap()
    expect(mm(c, 2).getRoom(eu.id)).toBeDefined()

    // Changed again: the next selector sees the new value.
    c.node(2).server.setProcessMetadata({ region: "ap-south" }).unwrap()
    await c.flush()
    const ap = (
      await c.run(mm(c, 0).createRoom("game", {}, inRegion("ap-south")))
    ).unwrap()
    expect(mm(c, 2).getRoom(ap.id)).toBeDefined()
    const processes = (await c.run(mm(c, 0).getAllProcesses())).unwrap()
    expect(processes.find((p) => p.id === "p2")?.metadata).toEqual({
      region: "ap-south",
    })
    await c.stop()
  })

  test("heartbeats carry metadata and draining, announced at once", async () => {
    const c = await cluster()
    c.node(1).server.setProcessMetadata({ region: "us-east" }).unwrap()
    await c.flush() // no clock advance: the heartbeat went out immediately
    const seen = c.node(0).server.getCluster()?.placementCandidates()
    expect(seen?.map((p) => [p.id, p.metadata])).toEqual([
      ["p1", { region: "us-east" }],
    ])

    void c.node(1).server.drain()
    await c.flush()
    expect(c.node(0).server.getCluster()?.placementCandidates()).toEqual([])
    c.node(1).server.cancelDrain()
    await c.flush()
    expect(ids(c.node(0).server.getCluster()?.placementCandidates())).toEqual([
      "p1",
    ])
    await c.stop()
  })
})

describe("a draining process takes no new rooms", () => {
  test("selectors are only offered processes that aren't draining", async () => {
    const c = await cluster(3)
    void c.node(1).server.drain()
    await c.flush()
    const { offers, selector } = recording((offered) => offered[0])
    ;(await c.run(mm(c, 0).createRoom("game", {}, selector))).unwrap()
    expect(ids(offers[0])).toEqual(["p0", "p2"])
    const all = (await c.run(mm(c, 0).getAllProcesses())).unwrap()
    expect(all.find((p) => p.id === "p1")?.draining).toBe(true)
    await c.stop()
  })

  test("createRoom on a draining process places the room elsewhere", async () => {
    const c = await cluster()
    void c.node(0).server.drain()
    const room = (await c.run(mm(c, 0).createRoom("game"))).unwrap()
    expect(room).toBeInstanceOf(RoomProxy)
    expect(mm(c, 1).getRoom(room.id)).toBeDefined()
    expect(mm(c, 0).getRoomCount()).toBe(0)
    await c.stop()
  })

  test("a client's joinOrCreate on a draining process creates the room elsewhere", async () => {
    const c = await cluster()
    void c.node(0).server.drain()
    await c.flush()
    calls.length = 0
    const client = await c.connect(0)
    const room = (await joinOrCreate(client)).unwrap()

    expect(mm(c, 0).getRoomCount()).toBe(0)
    const owned = gameRoomOf(mm(c, 1).getRoom(room.id))
    expect(owned.getClientCount()).toBe(1)
    // Created exactly as a local JOIN_OR_CREATE would be, on the owner.
    expect(calls).toEqual([
      "static onAuth",
      "onCreate",
      `onJoin ${room.sessionId}`,
    ])
    // And the seat works: state flows back through the draining edge.
    room.send("move", { dx: 2 })
    await c.flushSync()
    expect(room.state.players.get(room.sessionId)?.x.get()).toBe(2)
    await c.stop()
  })

  test("a candidate that refuses passes the turn to the next one", async () => {
    // p1 doesn't define the type; p2 does.
    const c = await createClusterHarness({ size: 3 })
    c.node(0).define("game", GameRoom)
    c.node(2).define("game", GameRoom)
    void c.node(0).server.drain()
    await c.flush()
    const room = (await joinOrCreate(await c.connect(0))).unwrap()
    expect(mm(c, 2).getRoom(room.id)).toBeDefined()
    await c.stop()
  })

  test("matchmaking skips a draining process's rooms", async () => {
    const c = await cluster(2, false)
    const old = (await c.run(mm(c, 1).createRoom("game"))).unwrap()
    void c.node(1).server.drain()
    await c.flush()

    // A client on the other process gets a new room there…
    const a = (await joinOrCreate(await c.connect(0))).unwrap()
    expect(a.id).not.toBe(old.id)
    expect(mm(c, 0).getRoom(a.id)).toBeDefined()
    // …and one on the draining process is sent to that one too.
    const b = (await joinOrCreate(await c.connect(1))).unwrap()
    expect(b.id).toBe(a.id)
    // Server-side matchmaking steers the same way.
    const reserved = (await c.run(mm(c, 0).reserve("game"))).unwrap()
    expect(reserved.roomId).toBe(a.id)
    const found = (await c.run(mm(c, 0).joinRoom("game"))).unwrap()
    expect(found.id).toBe(a.id)
    expect(gameRoomOf(mm(c, 1).getRoom(old.id)).getSeatCount()).toBe(0)
    await c.stop()
  })

  test("every process draining: creating fails with SERVER_SHUTTING_DOWN", async () => {
    const c = await cluster()
    void c.node(0).server.drain()
    void c.node(1).server.drain()
    await c.flush()
    const { offers, selector } = recording((offered) => offered[0])
    const created = await c.run(mm(c, 0).createRoom("game", {}, selector))
    expect(created.isErr() && created.error.code).toBe("SERVER_SHUTTING_DOWN")
    expect(offers).toEqual([]) // never called with an empty list
    const plain = await c.run(mm(c, 1).createRoom("game"))
    expect(plain.isErr() && plain.error.code).toBe("SERVER_SHUTTING_DOWN")
    const joined = await joinOrCreate(await c.connect(0))
    expect(joined.isErr() && joined.error.code).toBe("SERVER_SHUTTING_DOWN")
    await c.stop()
  })
})

describe("explicit paths keep working on a draining process", () => {
  test("joinById, reconnection and an earlier reservation", async () => {
    const c = await cluster(3, false)
    const created = (await c.run(mm(c, 1).createRoom("game"))).unwrap()
    const owned = gameRoomOf(mm(c, 1).getRoom(created.id))
    const first = await c.connect(0)
    const seat = (await joinOrCreate(first)).unwrap()
    const token = seat.reconnectionToken
    if (token === undefined) throw new Error("no reconnection token")
    const reservation = (await c.run(mm(c, 2).reserve("game"))).unwrap()
    expect(reservation.roomId).toBe(owned.id)

    void c.node(1).server.drain()
    await c.flush()

    // An invite by id.
    const invited = (
      await (await c.connect(2)).joinById(owned.id, {}, game)
    ).unwrap()
    expect(invited.id).toBe(owned.id)
    // A dropped player comes back, through another process.
    await c.node(0).dropConnection(first, 1006)
    await c.flush()
    const resumed = (
      await (await c.connect(2)).reconnect(owned.id, token, game)
    ).unwrap()
    expect(resumed.sessionId).toBe(seat.sessionId)
    // A reservation made before the drain is honoured.
    const taken = (
      await (await c.connect(0)).consumeReservation(reservation, game)
    ).unwrap()
    expect(taken.id).toBe(owned.id)
    expect(owned.getClientCount()).toBe(3)
    // RoomProxy control still reaches it.
    expect((await c.run(mm(c, 0).joinById(owned.id))).unwrap().id).toBe(
      owned.id,
    )
    await c.stop()
  })
})

describe("drain()", () => {
  test("resolves when the last room on the process is gone", async () => {
    const c = await cluster()
    const client = await c.connect(0)
    const room = (await joinOrCreate(client)).unwrap()
    let settled = false
    const drained = c
      .node(0)
      .server.drain()
      .then((result) => {
        settled = true
        return result
      })
    await c.tick(10_000)
    expect(settled).toBe(false)

    await room.leave()
    await c.flush()
    expect((await drained).unwrap()).toEqual({ outcome: "drained", rooms: 0 })
    await c.stop()
  })

  test("resolves on its timeout with the rooms still running", async () => {
    const c = await cluster(2, false)
    ;(await c.run(mm(c, 0).createRoom("game"))).unwrap()
    const drained = c.node(0).server.drain({ timeout: 30_000 })
    const result = (await c.run(drained)).unwrap()
    expect(result).toEqual({ outcome: "timeout", rooms: 1 })
    expect(c.clock.now()).toBe(30_000)
    await c.stop()
  })
})

describe("races", () => {
  test("a process that starts draining while a create is forwarded to it refuses, and the next choice wins", async () => {
    const c = await cluster(3)
    // The selector picks p1 first; p1 starts draining right after the
    // process list was gathered, so it still looks available.
    let first = true
    const { offers, selector } = recording((offered) => {
      if (first) {
        first = false
        void c.node(1).server.drain()
        return offered.find((p) => p.id === "p1")
      }
      return offered.find((p) => p.id === "p2")
    })
    const room = (
      await c.run(mm(c, 0).createRoom("game", {}, selector))
    ).unwrap()
    expect(mm(c, 2).getRoom(room.id)).toBeDefined()
    expect(ids(offers[0])).toEqual(["p0", "p1", "p2"])
    expect(ids(offers[1])).toEqual(["p0", "p2"]) // p1 struck off
    expect(mm(c, 1).getRoomCount()).toBe(0)
    await c.stop()
  })

  test("a client's new room forwarded to a process that just began draining goes to the next", async () => {
    const c = await cluster(3)
    void c.node(0).server.drain()
    await c.flush()
    // p1 begins draining, but p0 hasn't heard yet: its heartbeat view is
    // one beat stale and still lists p1 first.
    const node = c.node(0).server.getCluster()
    if (node === undefined) throw new Error("no cluster")
    const stale = node.placementCandidates()
    const candidates = spyOn(node, "placementCandidates").mockReturnValue([
      ...stale.filter((p) => p.id === "p1"),
      ...stale.filter((p) => p.id !== "p1"),
    ])
    void c.node(1).server.drain()

    calls.length = 0
    const room = (await joinOrCreate(await c.connect(0))).unwrap()
    expect(candidates).toHaveBeenCalled()
    candidates.mockRestore()
    expect(mm(c, 1).getRoomCount()).toBe(0)
    // p1 refused before running any of the room's code.
    expect(calls.filter((call) => call === "static onAuth")).toHaveLength(1)
    expect(mm(c, 2).getRoom(room.id)).toBeDefined()
    await c.stop()
  })

  test("a room found before its process began draining is refused, and the search goes on", async () => {
    const c = await cluster(2, false)
    const old = (await c.run(mm(c, 1).createRoom("game"))).unwrap()
    // p1 answers the lookup, then starts draining before the seat is
    // reserved there.
    const node = c.node(0).server.getCluster()
    if (node === undefined) throw new Error("no cluster")
    const find = node.findAvailable.bind(node)
    const spy = spyOn(node, "findAvailable").mockImplementation(
      async (...args) => {
        const found = await find(...args)
        if (found !== undefined) void c.node(1).server.drain()
        return found
      },
    )
    const reserved = (await c.run(mm(c, 0).reserve("game"))).unwrap()
    spy.mockRestore()
    expect(reserved.roomId).not.toBe(old.id)
    expect(mm(c, 0).getRoom(reserved.roomId)).toBeDefined()
    await c.stop()
  })
})
