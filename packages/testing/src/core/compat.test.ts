/**
 * Forward-compatibility rules (spec §6.7.7): trailing array elements are
 * ignored, unknown server frame types are dropped by clients, and the
 * protocol version is checked when the connection opens.
 */
import { describe, expect, test } from "bun:test"
import { BungohanServer } from "@bungohan/core"
import { encodeFrame, MessagePackSerializer } from "@bungohan/serializer"
import { WebSocketTransport } from "@bungohan/transport"
import {
  ClientFrameType,
  CloseCode,
  PROTOCOL_VERSION,
  ServerFrameType,
} from "@bungohan/types"
import { ManualClock } from "../clock"
import { TestClient } from "../driver"
import { LoopbackTransport } from "../loopback"
import { GameRoom } from "./fixtures"
import { setup } from "./helpers"

const serializer = new MessagePackSerializer()
const encode = (value: unknown) => serializer.encode(value).unwrap()

describe("trailing elements are ignored", () => {
  test("the server accepts a 5-element JOIN", async () => {
    const { h } = await setup()
    const client = h.connect()
    const joined = await client.joinOrCreate(
      "game",
      {},
      {
        trailing: [{ field: "from a newer client" }],
      },
    )
    expect(joined.isOk()).toBe(true)
    expect(client.closeCode).toBeUndefined()
    await h.stop()
  })

  test("the server accepts a raw message with extra elements", async () => {
    const { h, join } = await setup()
    const client = h.connect()
    const room = await join(client)
    client.sendFrame(
      ClientFrameType.ROOM_MESSAGE_RAW,
      [room.roomRef],
      ["echo", "payload", "extra"],
    )
    await h.flush()
    expect(room.messages.at(-1)).toEqual({
      type: "echo",
      payload: "payload",
      raw: true,
    })
    await h.stop()
  })

  test("the client reads the known prefix of JOIN_SUCCESS, JOIN_ERROR and ERROR", async () => {
    // A bare loopback, no server: every server frame is written by hand.
    const transport = new LoopbackTransport()
    await transport.listen(0)
    const socket = transport.connect().unwrap()
    const flush = async () => {
      ;(await transport.flush()).unwrap()
    }
    const client = new TestClient(socket, flush)
    const send = (type: number, header: number[], body: unknown) =>
      transport
        .send(socket.clientId, encodeFrame(type, header, encode(body)).unwrap())
        .unwrap()

    send(ServerFrameType.ERROR, [0], ["CODE", "message", { future: 1 }])
    await flush()
    expect(client.errors).toEqual([["CODE", "message"]])

    const failing = client.joinOrCreate("game")
    send(ServerFrameType.JOIN_ERROR, [1], ["ROOM_FULL", "full", "hint"])
    const failed = await failing
    expect(failed.isErr() && failed.error.code).toBe("ROOM_FULL")

    const joining = client.joinOrCreate("game")
    send(
      ServerFrameType.JOIN_SUCCESS,
      [2, 1],
      [
        "room",
        "game",
        "session",
        null,
        "00000000",
        "messagepack",
        [],
        [],
        "a v2 field",
      ],
    )
    const room = (await joining).unwrap()
    expect(room.roomId).toBe("room")
    expect(room.sessionId).toBe("session")
    expect(client.dropped).toEqual([])
  })

  test("contract payloads stay strict: an extra field is a violation", async () => {
    const { h, join } = await setup()
    const client = h.connect()
    const room = await join(client)
    room.sendById(0, [100, "extra"]) // move is [dx]
    await h.flush()
    expect(client.closeCode).toBe(CloseCode.POLICY_VIOLATION)
    await h.stop()
  })
})

describe("unknown server frame types", () => {
  test("a client drops and logs a frame type it doesn't know", async () => {
    const { h } = await setup()
    const logged: string[] = []
    const client = h.connect({ log: (message) => logged.push(message) })
    h.transport.send(client.socket.clientId, new Uint8Array([200, 7, 1, 2]))
    await h.flush()
    expect(client.dropped).toEqual([
      { type: 200, reason: "unknown frame type" },
    ])
    expect(logged).toEqual([
      "[bungohan/testing] dropped frame 200: unknown frame type",
    ])
    // Not fatal: the connection keeps working.
    const room = (await client.joinOrCreate("game")).unwrap()
    expect(room.roomRef).toBe(1)
    await h.stop()
  })

  test("the server still treats an unknown client frame type as a violation", async () => {
    const { h } = await setup()
    const client = h.connect()
    client.sendBytes(new Uint8Array([200, 1]))
    await h.flush()
    expect(client.errors[0]).toEqual(["INVALID_MESSAGE", "unknown frame 200"])
    expect(client.closeCode).toBe(CloseCode.POLICY_VIOLATION)
    await h.stop()
  })
})

describe("protocol version", () => {
  test("a wrong version is rejected before any frame, with a reason", async () => {
    const { h } = await setup()
    const connects: string[] = []
    h.server.onConnect((connection) => connects.push(connection.id))
    const stale = h.connect({ protocols: ["bungohan.v0"] })
    const none = h.connect({ protocols: [] })
    stale.sendFrame(ClientFrameType.JOIN, [1], [0, "game", {}, null])
    await h.flush()
    expect(stale.closeCode).toBe(CloseCode.PROTOCOL_ERROR)
    expect(stale.closeReason).toBe(
      "unsupported protocol bungohan.v0; expected bungohan.v1",
    )
    expect(none.closeCode).toBe(CloseCode.PROTOCOL_ERROR)
    expect(none.closeReason).toBe(
      "no protocol version offered; expected bungohan.v1",
    )
    expect(stale.frames).toEqual([]) // the JOIN was never read
    expect(connects).toEqual([])
    await h.stop()
  })

  test("the server picks its version from several offered", async () => {
    const { h } = await setup()
    const connected: (string | undefined)[] = []
    h.server.onConnect((c) => connected.push(c.context.protocol))
    const client = h.connect({ protocols: ["bungohan.v9", PROTOCOL_VERSION] })
    ;(await client.joinOrCreate("game")).unwrap()
    expect(connected).toEqual([PROTOCOL_VERSION])
    await h.stop()
  })

  test("core also checks, for a transport that doesn't negotiate", async () => {
    class Plain extends LoopbackTransport {
      public override acceptProtocols(): void {} // ignores the request
    }
    const transport = new Plain()
    const server = new BungohanServer({
      transport: { provider: transport },
      clock: new ManualClock(),
      logger: { level: "silent" },
      gracefulShutdown: { handleSignals: false },
    })
    server.defineRoomType("game", GameRoom)
    ;(await server.start()).unwrap()
    const socket = transport.connect().unwrap()
    let closed: [number, string] | undefined
    socket.onClose((code, reason) => {
      closed = [code, reason]
    })
    await transport.flush()
    expect(closed).toEqual([
      CloseCode.PROTOCOL_ERROR,
      "unsupported protocol none; expected bungohan.v1",
    ])
    ;(await server.stop()).unwrap()
  })

  test("over a real WebSocket, a wrong subprotocol gets a readable close", async () => {
    const server = new BungohanServer({
      transport: { config: { port: 0 } },
      logger: { level: "silent" },
      gracefulShutdown: { handleSignals: false },
    })
    ;(await server.start()).unwrap()
    const transport = server.getTransport()
    if (!(transport instanceof WebSocketTransport)) throw new Error("no ws")
    const url = `ws://127.0.0.1:${transport.getPort()}`
    const close = (protocols: string[]) =>
      new Promise<[number, string]>((resolve) => {
        const ws = new WebSocket(url, protocols)
        ws.onclose = (event) => resolve([event.code, event.reason])
      })
    expect(await close(["bungohan.v0"])).toEqual([
      1002,
      "unsupported protocol bungohan.v0; expected bungohan.v1",
    ])
    const ok = new WebSocket(url, [PROTOCOL_VERSION])
    await new Promise((resolve) => {
      ok.onopen = resolve
    })
    expect(ok.protocol).toBe(PROTOCOL_VERSION)
    ok.close()
    ;(await server.stop()).unwrap()
  })
})
