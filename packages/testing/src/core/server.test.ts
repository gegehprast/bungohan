/**
 * Connection-level behavior: protocol violations (spec §6.7.6), PING/PONG,
 * metrics (§6.6) and the optional HTTP server.
 */
import { describe, expect, test } from "bun:test"
import { ClientFrameType, CloseCode, PROTOCOL_VERSION } from "@bungohan/types"
import { createServerHarness } from "../harness"
import { GameRoom } from "./fixtures"
import { type GameView, serverRoom, setup } from "./helpers"

describe("protocol violations close the connection with 1008", () => {
  type Act = (room: GameView, send: (bytes: number[]) => void) => void
  const cases: [name: string, act: Act, why: RegExp][] = [
    ["an unparseable frame", (_room, send) => send([0xff]), /unknown frame/],
    [
      "a truncated header",
      (_room, send) => send([0, 0x80]),
      /bad frame header/,
    ],
    [
      "a message id outside the table",
      (room) => room.sendById(99, []),
      /unknown message id 99/,
    ],
    [
      "a payload of the wrong type",
      (room) => room.sendById(0, ["not a number"]),
      /move\.dx: expected an int32/,
    ],
    [
      "a malformed raw message",
      (room, send) =>
        send([ClientFrameType.ROOM_MESSAGE_RAW, room.roomRef, 0xc0]),
      /raw message must be/,
    ],
  ]

  for (const [name, act, why] of cases) {
    test(name, async () => {
      const { h, join, errors } = await setup()
      const client = h.connect()
      const room = await join(client)
      act(room, (bytes) => client.sendBytes(new Uint8Array(bytes)))
      await h.flush()
      expect(client.errors).toHaveLength(1)
      expect(client.errors[0]?.[0]).toBe("INVALID_MESSAGE")
      expect(client.errors[0]?.[1]).toMatch(why)
      expect(client.closeCode).toBe(CloseCode.POLICY_VIOLATION)
      expect(errors).toEqual([]) // a bad client is not a server error
      await h.stop()
    })
  }

  test("a JOIN whose body isn't an array", async () => {
    const { h } = await setup()
    const client = h.connect()
    client.sendFrame(ClientFrameType.JOIN, [1], "join please")
    await h.flush()
    expect(client.closeCode).toBe(CloseCode.POLICY_VIOLATION)
    await h.stop()
  })

  test("frames for a roomRef the connection doesn't hold are dropped quietly", async () => {
    const { h, join } = await setup()
    const client = h.connect()
    const room = await join(client)
    client.sendFrame(ClientFrameType.ROOM_MESSAGE, [42, 0], [100])
    client.sendFrame(ClientFrameType.LEAVE, [42])
    await h.flush()
    expect(client.connected).toBe(true)
    expect(client.errors).toEqual([])
    room.send("move", { dx: 1 })
    await h.flush()
    await h.tick(50)
    expect(room.state?.players.get(room.sessionId)?.x.get()).toBe(1)
    await h.stop()
  })
})

describe("PING / PONG", () => {
  test("PONG echoes the nonce; reported round trips feed avgLatency", async () => {
    const { h, join } = await setup({}, { metrics: { enabled: true } })
    const client = h.connect()
    const room = await join(client)
    client.ping(7)
    client.ping(8, 20)
    client.ping(9, 40)
    await h.flush()
    expect(client.pongs).toEqual([7, 8, 9])
    const metrics = h.server.getAllClientMetrics().unwrap()
    const mine = metrics.find((m) => m.clientId === room.sessionId)
    expect(mine?.avgLatency).toBe(30) // 0 means "no measurement yet"
    await h.stop()
  })
})

describe("metrics", () => {
  test("off by default: every getter is METRICS_DISABLED and nothing is counted", async () => {
    const { h, join } = await setup()
    const room = await join()
    const server = serverRoom(h, room)
    expect(h.server.getMetricsCollector()).toBeUndefined()
    expect(server._stats).toBeUndefined()
    expect(server.getClient(room.sessionId)?._stats).toBeUndefined()
    const disabled = h.server.getServerMetrics()
    expect(disabled.isErr() && disabled.error.code).toBe("METRICS_DISABLED")
    expect(h.server.getAllRoomMetrics().isErr()).toBe(true)
    expect(h.server.getAllClientMetrics().isErr()).toBe(true)
    await h.stop()
  })

  test("when on, server, room and client metrics add up", async () => {
    const { h, join } = await setup({}, { metrics: { enabled: true } })
    const a = await join()
    const b = await join()
    await h.tick(50)
    a.send("move", { dx: 1 })
    b.send("say", { text: "hi" })
    await h.flush()
    await h.tick(1000)

    const server = h.server.getServerMetrics().unwrap()
    expect(server.totalConnections).toBe(2)
    expect(server.activeRooms).toBe(1)
    expect(server.totalRoomsCreated).toBe(1)
    expect(server.uptime).toBeCloseTo(1.05, 5)
    expect(server.bytesSent).toBe(h.bytesSent())
    expect(server.bytesReceived).toBe(h.bytesReceived())

    const [room] = h.server.getAllRoomMetrics().unwrap()
    expect(room?.totalMessages).toBe(2)
    expect(room?.simulationTicks).toBe(63) // 1.05 s at 60 Hz
    expect(room?.stateSyncCount).toBe(21) // 1.05 s at 20 Hz
    expect(room?.avgStateSnapshotBytes).toBeGreaterThan(0)
    expect(room?.avgStateDeltaBytes).toBeGreaterThan(0)
    expect(room?.droppedSimulationMs).toBe(0)

    const clients = h.server.getAllClientMetrics().unwrap()
    expect(clients.map((c) => c.totalMessagesReceived).sort()).toEqual([1, 1])
    await h.stop()
  })
})

describe("HTTP server", () => {
  test("health, metrics and rooms endpoints", async () => {
    const h = await createServerHarness({
      server: {
        metrics: { enabled: true },
        http: { enabled: true, port: 0, hostname: "127.0.0.1" },
      },
      define: (s) => s.defineRoomType("game", GameRoom),
    })
    ;(await h.connect().joinOrCreate("game")).unwrap()
    const port = h.server.getHttpServer()?.getPort()
    const base = `http://127.0.0.1:${port}`
    const health = await (await fetch(`${base}/health`)).json()
    expect(health).toMatchObject({ status: "ok", rooms: 1, connections: 1 })
    const rooms = await (await fetch(`${base}/rooms`)).json()
    expect(rooms).toMatchObject([{ type: "game", clients: 1 }])
    const metrics = await (await fetch(`${base}/metrics`)).json()
    expect(metrics.server.activeRooms).toBe(1)
    const missing = await fetch(`${base}/nope`)
    expect(missing.status).toBe(404)
    expect(missing.headers.get("access-control-allow-origin")).toBe("*")
    await h.stop()
    expect(h.server.getHttpServer()).toBeUndefined()
  })
})

describe("cluster mode is a later milestone", () => {
  test("start() refuses cluster.enabled with a clear error", async () => {
    const { ServerHarness } = await import("../harness")
    const h = new ServerHarness({ server: { cluster: { enabled: true } } })
    const started = await h.server.start()
    expect(started.isErr() && started.error.code).toBe(
      "CLUSTER_NOT_IMPLEMENTED",
    )
  })

  test("a process selector choosing another process is refused", async () => {
    const { h } = await setup()
    const mm = h.server.getMatchMaker()
    const processes = (await mm.getAllProcesses()).unwrap()
    expect(processes).toEqual([
      { id: h.server.processId, roomCount: 0, clientCount: 0 },
    ])
    const remote = await mm.createRoom("game", {}, () => ({
      id: "elsewhere",
      roomCount: 0,
      clientCount: 0,
    }))
    expect(remote.isErr() && remote.error.code).toBe("CLUSTER_NOT_IMPLEMENTED")
    const local = await mm.createRoom(
      "game",
      {},
      (list) =>
        list[0] ?? {
          id: "",
          roomCount: 0,
          clientCount: 0,
        },
    )
    expect(local.isOk()).toBe(true)
    await h.stop()
  })
})

describe("over a real WebSocket", () => {
  test("JOIN → JOIN_SUCCESS → STATE_SNAPSHOT with the default transport", async () => {
    const { BungohanServer } = await import("@bungohan/core")
    const { WebSocketTransport } = await import("@bungohan/transport")
    const { encodeFrame, MessagePackSerializer } = await import(
      "@bungohan/serializer"
    )
    const server = new BungohanServer({
      transport: { config: { port: 0 } },
      logger: { level: "silent" },
      gracefulShutdown: { handleSignals: false },
    })
    server.defineRoomType("game", GameRoom)
    ;(await server.start()).unwrap()
    const transport = server.getTransport()
    if (!(transport instanceof WebSocketTransport)) throw new Error("no ws")

    const ws = new WebSocket(`ws://127.0.0.1:${transport.getPort()}`, [
      PROTOCOL_VERSION,
    ])
    ws.binaryType = "arraybuffer"
    const types: number[] = []
    const snapshot = new Promise<void>((resolve) => {
      ws.onmessage = (event) => {
        const frame = new Uint8Array(event.data as ArrayBuffer)
        types.push(frame[0] ?? -1)
        if (frame[0] === 2) resolve() // STATE_SNAPSHOT
      }
    })
    await new Promise((resolve) => {
      ws.onopen = resolve
    })
    const body = new MessagePackSerializer()
      .encode([0, "game", {}, null])
      .unwrap()
    ws.send(encodeFrame(ClientFrameType.JOIN, [1], body).unwrap())
    await snapshot
    expect(types).toEqual([4, 0, 2]) // JOIN_SUCCESS, welcome, snapshot
    ws.close()
    ;(await server.stop()).unwrap()
  })
})
