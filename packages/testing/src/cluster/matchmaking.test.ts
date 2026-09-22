/**
 * Cluster matchmaking (spec §6.4): `getAllProcesses`, and `createRoom` /
 * `joinRoom` / `joinById` / `query` reaching across processes.
 */
import { describe, expect, test } from "bun:test"
import { Client, RoomProxy } from "@bungohan/core"
import { type ClusterHarness, createClusterHarness } from "../cluster"
import { GameRoom } from "../core/fixtures"
import { joinOrCreate } from "./helpers"

async function cluster(size = 2): Promise<ClusterHarness> {
  return createClusterHarness({ size, rooms: { game: GameRoom } })
}

function mm(c: ClusterHarness, index: number) {
  return c.node(index).server.getMatchMaker()
}

describe("getAllProcesses", () => {
  test("aggregates every process that answers, including this one", async () => {
    const c = await cluster(3)
    const processes = await c.run(mm(c, 0).getAllProcesses())
    expect(
      processes
        .unwrap()
        .map((p) => p.id)
        .sort(),
    ).toEqual(["p0", "p1", "p2"])
    await c.stop()
  })

  test("carries each process's real room and client counts", async () => {
    const c = await cluster()
    ;(await c.run(mm(c, 1).createRoom("game"))).unwrap()
    ;(await c.run(mm(c, 1).createRoom("game"))).unwrap()
    const client = await c.connect(1)
    ;(await joinOrCreate(client)).unwrap()

    const processes = (await c.run(mm(c, 0).getAllProcesses())).unwrap()
    const byId = new Map(processes.map((p) => [p.id, p]))
    expect(byId.get("p0")).toEqual({
      id: "p0",
      roomCount: 0,
      clientCount: 0,
      metadata: {},
      draining: false,
    })
    expect(byId.get("p1")?.roomCount).toBe(2)
    expect(byId.get("p1")?.clientCount).toBe(1)
    await c.stop()
  })

  test("this process's entry needs no round trip", async () => {
    // Every peer is unreachable, so only the local entry comes back — and
    // it comes back regardless.
    const c = await cluster()
    await c.kill(1)
    const processes = (await c.run(mm(c, 0).getAllProcesses())).unwrap()
    expect(processes.map((p) => p.id)).toEqual(["p0"])
    await c.stop()
  })
})

describe("createRoom", () => {
  test("a process selector can place the room on another process", async () => {
    const c = await cluster()
    const created = await c.run(
      mm(c, 0).createRoom("game", { level: 3 }, (processes) => {
        const remote = processes.find((p) => p.id === "p1")
        if (remote === undefined) throw new Error("p1 missing")
        return remote
      }),
    )
    const room = created.unwrap()
    expect(room).toBeInstanceOf(RoomProxy)
    expect(room.isRemote).toBe(true)
    expect(mm(c, 0).getRoomCount()).toBe(0)
    expect(mm(c, 1).getRoomCount()).toBe(1)
    expect(mm(c, 1).getRoom(room.id)?.roomType).toBe("game")
    await c.stop()
  })

  test("picking this process creates the room here", async () => {
    const c = await cluster()
    const created = await c.run(
      mm(c, 0).createRoom("game", {}, (processes) => {
        const local = processes.find((p) => p.id === "p0")
        if (local === undefined) throw new Error("p0 missing")
        return local
      }),
    )
    expect(created.unwrap().isRemote).toBe(false)
    expect(mm(c, 0).getRoomCount()).toBe(1)
    await c.stop()
  })

  test("a selector that picks a process it wasn't offered is refused", async () => {
    const c = await cluster()
    const created = await c.run(
      mm(c, 0).createRoom("game", {}, () => ({
        id: "nowhere",
        roomCount: 0,
        clientCount: 0,
        metadata: {},
        draining: false,
      })),
    )
    expect(created.isErr() && created.error.code).toBe("INVALID_OPTIONS")
    expect(created.isErr() && created.error.message).toContain("nowhere")
    await c.stop()
  })

  test("a room type the chosen process doesn't define fails clearly", async () => {
    const c = await createClusterHarness({ size: 2 })
    c.node(0).define("game", GameRoom)
    const created = await c.run(
      mm(c, 0).createRoom("game", {}, (processes) => {
        const remote = processes.find((p) => p.id === "p1")
        if (remote === undefined) throw new Error("p1 missing")
        return remote
      }),
    )
    expect(created.isErr() && created.error.code).toBe("ROOM_TYPE_NOT_DEFINED")
    expect(created.isErr() && created.error.message).toContain("p1")
    await c.stop()
  })
})

describe("joinRoom and joinById", () => {
  test("joinRoom finds an available room on another process", async () => {
    const c = await cluster()
    const owned = (await c.run(mm(c, 1).createRoom("game"))).unwrap()
    const found = (await c.run(mm(c, 0).joinRoom("game"))).unwrap()
    expect(found).toBeInstanceOf(RoomProxy)
    expect(found.id).toBe(owned.id)
    expect(found.roomType).toBe("game")
    await c.stop()
  })

  test("joinRoom prefers a room on this process", async () => {
    const c = await cluster()
    ;(await c.run(mm(c, 1).createRoom("game"))).unwrap()
    const here = (await c.run(mm(c, 0).createRoom("game"))).unwrap()
    const found = (await c.run(mm(c, 0).joinRoom("game"))).unwrap()
    expect(found.id).toBe(here.id)
    expect(found.isRemote).toBe(false)
    await c.stop()
  })

  test("joinRoom reports a room type no process defines", async () => {
    const c = await cluster()
    const found = await c.run(mm(c, 0).joinRoom("nope"))
    expect(found.isErr() && found.error.code).toBe("ROOM_TYPE_NOT_DEFINED")
    await c.stop()
  })

  test("joinById locates a room anywhere in the cluster", async () => {
    const c = await cluster(3)
    const owned = (await c.run(mm(c, 2).createRoom("game"))).unwrap()
    const found = (await c.run(mm(c, 0).joinById(owned.id))).unwrap()
    expect(found.id).toBe(owned.id)
    expect((found as RoomProxy).processId).toBe("p2")
    await c.stop()
  })

  test("joinById of an unknown id is ROOM_NOT_FOUND after the window", async () => {
    const c = await cluster()
    const found = await c.run(mm(c, 0).joinById("no-such-room"))
    expect(found.isErr() && found.error.code).toBe("ROOM_NOT_FOUND")
    await c.stop()
  })

  test("a private room is reachable by id but not by type", async () => {
    const c = await cluster()
    const owned = (await c.run(mm(c, 1).createRoom("game"))).unwrap()
    owned.makePrivate()
    expect((await c.run(mm(c, 0).joinRoom("game"))).isErr()).toBe(true)
    expect((await c.run(mm(c, 0).joinById(owned.id))).unwrap().id).toBe(
      owned.id,
    )
    await c.stop()
  })
})

describe("query", () => {
  test("merges listings from every process", async () => {
    const c = await cluster(3)
    const a = (await c.run(mm(c, 0).createRoom("game", { tag: "a" }))).unwrap()
    const b = (await c.run(mm(c, 1).createRoom("game", { tag: "b" }))).unwrap()
    const d = (await c.run(mm(c, 2).createRoom("game", { tag: "c" }))).unwrap()

    const rooms = (await c.run(mm(c, 0).query({ type: "game" }))).unwrap()
    expect(rooms.map((r) => r.id).sort()).toEqual([a.id, b.id, d.id].sort())
    expect(new Map(rooms.map((r) => [r.id, r.processId])).get(b.id)).toBe("p1")
    await c.stop()
  })

  test("metadata is matched on each process, filters run here", async () => {
    const c = await cluster()
    const keep = (
      await c.run(mm(c, 1).createRoom("game", { metadata: { mode: "duel" } }))
    ).unwrap()
    ;(
      await c.run(mm(c, 1).createRoom("game", { metadata: { mode: "ffa" } }))
    ).unwrap()

    const byMetadata = (
      await c.run(mm(c, 0).query({ type: "game", metadata: { mode: "duel" } }))
    ).unwrap()
    expect(byMetadata.map((r) => r.id)).toEqual([keep.id])

    const byFilter = (
      await c.run(
        mm(c, 0).query({
          type: "game",
          filters: [(room) => room.metadata["mode"] === "ffa"],
        }),
      )
    ).unwrap()
    expect(byFilter).toHaveLength(1)
    expect(byFilter[0]?.metadata["mode"]).toBe("ffa")
    await c.stop()
  })

  test("private rooms need includePrivate, wherever they are", async () => {
    const c = await cluster()
    const hidden = (await c.run(mm(c, 1).createRoom("game"))).unwrap()
    hidden.makePrivate()
    await c.flush()
    expect((await c.run(mm(c, 0).query({ type: "game" }))).unwrap()).toEqual([])
    const all = (
      await c.run(mm(c, 0).query({ type: "game", includePrivate: true }))
    ).unwrap()
    expect(all.map((r) => r.id)).toEqual([hidden.id])
    await c.stop()
  })
})

describe("RoomProxy", () => {
  test("forwards control and re-reads the room's description", async () => {
    const c = await cluster()
    const owned = (await c.run(mm(c, 1).createRoom("game"))).unwrap()
    const proxy = (await c.run(mm(c, 0).joinById(owned.id))).unwrap()

    proxy.lock()
    proxy.makePrivate()
    proxy.setPresence("ann", { ready: true })
    await c.flush()
    expect(owned.locked).toBe(true)
    expect(owned.visibility).toBe("private")
    expect(owned.getPresence("ann")).toEqual({ ready: true })

    const presence = await c.run((proxy as RoomProxy).fetchPresence())
    expect([...presence.unwrap()]).toEqual([["ann", { ready: true }]])

    owned.unlock()
    owned.makePublic()
    await c.run((proxy as RoomProxy).refresh())
    expect(proxy.locked).toBe(false)
    expect(proxy.visibility).toBe("public")
    await c.stop()
  })

  test("dispose reaches the owning process", async () => {
    const c = await cluster()
    const owned = (await c.run(mm(c, 1).createRoom("game"))).unwrap()
    const proxy = (await c.run(mm(c, 0).joinById(owned.id))).unwrap()
    await c.run(proxy.dispose())
    await c.flush()
    expect(mm(c, 1).getRoom(owned.id)).toBeUndefined()
    await c.stop()
  })

  test("removeRoom disposes a room on another process", async () => {
    const c = await cluster()
    const owned = (await c.run(mm(c, 1).createRoom("game"))).unwrap()
    mm(c, 0).removeRoom(owned.id)
    await c.tick(250)
    expect(mm(c, 1).getRoom(owned.id)).toBeUndefined()
    await c.stop()
  })

  test("seating a Client on a proxy is refused with an explanation", async () => {
    const c = await cluster()
    const owned = (await c.run(mm(c, 1).createRoom("game"))).unwrap()
    const proxy = (await c.run(mm(c, 0).joinById(owned.id))).unwrap()
    const refused = await proxy.join(new Client("bot"))
    expect(refused.isErr() && refused.error.code).toBe("INVALID_STATE")
    expect(refused.isErr() && refused.error.message).toContain("p1")
    await c.stop()
  })
})
