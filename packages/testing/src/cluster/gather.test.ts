/**
 * Cluster broadcasts (process list, room lookup, query) end once every live
 * peer has answered, rather than always waiting out `gatherTimeout`.
 */
import { expect, test } from "bun:test"
import { type ClusterHarness, createClusterHarness } from "../cluster"
import { GameRoom } from "../core/fixtures"

const HEARTBEAT = 2_000
const GATHER = 200

async function cluster(size: number): Promise<ClusterHarness> {
  return createClusterHarness({
    size,
    rooms: { game: [GameRoom, { autoDispose: false }] },
    cluster: { heartbeatInterval: HEARTBEAT, gatherTimeout: GATHER },
  })
}

/** Simulated time `work` takes on the cluster's clock. */
async function timed<T>(
  c: ClusterHarness,
  work: () => Promise<T>,
): Promise<{ value: T; ms: number }> {
  const start = c.clock.now()
  const value = await c.run(work())
  return { value, ms: c.clock.now() - start }
}

function mm(c: ClusterHarness, index: number) {
  return c.node(index).server.getMatchMaker()
}

test("a cluster of one looks nothing up once it knows it's alone", async () => {
  const c = await cluster(1)
  await c.tick(HEARTBEAT)
  const reserved = await timed(c, () => mm(c, 0).reserve("game", {}))
  expect(reserved.value.isOk()).toBe(true)
  expect(reserved.ms).toBe(0)
  const listed = await timed(c, () => mm(c, 0).query({ type: "game" }))
  expect(listed.value.unwrap()).toHaveLength(1)
  expect(listed.ms).toBe(0)
  await c.stop()
})

test("a broadcast ends as soon as every live peer has answered", async () => {
  const c = await cluster(3)
  await c.tick(HEARTBEAT)
  // Nothing anywhere: every peer says so, and the room is created at once.
  const created = await timed(c, () =>
    mm(c, 0).reserve("game", {}, { where: { tier: "low" } }),
  )
  expect(created.ms).toBe(0)
  const roomId = created.value.unwrap().roomId
  // Found on another process, by a lookup and by a query.
  const found = await timed(c, () =>
    mm(c, 1).reserve("game", {}, { where: { tier: "low" } }),
  )
  expect(found.value.unwrap().roomId).toBe(roomId)
  expect(found.ms).toBe(0)
  const listed = await timed(c, () => mm(c, 2).query({ type: "game" }))
  expect(listed.value.unwrap().map((room) => room.id)).toEqual([roomId])
  expect(listed.ms).toBe(0)
  const processes = await timed(c, () => mm(c, 2).getAllProcesses())
  expect(processes.value.unwrap()).toHaveLength(3)
  expect(processes.ms).toBe(0)
  await c.stop()
})

test("a peer that stays silent is waited for, up to gatherTimeout", async () => {
  const c = await cluster(3)
  await c.tick(HEARTBEAT)
  const room = (await c.run(mm(c, 1).createRoom("game"))).unwrap()
  // Dead, but not yet past peerTimeout: still believed alive.
  await c.kill(2)
  const listed = await timed(c, () => mm(c, 0).query({ type: "game" }))
  expect(listed.value.unwrap().map((r) => r.id)).toEqual([room.id])
  expect(listed.ms).toBe(GATHER)
  await c.stop()
})

test("before a heartbeat round, a broadcast waits out its window", async () => {
  // It may not have heard from every peer yet, and would miss their rooms.
  const c = await cluster(1)
  const listed = await timed(c, () => mm(c, 0).query({ type: "game" }))
  expect(listed.value.unwrap()).toEqual([])
  expect(listed.ms).toBe(GATHER)
  await c.stop()
})
