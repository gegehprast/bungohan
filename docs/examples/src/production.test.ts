import { afterEach, expect, spyOn, test } from "bun:test"
import { createBungohanClient } from "@bungohan/client-js"
import type { BungohanServer } from "@bungohan/core"
import { ArenaState, arenaContract } from "@bungohan/tutorial-shared"
import { createGameServer, report } from "./production"

let server: BungohanServer | undefined

afterEach(async () => {
  await server?.stop()
  server = undefined
})

test("the production server starts, serves HTTP and stops cleanly", async () => {
  const log = spyOn(console, "log").mockImplementation(() => {})
  server = createGameServer({ port: 0, httpPort: 0, handleSignals: false })
  ;(await server.start()).unwrap()

  const http = server.getHttpServer()?.getPort()
  const health = await fetch(`http://127.0.0.1:${http}/health`)
  expect(await health.json()).toMatchObject({ status: "ok", rooms: 0 })
  expect((await fetch(`http://127.0.0.1:${http}/ready`)).status).toBe(200)

  const port = server.getPort() // the one port 0 picked
  const client = createBungohanClient({ url: `ws://127.0.0.1:${port}` })
  const joined = await client.joinOrCreate(
    "arena",
    { create: { gems: 3 }, join: { name: "Ada" } },
    { state: ArenaState, contract: arenaContract },
  )
  expect(joined.isOk()).toBe(true)
  expect(report(server)).toBe("1 connected, 1 rooms, 0 shed")

  const rooms = await fetch(`http://127.0.0.1:${http}/rooms`)
  expect(await rooms.json()).toMatchObject([{ type: "arena", clients: 1 }])

  const metrics = await fetch(`http://127.0.0.1:${http}/metrics`)
  expect(await metrics.json()).toMatchObject({ server: { activeRooms: 1 } })

  await client.disconnect()
  expect((await server.stop()).isOk()).toBe(true)
  server = undefined
  log.mockRestore()
}, 20_000)
