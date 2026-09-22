/**
 * Draining and process metadata on a single process (spec §6.4.2): a
 * server behind a load balancer during a deploy. The cluster side is in
 * `../cluster/drain.test.ts`.
 */
import { describe, expect, spyOn, test } from "bun:test"
import {
  BungohanServer,
  createBungohanServer,
  MAX_PROCESS_METADATA_BYTES,
} from "@bungohan/core"
import { ManualClock } from "../clock"
import { createServerHarness } from "../harness"
import { LoopbackTransport } from "../loopback"
import { GameRoom, GameState, gameContract } from "./fixtures"
import { setup } from "./helpers"

const game = { state: GameState, contract: gameContract }

describe("process metadata", () => {
  test("the option and the setter reach getAllProcesses", async () => {
    const h = await createServerHarness({
      server: { cluster: { metadata: { region: "eu-west" } } },
      define: (s) => s.defineRoomType("game", GameRoom),
    })
    const mm = h.server.getMatchMaker()
    const [before] = (await mm.getAllProcesses()).unwrap()
    expect(before?.metadata).toEqual({ region: "eu-west" })
    expect(before?.draining).toBe(false)

    expect(h.server.setProcessMetadata({ region: "us-east" }).isOk()).toBe(true)
    const [after] = (await mm.getAllProcesses()).unwrap()
    expect(after?.metadata).toEqual({ region: "us-east" })
    expect(h.server.getProcessMetadata()).toEqual({ region: "us-east" })
    await h.stop()
  })

  test("it defaults to an empty object", async () => {
    const { h } = await setup()
    const [info] = (await h.server.getMatchMaker().getAllProcesses()).unwrap()
    expect(info?.metadata).toEqual({})
    await h.stop()
  })

  test("an oversized option is a definition-time error", () => {
    const big = { blob: "x".repeat(MAX_PROCESS_METADATA_BYTES) }
    expect(() => createBungohanServer({ cluster: { metadata: big } })).toThrow(
      /cluster\.metadata: process metadata is \d+ bytes/,
    )
    expect(() =>
      createBungohanServer({
        cluster: { metadata: [] as unknown as Record<string, unknown> },
      }),
    ).toThrow(/plain object/)
  })

  test("an oversized update is refused and changes nothing", async () => {
    const { h } = await setup()
    h.server.setProcessMetadata({ region: "eu" }).unwrap()
    const refused = h.server.setProcessMetadata({
      blob: "x".repeat(MAX_PROCESS_METADATA_BYTES),
    })
    expect(refused.isErr() && refused.error.code).toBe("INVALID_OPTIONS")
    expect(refused.isErr() && refused.error.message).toContain("1024-byte")
    expect(h.server.getProcessMetadata()).toEqual({ region: "eu" })
    await h.stop()
  })

  test("what is stored is a copy: later mutation doesn't leak in", async () => {
    const { h } = await setup()
    const metadata = { tags: ["a"] }
    h.server.setProcessMetadata(metadata).unwrap()
    metadata.tags.push("b")
    expect(h.server.getProcessMetadata()).toEqual({ tags: ["a"] })
    await h.stop()
  })
})

describe("draining a single process", () => {
  test("no new rooms: joinOrCreate and createRoom fail clearly", async () => {
    const { h, join } = await setup()
    const existing = await join()
    const drained = h.server.drain()
    expect(h.server.isDraining()).toBe(true)
    expect(h.server.isReady()).toBe(false)

    const refused = await h.connect().joinOrCreate("game", {}, game)
    expect(refused.isErr() && refused.error.code).toBe("SERVER_SHUTTING_DOWN")
    const created = await h.server.getMatchMaker().createRoom("game")
    expect(created.isErr() && created.error.code).toBe("SERVER_SHUTTING_DOWN")
    const reserved = await h.server.getMatchMaker().reserve("game")
    expect(reserved.isErr() && reserved.error.code).toBe("SERVER_SHUTTING_DOWN")
    expect(h.server.getMatchMaker().getRoomCount()).toBe(1)

    // The game in progress is untouched, and explicit joins still work.
    const byId = await h.connect().joinById(existing.roomId, {}, game)
    expect(byId.isOk()).toBe(true)
    h.server.cancelDrain()
    expect((await drained).unwrap().outcome).toBe("cancelled")
    await h.stop()
  })

  test("reconnection and reservations made before the drain still work", async () => {
    const { h, join } = await setup({ autoDispose: false })
    const mm = h.server.getMatchMaker()
    const first = h.connect()
    const room = await join(first)
    const token = room.reconnectionToken
    if (token === null) throw new Error("no reconnection token")
    const reservation = (await mm.reserve("game")).unwrap()
    await first.close(1006)
    await h.flush()

    void h.server.drain()
    const resumed = await h.connect().reconnect(token, game)
    expect(resumed.isOk() && resumed.value.sessionId).toBe(room.sessionId)
    const taken = await h.connect().consumeReservation(reservation.id, game)
    expect(taken.isOk() && taken.value.roomId).toBe(room.roomId)
    await h.stop()
  })

  test("drain() resolves once the last room is gone", async () => {
    const { h, join } = await setup()
    const client = h.connect()
    const room = await join(client)
    let settled = false
    const drained = h.server.drain().then((result) => {
      settled = true
      return result
    })
    await h.flush()
    expect(settled).toBe(false)

    await room.leave() // the last seat: the room auto-disposes
    await h.flush()
    expect((await drained).unwrap()).toEqual({ outcome: "drained", rooms: 0 })
    await h.stop()
  })

  test("drain() with no rooms resolves at once", async () => {
    const { h } = await setup()
    const result = (await h.server.drain()).unwrap()
    expect(result).toEqual({ outcome: "drained", rooms: 0 })
    await h.stop()
  })

  test("drain() resolves on its timeout, and the process keeps draining", async () => {
    const { h, join } = await setup({ autoDispose: false })
    await join()
    let settled = false
    const drained = h.server.drain({ timeout: 5_000 }).then((result) => {
      settled = true
      return result
    })
    await h.tick(4_999)
    expect(settled).toBe(false)
    await h.tick(1)
    expect((await drained).unwrap()).toEqual({ outcome: "timeout", rooms: 1 })
    expect(h.server.isDraining()).toBe(true)
    await h.stop()
    expect(h.server.isDraining()).toBe(false)
  })

  test("stop() settles a pending drain", async () => {
    const { h, join } = await setup({ autoDispose: false })
    await join()
    const drained = h.server.drain()
    await h.stop()
    expect((await drained).unwrap()).toEqual({ outcome: "drained", rooms: 0 })
  })

  test("cancelDrain() takes new rooms again", async () => {
    const { h } = await setup()
    void h.server.drain()
    h.server.cancelDrain()
    expect(h.server.isReady()).toBe(true)
    const joined = await h.connect().joinOrCreate("game", {}, game)
    expect(joined.isOk()).toBe(true)
    await h.stop()
  })

  test("query() leaves out rooms while draining unless asked", async () => {
    const { h, join } = await setup()
    const mm = h.server.getMatchMaker()
    const room = await join()
    const before = (await mm.query({ type: "game" })).unwrap()
    expect(before.map((r) => [r.id, r.draining])).toEqual([
      [room.roomId, false],
    ])

    void h.server.drain()
    expect((await mm.query({ type: "game" })).unwrap()).toEqual([])
    const all = (
      await mm.query({ type: "game", includeDraining: true })
    ).unwrap()
    expect(all.map((r) => [r.id, r.draining])).toEqual([[room.roomId, true]])
    // A listing opted into is still joinable by id.
    const byId = await h.connect().joinById(room.roomId, {}, game)
    expect(byId.isOk()).toBe(true)
    await h.stop()
  })

  test("drain() on a stopped server is INVALID_STATE", async () => {
    const { h } = await setup()
    await h.stop()
    const result = await h.server.drain()
    expect(result.isErr() && result.error.code).toBe("INVALID_STATE")
  })
})

describe("readiness", () => {
  test("/ready flips to 503 while draining; /health stays 200", async () => {
    const h = await createServerHarness({
      server: { http: { enabled: true, port: 0, hostname: "127.0.0.1" } },
      define: (s) => s.defineRoomType("game", GameRoom),
    })
    const base = `http://127.0.0.1:${h.server.getHttpServer()?.getPort()}`
    const ready = await fetch(`${base}/ready`)
    expect(ready.status).toBe(200)
    expect(await ready.json()).toMatchObject({ status: "ready" })

    void h.server.drain()
    const draining = await fetch(`${base}/ready`)
    expect(draining.status).toBe(503)
    expect(await draining.json()).toMatchObject({ status: "draining" })
    const health = await fetch(`${base}/health`)
    expect(health.status).toBe(200)
    expect(await health.json()).toMatchObject({ status: "ok", draining: true })

    h.server.cancelDrain()
    expect((await fetch(`${base}/ready`)).status).toBe(200)
    await h.stop()
  })

  test("/ready can be switched off", async () => {
    const h = await createServerHarness({
      server: {
        http: {
          enabled: true,
          port: 0,
          hostname: "127.0.0.1",
          enableReadiness: false,
        },
      },
    })
    const base = `http://127.0.0.1:${h.server.getHttpServer()?.getPort()}`
    expect((await fetch(`${base}/ready`)).status).toBe(404)
    await h.stop()
  })
})

describe("drain-first shutdown", () => {
  /** A server with signal handling on, which the harness turns off. */
  async function signalled(drainTimeout?: number) {
    const clock = new ManualClock()
    const server = new BungohanServer({
      transport: { provider: new LoopbackTransport() },
      clock,
      logger: { level: "silent" },
      gracefulShutdown: {
        timeout: 1_000,
        ...(drainTimeout !== undefined && { drainTimeout }),
      },
    })
    server.defineRoomType("game", GameRoom, { autoDispose: false })
    ;(await server.start()).unwrap()
    const exit = spyOn(process, "exit")
    const codes: number[] = []
    exit.mockImplementation(((code?: number) => {
      codes.push(code ?? 0)
    }) as typeof process.exit)
    return { clock, server, exit, codes }
  }

  /** Lets the shutdown's awaits run. */
  async function settle(): Promise<void> {
    for (let i = 0; i < 20; i++) await Promise.resolve()
  }

  test("by default a signal stops at once, as before", async () => {
    const { server, exit, codes } = await signalled()
    ;(await server.getMatchMaker().createRoom("game")).unwrap()
    process.emit("SIGTERM")
    await settle()
    exit.mockRestore()
    expect(codes).toEqual([0])
    expect(server.isRunning()).toBe(false)
  })

  test("with drainTimeout, a signal drains first and stops once empty", async () => {
    const { server, exit, codes } = await signalled(60_000)
    const room = (await server.getMatchMaker().createRoom("game")).unwrap()
    process.emit("SIGTERM")
    await settle()
    expect(server.isDraining()).toBe(true)
    expect(server.isRunning()).toBe(true)
    expect(codes).toEqual([])

    await room.dispose() // the last game ends
    await settle()
    exit.mockRestore()
    expect(codes).toEqual([0])
    expect(server.isRunning()).toBe(false)
  })

  test("the drain gives up after drainTimeout, then stops", async () => {
    const { clock, server, exit, codes } = await signalled(60_000)
    ;(await server.getMatchMaker().createRoom("game")).unwrap()
    process.emit("SIGTERM")
    await settle()
    await clock.advance(59_999)
    expect(codes).toEqual([])
    await clock.advance(1)
    await settle()
    exit.mockRestore()
    expect(codes).toEqual([0])
    expect(server.isRunning()).toBe(false)
  })

  test("a second signal cuts the drain short", async () => {
    const { server, exit, codes } = await signalled(60_000)
    ;(await server.getMatchMaker().createRoom("game")).unwrap()
    process.emit("SIGTERM")
    await settle()
    expect(codes).toEqual([])
    process.emit("SIGINT")
    await settle()
    exit.mockRestore()
    expect(codes).toEqual([0])
    expect(server.isRunning()).toBe(false)
  })
})
