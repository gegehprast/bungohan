import { afterEach, expect, test } from "bun:test"
import { createBungohanClient } from "@bungohan/client-js"
import type { BungohanServer } from "@bungohan/core"
import { createClusterHarness } from "@bungohan/testing"
import { ArenaRoom } from "@bungohan/tutorial-server/ArenaRoom"
import { ArenaState, arenaContract } from "@bungohan/tutorial-shared"
import { createClusterServer } from "./scaling"

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

const redisUrl = process.env["REDIS_URL"]
let servers: BungohanServer[] = []

afterEach(async () => {
  for (const server of servers) await server.stop()
  servers = []
})

function portOf(server: BungohanServer): number {
  const transport = server.getTransport()
  const port =
    "getPort" in transport && typeof transport.getPort === "function"
      ? transport.getPort()
      : undefined
  if (typeof port !== "number") throw new Error("no port")
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
