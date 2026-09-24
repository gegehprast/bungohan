import { afterEach, expect, test } from "bun:test"
import { createBungohanClient } from "@bungohan/client-js"
import type { BungohanServer } from "@bungohan/core"
import { createClusterHarness } from "@bungohan/testing"
import { ArenaRoom } from "@bungohan/tutorial-server/ArenaRoom"
import { ArenaState, arenaContract } from "@bungohan/tutorial-shared"
import {
  createClusterServer,
  createMatch,
  onEventOpened,
  retire,
  trackEvents,
} from "./scaling"

const arena = { state: ArenaState, contract: arenaContract }
const options = (name: string) => ({ create: { gems: 3 }, join: { name } })

// #region harness
test("clients on different processes meet in one room", async () => {
  const cluster = await createClusterHarness({
    size: 2,
    rooms: { arena: ArenaRoom },
  })
  const a = await cluster.connect(0) // socket on process 0
  const b = await cluster.connect(1) // socket on process 1
  const ada = (
    await cluster.run(a.joinOrCreate("arena", options("Ada"), arena))
  ).unwrap()
  const bo = (
    await cluster.run(b.joinOrCreate("arena", options("Bo"), arena))
  ).unwrap()
  await cluster.tick(50)

  expect(bo.id).toBe(ada.id) // one room, on process 0
  expect(bo.state.players.size).toBe(2)
  await cluster.stop()
})
// #endregion harness

test("a match is created in the player's region", async () => {
  const cluster = await createClusterHarness({
    size: 3,
    rooms: { arena: ArenaRoom },
  })
  const regions = ["eu-west", "us-east", "ap-south"]
  regions.forEach((region, i) => {
    cluster.node(i).server.setProcessMetadata({ region }).unwrap()
  })
  const server = cluster.node(0).server
  const us = await cluster.run(createMatch(server, "us-east"))
  const ap = await cluster.run(createMatch(server, "ap-south"))
  const nowhere = await cluster.run(createMatch(server, "mars"))
  const owner = (id: string | undefined) =>
    cluster.nodes.findIndex(
      (node) => node.server.getMatchMaker().getRoom(id ?? "") !== undefined,
    )
  expect(owner(us)).toBe(1)
  expect(owner(ap)).toBe(2)
  expect(owner(nowhere)).toBe(0) // no such region: the least loaded
  await cluster.stop()
})

test("a retiring process drains, then stops", async () => {
  const cluster = await createClusterHarness({
    size: 2,
    rooms: { arena: ArenaRoom },
  })
  const ada = (
    await (
      await cluster.connect(0)
    ).joinOrCreate("arena", options("Ada"), arena)
  ).unwrap()
  const server = cluster.node(0).server
  let summary: string | undefined
  const retiring = retire(server).then((s) => {
    summary = s
  })
  await cluster.tick(1_000)
  expect(server.isDraining()).toBe(true)
  // A new player lands on the other process, not in the draining one's room.
  const bo = (
    await (await cluster.connect(0)).joinOrCreate("arena", options("Bo"), arena)
  ).unwrap()
  expect(bo.id).not.toBe(ada.id)
  expect(summary).toBeUndefined()

  await ada.leave() // the last game on process 0 ends
  await cluster.flush()
  await retiring
  expect(summary).toBe("drained, 0 rooms left")
  expect(server.isRunning()).toBe(false)
  await cluster.stop()
})

const redisUrl = process.env["REDIS_URL"]
let servers: BungohanServer[] = []

afterEach(async () => {
  for (const server of servers) await server.stop()
  servers = []
})

function portOf(server: BungohanServer): number {
  const port = server.getPort()
  if (port === undefined) throw new Error("not listening")
  return port
}

test.skipIf(redisUrl === undefined)(
  "two real processes over Redis share rooms",
  async () => {
    const namespace = `docs-${crypto.randomUUID()}`
    for (const processId of ["one", "two"]) {
      const server = createClusterServer({
        port: 0,
        redisUrl: redisUrl ?? "",
        processId,
        namespace,
      })
      ;(await server.start()).unwrap()
      servers.push(server)
    }
    const [one, two] = servers
    if (one === undefined || two === undefined) throw new Error("no servers")
    const a = createBungohanClient({ url: `ws://127.0.0.1:${portOf(one)}` })
    const b = createBungohanClient({ url: `ws://127.0.0.1:${portOf(two)}` })
    const ada = (await a.joinOrCreate("arena", options("Ada"), arena)).unwrap()
    const bo = (await b.joinOrCreate("arena", options("Bo"), arena)).unwrap()
    expect(bo.id).toBe(ada.id)
    await a.disconnect()
    await b.disconnect()
  },
  20_000,
)

test("an event published on one process reaches every process", async () => {
  const cluster = await createClusterHarness({ size: 2 })
  const lists = cluster.nodes.map((node) => trackEvents(node.server))
  onEventOpened(cluster.node(1).server, "spring-cup").unwrap()
  await cluster.flush()
  expect(lists.map((open) => [...open])).toEqual([
    ["spring-cup"],
    ["spring-cup"],
  ])
  await cluster.stop()
})
