/**
 * Find-or-create across processes (spec §6.4.4): a pool's cluster-wide
 * creation lock keeps processes that find no room from each creating one,
 * and keys and `where` pools hold across the cluster.
 */
import { describe, expect, test } from "bun:test"
import { type ClusterHarness, createClusterHarness } from "../cluster"
import { GameRoom } from "../core/fixtures"
import { joinOrCreate } from "./helpers"

async function cluster(size = 3): Promise<ClusterHarness> {
  return createClusterHarness({
    size,
    rooms: { game: [GameRoom, { autoDispose: false }] },
  })
}

function mm(c: ClusterHarness, index: number) {
  return c.node(index).server.getMatchMaker()
}

function pickFirst<T>(list: T[]): T {
  const [first] = list
  if (first === undefined) throw new Error("empty list")
  return first
}

function roomCount(c: ClusterHarness): number {
  return c.nodes.reduce(
    (sum, node) => sum + node.server.getMatchMaker().getRoomCount(),
    0,
  )
}

describe("one room, whichever processes ask at once", () => {
  test("matchmaker joinOrCreate on every process", async () => {
    const c = await cluster()
    const rooms = await c.run(
      Promise.all([0, 1, 2].map((i) => mm(c, i).joinOrCreate("game"))),
    )
    const ids = new Set(rooms.map((room) => room.unwrap().id))
    expect(ids.size).toBe(1)
    expect(roomCount(c)).toBe(1)
    await c.stop()
  })

  test("clients' JOIN_OR_CREATE on different processes", async () => {
    const c = await cluster()
    const clients = await Promise.all([0, 1, 2].map((i) => c.connect(i)))
    const joined = await c.run(
      Promise.all(clients.map((client) => joinOrCreate(client))),
    )
    const ids = new Set(joined.map((room) => room.unwrap().id))
    expect(ids.size).toBe(1)
    expect(roomCount(c)).toBe(1)
    await c.stop()
  })

  test("reserve and joinOrCreate with the same where, on two processes", async () => {
    const c = await cluster(2)
    const where = { tier: "low" }
    const [room, reservation] = await c.run(
      Promise.all([
        mm(c, 0).joinOrCreate("game", {}, { where }),
        mm(c, 1).reserve("game", {}, { where }),
      ]),
    )
    expect(reservation.unwrap().roomId).toBe(room.unwrap().id)
    expect(room.unwrap().metadata).toEqual(where)
    expect(roomCount(c)).toBe(1)
    await c.stop()
  })

  test("a private where pool is found and reserved from another process", async () => {
    const c = await createClusterHarness({
      size: 2,
      rooms: {
        game: [GameRoom, { autoDispose: false, visibility: "private" }],
      },
    })
    const where = { region: "eu" }
    const first = (
      await c.run(mm(c, 0).reserve("game", {}, { where }))
    ).unwrap()
    const second = (
      await c.run(mm(c, 1).reserve("game", {}, { where }))
    ).unwrap()
    expect(second.roomId).toBe(first.roomId)
    expect(roomCount(c)).toBe(1)
    await c.stop()
  })
})

describe("keys across processes", () => {
  test("concurrent keyed calls anywhere create one room", async () => {
    const c = await cluster()
    const [a, b, created] = await c.run(
      Promise.all([
        mm(c, 0).joinOrCreate("game", {}, { key: "m1" }),
        mm(c, 1).joinOrCreate("game", {}, { key: "m1" }),
        mm(c, 2).createRoom("game", {}, { key: "m1" }),
      ]),
    )
    const id = a.unwrap().id
    expect(b.unwrap().id).toBe(id)
    // The createRoom either made the room or found it made.
    if (created.isOk()) expect(created.value.id).toBe(id)
    else expect(created.error.code).toBe("ROOM_EXISTS")
    expect(roomCount(c)).toBe(1)
    await c.stop()
  })

  test("a keyed room elsewhere is found, even on a draining process", async () => {
    const c = await cluster(2)
    const there = (
      await c.run(mm(c, 1).createRoom("game", {}, { key: "m1" }))
    ).unwrap()
    there.lock()
    void c.node(1).server.drain()
    await c.flush()
    const found = (
      await c.run(mm(c, 0).joinOrCreate("game", {}, { key: "m1" }))
    ).unwrap()
    expect(found.id).toBe(there.id)
    expect(found.key).toBe("m1")
    const twice = await c.run(mm(c, 0).createRoom("game", {}, { key: "m1" }))
    expect(twice.isErr() && twice.error.code).toBe("ROOM_EXISTS")
    expect(roomCount(c)).toBe(1)
    await c.stop()
  })

  test("a room created on another process by a selector keeps key and where", async () => {
    const c = await cluster(2)
    const target = mm(c, 1).getProcessId()
    const room = (
      await c.run(
        mm(c, 0).createRoom(
          "game",
          {},
          {
            key: "m9",
            where: { tier: "low" },
            process: (processes) =>
              processes.find((p) => p.id === target) ?? pickFirst(processes),
          },
        ),
      )
    ).unwrap()
    expect(room.isRemote).toBe(true)
    const local = mm(c, 1).getRoom(room.id)
    expect(local?.key).toBe("m9")
    expect(local?.metadata).toEqual({ tier: "low" })
    await c.stop()
  })
})

describe("a lock whose holder or coordinator goes away", () => {
  function cluster3(): Promise<ClusterHarness> {
    return cluster(3)
  }

  function lockOf(c: ClusterHarness, index: number) {
    const node = c.node(index).server.getCluster()
    if (node === undefined) throw new Error("no cluster node")
    return node
  }

  test("a waiter gets the lock when its holder stops", async () => {
    const c = await cluster3()
    const coordinator = lockOf(c, 0)._coordinatorOf("game")
    const ids = c.nodes.map((node) =>
      node.server.getMatchMaker().getProcessId(),
    )
    // Hold "game" from a process that isn't the coordinator.
    const holder = ids.findIndex((id) => id !== coordinator)
    await c.run(lockOf(c, holder).lock("game"))
    const waiter = ids.findIndex((id, i) => i !== holder && id !== coordinator)
    let settled = false
    const joining = mm(c, waiter)
      .joinOrCreate("game")
      .finally(() => {
        settled = true
      })
    await c.tick(1_000) // well past every collection window
    expect(settled).toBe(false) // waiting for the lock
    await c.node(holder).server.stop() // says goodbye: its lease ends
    const room = (await c.run(joining)).unwrap()
    expect(room.id).toBeString()
    await c.stop()
  })

  test("a waiter asks the next coordinator when its coordinator stops", async () => {
    const c = await cluster3()
    const coordinator = lockOf(c, 0)._coordinatorOf("game")
    const ids = c.nodes.map((node) =>
      node.server.getMatchMaker().getProcessId(),
    )
    const [holder, waiter] = ids
      .map((_, i) => i)
      .filter((i) => ids[i] !== coordinator)
    if (holder === undefined || waiter === undefined) throw new Error("setup")
    await c.run(lockOf(c, holder).lock("game"))
    let settled = false
    const joining = mm(c, waiter)
      .joinOrCreate("game")
      .finally(() => {
        settled = true
      })
    await c.tick(1_000) // well past every collection window
    expect(settled).toBe(false) // waiting for the lock
    await c.node(ids.indexOf(coordinator)).server.stop()
    const room = (await c.run(joining)).unwrap()
    expect(room.id).toBeString()
    await c.stop()
  })

  test("a key with a NUL is refused before it crosses the backplane", async () => {
    const c = await cluster(2)
    const bad = await c.run(mm(c, 0).joinOrCreate("game", {}, { key: "a\0b" }))
    expect(bad.isErr() && bad.error.code).toBe("INVALID_OPTIONS")
    await c.stop()
  })
})
