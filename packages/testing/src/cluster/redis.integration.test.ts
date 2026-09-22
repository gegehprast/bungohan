/**
 * The same cluster, over a real `RedisBackplane` (spec §6.4). Runs when
 * `REDIS_URL` is set and is skipped otherwise, like the other
 * `*.integration.test.ts` suites.
 *
 * The servers still run on a `ManualClock` and a `LoopbackTransport`, so
 * the game side stays deterministic; what is real here is the backplane,
 * which means messages cross a socket instead of a microtask. Joins are
 * driven by the harness's own loops, which already wait as long as it
 * takes; every other cross-process assertion goes through {@link until},
 * so no assertion here depends on guessing a round-trip time.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { type IBackplane, RedisBackplane } from "@bungohan/backplane"
import { LeaveCode } from "@bungohan/client-js"
import { RoomProxy } from "@bungohan/core"
import { type ClusterHarness, createClusterHarness } from "../cluster"
import { GameRoom } from "../core/fixtures"
import { game, joinOrCreate } from "./helpers"

const url = process.env["REDIS_URL"]

/** Real time for Redis to deliver; `flush()` repeats this until quiet. */
function realSettle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 4))
}

/**
 * Flushes until `done()` holds. Quiescence over a real socket can't be
 * decided by a fixed wait — under load a round trip can outlast any
 * number we pick — so the assertions wait for the effect they are about,
 * and only give up after a real-time budget. On the happy path this
 * returns on the first check.
 */
async function until(
  c: ClusterHarness,
  done: () => boolean,
  what: string,
): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt++) {
    await c.flush()
    if (done()) return
  }
  throw new Error(`Redis never delivered: ${what}`)
}

describe.skipIf(url === undefined)("cluster over a real Redis", () => {
  let harness: ClusterHarness | undefined
  let backplanes: IBackplane[] = []

  afterEach(async () => {
    await harness?.stop()
    harness = undefined
    for (const backplane of backplanes) await backplane.close()
    backplanes = []
  })

  async function cluster(size = 2): Promise<ClusterHarness> {
    backplanes = Array.from({ length: size }, () => new RedisBackplane({ url }))
    harness = await createClusterHarness({
      size,
      backplanes,
      rooms: { game: [GameRoom, { autoDispose: false }] },
      settle: realSettle,
      // Each run gets its own channels, so leftovers and parallel runs
      // can't see each other.
      namespace: `bungohan-test:${crypto.randomUUID()}`,
    })
    return harness
  }

  function mm(c: ClusterHarness, index: number) {
    return c.node(index).server.getMatchMaker()
  }

  test("processes find each other over the backplane", async () => {
    const c = await cluster(3)
    const processes = (await c.run(mm(c, 0).getAllProcesses())).unwrap()
    expect(processes.map((p) => p.id).sort()).toEqual(["p0", "p1", "p2"])
  })

  test("a client on one process plays in a room on another", async () => {
    const c = await cluster()
    const created = (await c.run(mm(c, 1).createRoom("game"))).unwrap()
    const client = await c.connect(0)
    const room = (await joinOrCreate(client)).unwrap()

    expect(room.id).toBe(created.id)
    expect(mm(c, 0).getRoomCount()).toBe(0)
    expect(room.state.players.get(room.sessionId)?.name.get()).toBe(
      room.sessionId,
    )

    const owned = mm(c, 1).getRoom(created.id)
    if (!(owned instanceof GameRoom)) throw new Error("not the local room")
    room.send("move", { dx: -1.25 })
    await until(
      c,
      () => owned.game.players.get(room.sessionId)?.x.get() === -1.25,
      "the move reached the owning process",
    )
    await c.flushSync()
    await until(
      c,
      () => room.state.players.get(room.sessionId)?.x.get() === -1.25,
      "the patch came back to the client",
    )
  })

  test("messages travel both ways between two processes", async () => {
    const c = await cluster(3)
    ;(await c.run(mm(c, 2).createRoom("game"))).unwrap()
    const a = (await joinOrCreate(await c.connect(0))).unwrap()
    const b = (await joinOrCreate(await c.connect(1))).unwrap()
    const heard: string[] = []
    b.onMessage("said", (message) => heard.push(message.text))
    await c.flush()

    a.send("say", { text: "over redis" })
    await until(c, () => heard.length === 1, "the broadcast reached b")
    expect(heard).toEqual(["over redis"])
    await c.flushSync()
    await until(c, () => b.state.players.size === 2, "b's state caught up")
  })

  test("query and joinById reach across the cluster", async () => {
    const c = await cluster()
    const created = (
      await c.run(mm(c, 1).createRoom("game", { metadata: { mode: "duel" } }))
    ).unwrap()
    const listed = (
      await c.run(mm(c, 0).query({ type: "game", metadata: { mode: "duel" } }))
    ).unwrap()
    expect(listed.map((r) => r.id)).toEqual([created.id])
    expect(listed[0]?.processId).toBe("p1")

    const proxy = (await c.run(mm(c, 0).joinById(created.id))).unwrap()
    expect(proxy).toBeInstanceOf(RoomProxy)
    expect((proxy as RoomProxy).processId).toBe("p1")
  })

  test("a reservation is consumable from a third process", async () => {
    const c = await cluster(3)
    ;(await c.run(mm(c, 1).createRoom("game"))).unwrap()
    const reservation = (await c.run(mm(c, 0).reserve("game"))).unwrap()
    const room = (
      await (await c.connect(2)).consumeReservation(reservation, game)
    ).unwrap()
    expect(room.sessionId).toBe(reservation.sessionId)
    expect(room.id).toBe(reservation.roomId)
  })

  test("a held seat resumes through a different process", async () => {
    const c = await cluster(3)
    ;(await c.run(mm(c, 1).createRoom("game"))).unwrap()
    const first = await c.connect(0)
    const room = (await joinOrCreate(first)).unwrap()
    const token = room.reconnectionToken ?? ""

    await c.node(0).dropConnection(first, 1006)
    await c.flush()

    const resumed = (
      await (await c.connect(2)).reconnect(room.id, token, game)
    ).unwrap()
    expect(resumed.sessionId).toBe(room.sessionId)
    expect(resumed.state.players.get(room.sessionId)).toBeDefined()
  })

  test("stopping the owning process ends remote seats", async () => {
    const c = await cluster()
    ;(await c.run(mm(c, 1).createRoom("game"))).unwrap()
    const room = (await joinOrCreate(await c.connect(0))).unwrap()
    const codes: number[] = []
    room.onLeave((code) => codes.push(code))

    await c.node(1).server.stop()
    await until(c, () => codes.length === 1, "the LEAVE reached the client")
    expect(codes).toEqual([LeaveCode.SERVER_SHUTDOWN])
    await until(
      c,
      () => c.node(0).server.getCluster()?.peers().length === 0,
      "p0 dropped p1 on its goodbye",
    )
  })

  test("process metadata reaches another process's selector", async () => {
    const c = await cluster(3)
    c.node(2).server.setProcessMetadata({ region: "eu-west" }).unwrap()
    await until(
      c,
      () =>
        c
          .node(0)
          .server.getCluster()
          ?.placementCandidates()
          .some((p) => p.metadata["region"] === "eu-west") === true,
      "p2's heartbeat carried its metadata",
    )
    const created = (
      await c.run(
        mm(c, 0).createRoom("game", {}, (offered) => {
          const eu = offered.find((p) => p.metadata["region"] === "eu-west")
          if (eu === undefined) throw new Error("no eu-west process offered")
          return eu
        }),
      )
    ).unwrap()
    expect((created as RoomProxy).processId).toBe("p2")
  })

  test("a draining process sends a client's new room elsewhere", async () => {
    const c = await cluster()
    ;(await c.run(mm(c, 0).createRoom("game"))).unwrap()
    void c.node(0).server.drain()
    await until(
      c,
      () => c.node(1).server.getCluster()?.placementCandidates().length === 0,
      "p1 heard that p0 is draining",
    )
    // p0's own room is skipped, and it creates nothing itself.
    const room = (await joinOrCreate(await c.connect(0))).unwrap()
    expect(mm(c, 1).getRoom(room.id)).toBeDefined()
    expect(mm(c, 0).getRoomCount()).toBe(1)

    // Once every process drains, nothing can take a new room.
    void c.node(1).server.drain()
    const refused = await c.run(mm(c, 0).createRoom("game"))
    expect(refused.isErr() && refused.error.code).toBe("SERVER_SHUTTING_DOWN")
  })
})
