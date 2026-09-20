/**
 * The same cluster, over a real `RedisBackplane` (spec §6.4). Runs when
 * `REDIS_URL` is set and is skipped otherwise, like the other
 * `*.integration.test.ts` suites.
 *
 * The servers still run on a `ManualClock` and a `LoopbackTransport`, so
 * the game side stays deterministic; what is real here is the backplane,
 * which means messages cross a socket instead of a microtask. `flush()` is
 * told to wait for that, and to see several quiet passes before it calls
 * the cluster settled.
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
  return new Promise((resolve) => setTimeout(resolve, 2))
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

    room.send("move", { dx: -1.25 })
    await c.flushSync()
    await c.flushSync()
    const owned = mm(c, 1).getRoom(created.id)
    if (!(owned instanceof GameRoom)) throw new Error("not the local room")
    expect(owned.game.players.get(room.sessionId)?.x.get()).toBe(-1.25)
    expect(room.state.players.get(room.sessionId)?.x.get()).toBe(-1.25)
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
    await c.flush()
    expect(heard).toEqual(["over redis"])
    await c.flushSync()
    expect(b.state.players.size).toBe(2)
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
    await c.flush()
    expect(codes).toEqual([LeaveCode.SERVER_SHUTDOWN])
    expect(c.node(0).server.getCluster()?.peers()).toEqual([])
  })
})
