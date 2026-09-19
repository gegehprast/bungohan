import { afterEach, describe, expect, test } from "bun:test"
import type { ConnectionContext } from "./transport"
import { WebSocketTransport, type WebSocketTransportOptions } from "./websocket"

const open: WebSocketTransport[] = []
const sockets: WebSocket[] = []

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close()
  for (const transport of open.splice(0)) await transport.close()
})

/** A listening transport on a free port. */
async function serve(
  options?: WebSocketTransportOptions,
): Promise<[WebSocketTransport, string]> {
  const transport = new WebSocketTransport(options)
  const listening = await transport.listen(0, { hostname: "127.0.0.1" })
  expect(listening.isOk()).toBe(true)
  open.push(transport)
  return [transport, `ws://127.0.0.1:${transport.getPort()}`]
}

/** Resolves with the next value passed to a transport callback. */
function next<A extends unknown[]>(
  register: (cb: (...args: A) => void) => void,
): Promise<A> {
  return new Promise((resolve) => register((...args) => resolve(args)))
}

/** Connects a client; resolves once the server has seen the connection. */
async function connect(
  transport: WebSocketTransport,
  url: string,
  init?: { headers?: Record<string, string> },
): Promise<[WebSocket, string, ConnectionContext]> {
  const seen = next<[string, ConnectionContext]>((cb) =>
    transport.onConnection(cb),
  )
  // Bun's client accepts headers (a Bun extension of the WHATWG API). The
  // DOM lib's constructor type shadows Bun's overload, hence the cast.
  const socket = new WebSocket(url, init as unknown as string[])
  socket.binaryType = "arraybuffer"
  sockets.push(socket)
  const [clientId, context] = await seen
  if (socket.readyState !== WebSocket.OPEN) {
    await new Promise((resolve) => socket.addEventListener("open", resolve))
  }
  return [socket, clientId, context]
}

function received(socket: WebSocket): Promise<Uint8Array> {
  return new Promise((resolve) =>
    socket.addEventListener(
      "message",
      (event) => resolve(new Uint8Array(event.data as ArrayBuffer)),
      { once: true },
    ),
  )
}

function closed(socket: WebSocket): Promise<[number, string]> {
  return new Promise((resolve) =>
    socket.addEventListener("close", (event) =>
      resolve([event.code, event.reason]),
    ),
  )
}

describe("WebSocketTransport", () => {
  test("accepts connections and exposes the context", async () => {
    const [transport, url] = await serve()
    const [, clientId, context] = await connect(
      transport,
      `${url}/?token=abc&room=1`,
    )
    expect(transport.isClientConnected(clientId)).toBe(true)
    expect(transport.getClientCount()).toBe(1)
    expect(context.token).toBe("abc")
    expect(context.searchParams.get("room")).toBe("1")
    expect(context.ip).toBe("127.0.0.1")
    expect(transport.getName()).toBe("websocket")
  })

  test("reads a bearer token from the Authorization header", async () => {
    const [transport, url] = await serve()
    const [, , context] = await connect(transport, url, {
      headers: { Authorization: "Bearer s3cret" },
    })
    expect(context.token).toBe("s3cret")
    expect(context.headers.get("authorization")).toBe("Bearer s3cret")
  })

  test("no token means no token property", async () => {
    const [transport, url] = await serve()
    const [, , context] = await connect(transport, url)
    expect("token" in context).toBe(false)
  })

  test("moves binary frames both ways", async () => {
    const [transport, url] = await serve()
    const [socket, clientId] = await connect(transport, url)

    const inbound = next<[string, Uint8Array]>((cb) => transport.onMessage(cb))
    socket.send(Uint8Array.of(1, 2, 3))
    const [from, data] = await inbound
    expect(from).toBe(clientId)
    expect([...data]).toEqual([1, 2, 3])

    const outbound = received(socket)
    expect(transport.send(clientId, Uint8Array.of(9, 8)).isOk()).toBe(true)
    expect([...(await outbound)]).toEqual([9, 8])
  })

  test("broadcast delivers one buffer to every reachable client", async () => {
    const [transport, url] = await serve()
    const [a, idA] = await connect(transport, url)
    const [b, idB] = await connect(transport, url)
    const frames = Promise.all([received(a), received(b)])
    const result = transport.broadcast([idA, "ghost", idB], Uint8Array.of(7))
    expect(result.isErr() && result.error.message).toBe(
      "broadcast failed for 1 of 3 clients",
    )
    expect(result.isErr() && result.error).toMatchObject({
      code: "CONNECTION_LOST",
      context: ["ghost"],
    })
    expect((await frames).map((frame) => [...frame])).toEqual([[7], [7]])
  })

  test("server-initiated disconnect: immediate, and onDisconnect fires", async () => {
    const [transport, url] = await serve()
    const [socket, clientId] = await connect(transport, url)
    const clientSaw = closed(socket)
    const serverSaw = next<[string, number, string]>((cb) =>
      transport.onDisconnect(cb),
    )
    expect(transport.disconnect(clientId, 4000, "kicked").isOk()).toBe(true)
    expect(transport.isClientConnected(clientId)).toBe(false)
    expect(transport.send(clientId, Uint8Array.of(1)).isErr()).toBe(true)
    expect(await clientSaw).toEqual([4000, "kicked"])
    expect(await serverSaw).toEqual([clientId, 4000, "kicked"])
  })

  test("client-initiated close", async () => {
    const [transport, url] = await serve()
    const [socket, clientId] = await connect(transport, url)
    const serverSaw = next<[string, number, string]>((cb) =>
      transport.onDisconnect(cb),
    )
    socket.close(1000, "bye")
    expect(await serverSaw).toEqual([clientId, 1000, "bye"])
    expect(transport.getClientCount()).toBe(0)
  })

  test("unknown clients and bad states are errors, not throws", async () => {
    const transport = new WebSocketTransport()
    const send = transport.send("nobody", Uint8Array.of(1))
    expect(send.isErr() && send.error).toMatchObject({
      code: "CLIENT_NOT_FOUND",
    })
    const drop = transport.disconnect("nobody")
    expect(drop.isErr() && drop.error).toMatchObject({
      code: "CLIENT_NOT_FOUND",
    })
    const stop = await transport.close()
    expect(stop.isErr() && stop.error).toMatchObject({
      code: "INVALID_OPTIONS",
    })
    const port = await transport.listen(70000)
    expect(port.isErr() && port.error).toMatchObject({
      code: "INVALID_OPTIONS",
    })

    const [running] = await serve()
    const again = await running.listen(0)
    expect(again.isErr() && again.error).toMatchObject({
      code: "INVALID_OPTIONS",
    })

    const taken = await new WebSocketTransport().listen(
      running.getPort() ?? 0,
      { hostname: "127.0.0.1" },
    )
    expect(taken.isErr() && taken.error).toMatchObject({
      code: "CONNECTION_FAILED",
    })
  })

  test("plain HTTP requests get 426", async () => {
    const [, url] = await serve()
    const response = await fetch(url.replace("ws:", "http:"))
    expect(response.status).toBe(426)
  })

  test("a throwing handler is routed to onError", async () => {
    const [transport, url] = await serve()
    const failure = next<[Error]>((cb) => transport.onError(cb))
    transport.onConnection(() => {
      throw new Error("core bug")
    })
    const socket = new WebSocket(url)
    sockets.push(socket)
    const [error] = await failure
    expect(error.message).toBe("core bug")
  })

  test("close() sends everyone 1001 and frees the port", async () => {
    const transport = new WebSocketTransport()
    await transport.listen(0, { hostname: "127.0.0.1" })
    const port = transport.getPort() ?? 0
    const [socket] = await connect(transport, `ws://127.0.0.1:${port}`)
    const clientSaw = closed(socket)
    const disconnects: number[] = []
    transport.onDisconnect((_, code) => disconnects.push(code))
    // A raw client whose upgrade response may not even be flushed yet.
    const raw = rawFrames(port, 1)
    await next((cb) => transport.onConnection(cb))

    expect((await transport.close()).isOk()).toBe(true)
    expect(transport.getPort()).toBeUndefined()
    // On the wire: a close frame carrying 1001 (GOING_AWAY). (Bun's own
    // WebSocket client reports 1001 as 1000, so check the bytes.)
    const [frame] = (await raw).frames
    expect(frame?.opcode).toBe(8)
    expect(frame?.closeCode).toBe(1001)
    await clientSaw
    expect(disconnects).toEqual([1001, 1001])

    const again = new WebSocketTransport()
    expect((await again.listen(port, { hostname: "127.0.0.1" })).isOk()).toBe(
      true,
    )
    open.push(again)
  })
})

// ---------------------------------------------------------------------------
// Compression, observed on the wire (spec §5.7.7)
// ---------------------------------------------------------------------------

interface RawFrame {
  opcode: number
  /** RSV1: set on a permessage-deflate compressed frame. */
  compressed: boolean
  /** Frame size on the wire, header included. */
  bytes: number
  /** Close frames: the status code. */
  closeCode?: number
}

/**
 * Opens a raw TCP connection, performs the WebSocket handshake offering
 * permessage-deflate, and collects the first `count` server frames.
 */
function rawFrames(
  port: number,
  count: number,
): Promise<{ negotiated: boolean; frames: RawFrame[] }> {
  return new Promise((resolve) => {
    let buffer = new Uint8Array(0)
    let negotiated: boolean | undefined
    const frames: RawFrame[] = []
    Bun.connect({
      hostname: "127.0.0.1",
      port,
      socket: {
        open(socket) {
          socket.write(
            "GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\n" +
              "Connection: Upgrade\r\nSec-WebSocket-Version: 13\r\n" +
              "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
              "Sec-WebSocket-Extensions: permessage-deflate\r\n\r\n",
          )
        },
        data(socket, chunk) {
          const merged = new Uint8Array(buffer.length + chunk.length)
          merged.set(buffer)
          merged.set(chunk, buffer.length)
          buffer = merged
          if (negotiated === undefined) {
            const text = new TextDecoder().decode(buffer)
            const end = text.indexOf("\r\n\r\n")
            if (end < 0) return
            negotiated = text.slice(0, end).includes("permessage-deflate")
            buffer = buffer.subarray(end + 4)
          }
          while (buffer.length >= 2) {
            const first = buffer[0] ?? 0
            let length = (buffer[1] ?? 0) & 0x7f
            let header = 2
            if (length === 126) {
              if (buffer.length < 4) return
              length = ((buffer[2] ?? 0) << 8) | (buffer[3] ?? 0)
              header = 4
            }
            if (buffer.length < header + length) return
            const frame: RawFrame = {
              opcode: first & 0x0f,
              compressed: (first & 0x40) !== 0,
              bytes: header + length,
            }
            if (frame.opcode === 8 && length >= 2) {
              frame.closeCode =
                ((buffer[header] ?? 0) << 8) | (buffer[header + 1] ?? 0)
            }
            frames.push(frame)
            buffer = buffer.subarray(header + length)
            if (frames.length === count) {
              socket.end()
              resolve({ negotiated: negotiated ?? false, frames })
              return
            }
          }
        },
      },
    })
  })
}

describe("compression", () => {
  const small = Uint8Array.of(0x91, 0x94, 0, 57, 0, 0xcd, 0x38, 0xd6) // 8 B delta
  /** Frames sent on connect; the raw client ignores the handshake race. */
  const large = new Uint8Array(1000).fill(7)

  async function framesFor(
    options: WebSocketTransportOptions,
  ): Promise<{ negotiated: boolean; frames: RawFrame[] }> {
    const [transport] = await serve(options)
    transport.onConnection((clientId) => {
      transport.send(clientId, small)
      transport.broadcast([clientId], large)
    })
    return rawFrames(transport.getPort() ?? 0, 2)
  }

  test("on by default: large frames deflated, small frames left alone", async () => {
    const { negotiated, frames } = await framesFor({})
    expect(negotiated).toBe(true)
    // Deflating the 8-byte delta would have made it 14 bytes.
    expect(frames[0]).toEqual({ opcode: 2, compressed: false, bytes: 10 })
    expect(frames[1]?.compressed).toBe(true)
    expect(frames[1]?.bytes).toBeLessThan(100)
  })

  test("the threshold is configurable", async () => {
    const { frames } = await framesFor({ compressionThreshold: 0 })
    expect(frames.map((frame) => frame.compressed)).toEqual([true, true])
  })

  test("off: not negotiated, nothing compressed", async () => {
    const { negotiated, frames } = await framesFor({ compression: false })
    expect(negotiated).toBe(false)
    expect(frames.map((frame) => frame.compressed)).toEqual([false, false])
    expect(frames[1]?.bytes).toBe(1004)
  })
})
