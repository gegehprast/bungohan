import { afterEach, expect, spyOn, test } from "bun:test"
import { createBungohanClient } from "@bungohan/client-js"
import type { BungohanServer } from "@bungohan/core"
import { ArenaState, arenaContract } from "@bungohan/tutorial-shared"
import {
  busiestRoom,
  createGameServer,
  opsOnly,
  report,
  signupRoute,
} from "./production"

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
  const busiest = await busiestRoom(`http://127.0.0.1:${http}`)
  expect(busiest).toBe(joined.isOk() ? joined.value.id : "")

  // The admin route, behind its token.
  const admin = `http://127.0.0.1:${http}/admin/arenas`
  expect((await fetch(admin, { method: "POST" })).status).toBe(403)
  process.env["ADMIN_TOKEN"] = "s3cret"
  const created = await fetch(admin, {
    method: "POST",
    headers: { authorization: "Bearer s3cret" },
  })
  expect(created.status).toBe(201)
  delete process.env["ADMIN_TOKEN"]

  await client.disconnect()
  expect((await server.stop()).isOk()).toBe(true)
  server = undefined
  log.mockRestore()
}, 20_000)

test("opsOnly lets probes through and wants the token for the rest", () => {
  const ask = (endpoint: "health" | "rooms", auth?: string) =>
    opsOnly(
      new Request("http://game/x", {
        headers: auth === undefined ? {} : { authorization: auth },
      }),
      { endpoint, ip: "10.0.0.1" },
    )
  process.env["OPS_TOKEN"] = "ops"
  expect(ask("health")).toBe(true)
  expect(ask("rooms")).toBe(false)
  expect(ask("rooms", "Bearer ops")).toBe(true)
  delete process.env["OPS_TOKEN"]
  expect(ask("rooms", "Bearer ops")).toBe(false)
})

test("signupRoute limits each address on its own", () => {
  const signup = (ip: string) =>
    signupRoute(new Request("http://game/signup"), { ip })?.status
  for (let i = 0; i < 10; i++) expect(signup("10.0.0.1")).toBe(200)
  expect(signup("10.0.0.1")).toBe(429)
  expect(signup("10.0.0.2")).toBe(200)
  expect(signupRoute(new Request("http://game/other"), { ip: "x" })).toBe(
    undefined,
  )
})
