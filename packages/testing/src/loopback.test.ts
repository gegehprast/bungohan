import { describe, expect, test } from "bun:test"
import type { ConnectionContext } from "@bungohan/transport"
import { LoopbackTransport } from "./loopback"

async function listening(
  options?: ConstructorParameters<typeof LoopbackTransport>[0],
): Promise<LoopbackTransport> {
  const transport = new LoopbackTransport(options)
  expect((await transport.listen(0)).isOk()).toBe(true)
  return transport
}

describe("LoopbackTransport", () => {
  test("connect runs onConnection with a context", async () => {
    const transport = await listening()
    const seen: Array<[string, ConnectionContext]> = []
    transport.onConnection((id, context) => seen.push([id, context]))
    const socket = transport
      .connect({ token: "t", searchParams: { room: "1" }, headers: { a: "b" } })
      .unwrap()
    expect(seen.length).toBe(1)
    const [id, context] = seen[0] ?? []
    expect(id).toBe(socket.clientId)
    expect(context?.token).toBe("t")
    expect(context?.searchParams.get("room")).toBe("1")
    expect(context?.headers.get("a")).toBe("b")
    expect(transport.isClientConnected(socket.clientId)).toBe(true)
    expect(transport.getName()).toBe("loopback")
  })

  test("nothing is delivered until flush, then everything in order", async () => {
    const transport = await listening()
    const atServer: number[] = []
    transport.onMessage((_, data) => atServer.push(data[0] ?? -1))
    const socket = transport.connect().unwrap()
    const atClient: number[] = []
    socket.onMessage((data) => atClient.push(data[0] ?? -1))

    socket.send(Uint8Array.of(1))
    socket.send(Uint8Array.of(2))
    transport.send(socket.clientId, Uint8Array.of(9))
    expect([atServer, atClient]).toEqual([[], []])
    expect(transport.pending()).toBe(3)
    expect((await transport.flush()).unwrap()).toBe(3)
    expect([atServer, atClient]).toEqual([[1, 2], [9]])
  })

  test("frames are copied at send time, like a socket write", async () => {
    const transport = await listening()
    const socket = transport.connect().unwrap()
    const got: number[][] = []
    socket.onMessage((data) => got.push([...data]))
    const buffer = Uint8Array.of(1, 2, 3)
    transport.send(socket.clientId, buffer)
    buffer.fill(0) // e.g. an encoder reusing its buffer
    await transport.flush()
    expect(got).toEqual([[1, 2, 3]])
  })

  test("async handlers' replies are delivered by the same flush", async () => {
    const transport = await listening()
    transport.onMessage(async (id, data) => {
      await Promise.resolve()
      transport.send(id, Uint8Array.of((data[0] ?? 0) + 1))
    })
    const socket = transport.connect().unwrap()
    const got: number[] = []
    socket.onMessage((data) => {
      got.push(data[0] ?? -1)
      if (got.length < 3) socket.send(Uint8Array.of((data[0] ?? 0) + 1))
    })
    socket.send(Uint8Array.of(0))
    await transport.flush()
    expect(got).toEqual([1, 3, 5])
  })

  test("counts bytes and frames per direction; broadcast counts per client", async () => {
    const transport = await listening()
    const a = transport.connect().unwrap()
    const b = transport.connect().unwrap()
    a.send(new Uint8Array(5))
    transport.broadcast([a.clientId, b.clientId], new Uint8Array(8))
    expect(transport.stats()).toEqual({
      bytesToClients: 16,
      framesToClients: 2,
      bytesFromClients: 5,
      framesFromClients: 1,
    })
    transport.resetStats()
    expect(transport.stats().bytesToClients).toBe(0)
  })

  test("server disconnect: frames first, then the close; later client frames dropped", async () => {
    const transport = await listening()
    const events: unknown[] = []
    transport.onMessage((_, data) => events.push(["server got", [...data]]))
    transport.onDisconnect((_, code, reason) =>
      events.push(["server close", code, reason]),
    )
    const socket = transport.connect().unwrap()
    socket.onMessage((data) => events.push(["client got", [...data]]))
    socket.onClose((code, reason) =>
      events.push(["client close", code, reason]),
    )

    socket.send(Uint8Array.of(1)) // in flight when the server kicks
    transport.send(socket.clientId, Uint8Array.of(2))
    expect(transport.disconnect(socket.clientId, 4000, "kicked").isOk()).toBe(
      true,
    )
    expect(transport.isClientConnected(socket.clientId)).toBe(false)
    expect(socket.readyState).toBe("closing")
    expect(socket.send(Uint8Array.of(3))).toBe(false)
    await transport.flush()
    expect(events).toEqual([
      ["client got", [2]],
      ["client close", 4000, "kicked"],
      ["server close", 4000, "kicked"],
    ])
    expect(socket.readyState).toBe("closed")
  })

  test("client close: its earlier frames still arrive first", async () => {
    const transport = await listening()
    const events: unknown[] = []
    transport.onMessage((_, data) => events.push(["msg", [...data]]))
    transport.onDisconnect((_, code, reason) =>
      events.push(["close", code, reason]),
    )
    const socket = transport.connect().unwrap()
    socket.send(Uint8Array.of(7))
    socket.close(1000, "bye")
    expect(transport.getClientCount()).toBe(0)
    await transport.flush()
    expect(events).toEqual([
      ["msg", [7]],
      ["close", 1000, "bye"],
    ])
  })

  test("close() sends 1001 to everyone; connect then fails", async () => {
    const transport = await listening()
    const codes: number[] = []
    for (let i = 0; i < 2; i++) {
      transport
        .connect()
        .unwrap()
        .onClose((code) => codes.push(code))
    }
    expect((await transport.close()).isOk()).toBe(true)
    await transport.flush()
    expect(codes).toEqual([1001, 1001])
    const refused = transport.connect()
    expect(refused.isErr() && refused.error).toMatchObject({
      code: "CONNECTION_FAILED",
    })
  })

  test("oversized client frames close the connection with 1009", async () => {
    const transport = await listening({ maxPayloadLength: 4 })
    const socket = transport.connect().unwrap()
    const closes: number[] = []
    socket.onClose((code) => closes.push(code))
    socket.send(new Uint8Array(5))
    await transport.flush()
    expect(closes).toEqual([1009])
    expect(transport.stats().bytesFromClients).toBe(0)
  })

  test("errors are results; server handler throws go to onError", async () => {
    const transport = new LoopbackTransport()
    const notListening = transport.connect()
    expect(notListening.isErr()).toBe(true)
    await transport.listen(0)
    expect((await transport.listen(0)).isErr()).toBe(true)
    const send = transport.send("ghost", Uint8Array.of(1))
    expect(send.isErr() && send.error).toMatchObject({
      code: "CLIENT_NOT_FOUND",
    })
    const broadcast = transport.broadcast(["ghost"], Uint8Array.of(1))
    expect(broadcast.isErr() && broadcast.error).toMatchObject({
      code: "CONNECTION_LOST",
      context: ["ghost"],
    })

    const errors: string[] = []
    transport.onError((error) => errors.push(error.message))
    transport.onMessage(() => {
      throw new Error("core bug")
    })
    transport.connect().unwrap().send(Uint8Array.of(1))
    await transport.flush()
    expect(errors).toEqual(["core bug"])
  })

  test("a throwing client listener fails the flush (a failed expect isn't swallowed)", async () => {
    const transport = await listening()
    const socket = transport.connect().unwrap()
    socket.onMessage(() => {
      throw new Error("expectation failed")
    })
    transport.send(socket.clientId, Uint8Array.of(1))
    await expect(transport.flush()).rejects.toThrow("expectation failed")
  })

  test("endless ping-pong is cut off", async () => {
    const transport = await listening({ maxFlushEvents: 50 })
    transport.onMessage((id, data) => transport.send(id, data))
    const socket = transport.connect().unwrap()
    socket.onMessage((data) => socket.send(data))
    socket.send(Uint8Array.of(1))
    const result = await transport.flush()
    expect(result.isErr() && result.error.code).toBe("INVALID_OPTIONS")
  })
})
