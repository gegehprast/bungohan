/**
 * client-js against a scripted server: the test plays the server's side of
 * §6.7 frame by frame, so wire details (§6.7.7 trailing elements, unknown
 * codes, PING/PONG) are checked without core. End-to-end tests against a
 * real server live in `@bungohan/testing` (src/client-js/).
 */
import { beforeEach, describe, expect, test } from "bun:test"
import { ok, type Result } from "@bungohan/result"
import {
  decodeFrame,
  encodeFrame,
  MessagePackSerializer,
  MessagePackStateCodec,
} from "@bungohan/serializer"
import { createNumber, Schema } from "@bungohan/state"
import {
  CLIENT_FRAME_HEADERS,
  ClientFrameType,
  type Clock,
  contractHash,
  defineContract,
  defineMessage,
  f,
  JoinMode,
  LeaveCode,
  PROTOCOL_VERSION,
  ServerFrameType,
  type TimerId,
  type WireOp,
} from "@bungohan/types"
import { BungohanClient } from "./client"
import type { ClientError } from "./errors"
import type {
  ClientSocket,
  ClientSocketHandlers,
  IClientTransport,
} from "./transport"

class Counter extends Schema {
  public static override schemaName = "ClientTest.Counter"
  public count = createNumber()
}

const Ping = defineMessage("ping", { n: f.uint8 })
const Pong = defineMessage("pong", { n: f.uint8, at: f.fixed(1) })
const contract = defineContract({
  client: { ping: Ping },
  server: { pong: Pong },
})

const serializer = new MessagePackSerializer()
const encode = (value: unknown) => serializer.encode(value).unwrap()

/** A clock that only moves when told (a local stand-in for ManualClock). */
class StepClock implements Clock {
  private _now = 0
  private _next = 1
  private readonly _timers = new Map<
    TimerId,
    { due: number; every: number | undefined; fn: () => void }
  >()

  public now(): number {
    return this._now
  }
  public setTimeout(fn: () => void, ms: number): TimerId {
    const id = this._next++
    this._timers.set(id, {
      due: this._now + Math.max(0, ms),
      every: undefined,
      fn,
    })
    return id
  }
  public clearTimeout(id: TimerId): void {
    this._timers.delete(id)
  }
  public setInterval(fn: () => void, ms: number): TimerId {
    const id = this._next++
    const every = Math.max(1, ms)
    this._timers.set(id, { due: this._now + every, every, fn })
    return id
  }
  public clearInterval(id: TimerId): void {
    this._timers.delete(id)
  }
  public async advance(ms: number): Promise<void> {
    const target = this._now + ms
    for (;;) {
      let next:
        | [TimerId, { due: number; every: number | undefined; fn: () => void }]
        | undefined
      for (const entry of this._timers) {
        if (
          entry[1].due <= target &&
          (next === undefined || entry[1].due < next[1].due)
        ) {
          next = entry
        }
      }
      if (next === undefined) break
      const [id, timer] = next
      this._now = timer.due
      if (timer.every === undefined) this._timers.delete(id)
      else timer.due += timer.every
      timer.fn()
      await Promise.resolve()
    }
    this._now = target
  }
}

/** The fake server end of one connection. */
class Peer {
  public readonly sent: {
    type: number
    header: readonly number[]
    body: unknown
  }[] = []
  public closed: [number, string] | undefined
  public constructor(
    public readonly url: string,
    public readonly protocols: readonly string[],
    private readonly _handlers: ClientSocketHandlers,
  ) {}

  public open(protocol = PROTOCOL_VERSION): void {
    this._handlers.onOpen(protocol)
  }
  public frame(type: number, header: number[], body?: unknown): void {
    const bytes = body === undefined ? undefined : encode(body)
    this._handlers.onMessage(encodeFrame(type, header, bytes).unwrap())
  }
  public bytes(data: Uint8Array): void {
    this._handlers.onMessage(data)
  }
  public close(code: number, reason = ""): void {
    this._handlers.onClose(code, reason)
  }
  /** The last frame the client sent, decoded. */
  public last(): { type: number; header: readonly number[]; body: unknown } {
    const frame = this.sent.at(-1)
    if (frame === undefined) throw new Error("nothing sent")
    return frame
  }
  public receive(data: Uint8Array): void {
    const frame = decodeFrame(data, CLIENT_FRAME_HEADERS).unwrap()
    const body =
      frame.body.byteLength === 0
        ? undefined
        : serializer.decode(frame.body).unwrap()
    this.sent.push({ type: frame.type, header: frame.header, body })
  }
}

class FakeTransport implements IClientTransport {
  public readonly peers: Peer[] = []
  public open(
    url: string,
    protocols: readonly string[],
    handlers: ClientSocketHandlers,
  ): Result<ClientSocket, ClientError> {
    const peer = new Peer(url, protocols, handlers)
    this.peers.push(peer)
    return ok({
      send: (data) => {
        peer.receive(data)
        return true
      },
      close: (code = 1000, reason = "") => {
        peer.closed = [code, reason]
      },
    })
  }
  public getName(): string {
    return "fake"
  }
  public get peer(): Peer {
    const peer = this.peers.at(-1)
    if (peer === undefined) throw new Error("no connection")
    return peer
  }
}

let transport: FakeTransport
let clock: StepClock
let warnings: string[]

function makeClient(
  extra: Partial<ConstructorParameters<typeof BungohanClient>[0]> = {},
) {
  return new BungohanClient({
    url: "ws://game.test/play",
    transport,
    clock,
    autoConnect: false,
    pingInterval: 0,
    logger: {
      warn: (message) => warnings.push(message),
      error: (message) => warnings.push(`error: ${message}`),
    },
    ...extra,
  })
}

async function connected(client: BungohanClient): Promise<Peer> {
  const connecting = client.connect()
  transport.peer.open()
  expect((await connecting).isOk()).toBe(true)
  return transport.peer
}

const snapshotOps: WireOp[] = [
  [4, 0, "ClientTest.Counter", ["count"], ["float64"]],
  [0, 0, 0, 5],
]

beforeEach(() => {
  transport = new FakeTransport()
  clock = new StepClock()
  warnings = []
})

/** STATE_SNAPSHOT bodies are codec bytes, not ser; build them directly. */
function snapshot(peer: Peer, ref: number, ops: WireOp[]): void {
  const session = new MessagePackStateCodec().createSession()
  const body = session.encodeOps(ops).unwrap()
  peer.bytes(encodeFrame(ServerFrameType.STATE_SNAPSHOT, [ref], body).unwrap())
}

async function joined(client: BungohanClient, extra: unknown[] = []) {
  const peer = await connected(client)
  const joining = client.joinOrCreate(
    "counter",
    { level: 2 },
    {
      state: Counter,
      contract,
    },
  )
  await Promise.resolve()
  const join = peer.last()
  peer.frame(
    ServerFrameType.JOIN_SUCCESS,
    [join.header[0] ?? 0, 1],
    [
      "room-1",
      "counter",
      "session-1",
      "token-1",
      contractHash(contract),
      "messagepack",
      ["ping"],
      ["pong"],
      ...extra,
    ],
  )
  snapshot(peer, 1, snapshotOps)
  const room = (await joining).unwrap()
  return { peer, room }
}

describe("connection", () => {
  test("offers bungohan.v1 and sends the token in the query", async () => {
    const client = makeClient({ token: "s3cret/+" })
    await connected(client)
    expect(transport.peer.protocols).toEqual([PROTOCOL_VERSION])
    expect(transport.peer.url).toBe("ws://game.test/play?token=s3cret%2F%2B")
    expect(client.connectionState).toBe("connected")
  })

  test("a first connect that never opens fails, without retrying", async () => {
    const client = makeClient()
    const connecting = client.connect()
    transport.peer.close(1006, "refused")
    const result = await connecting
    expect(result.isErr() && result.error.code).toBe("CONNECTION_FAILED")
    expect(client.connectionState).toBe("disconnected")
    await clock.advance(60_000)
    expect(transport.peers).toHaveLength(1)
  })

  test("a rejected protocol version (1002) is terminal, not retried", async () => {
    const client = makeClient()
    const errors: string[] = []
    client.onError((error) => errors.push(error.code))
    const peer = await connected(client)
    peer.close(1002, "unsupported protocol bungohan.v1; expected bungohan.v2")
    expect(client.connectionState).toBe("disconnected")
    expect(errors).toEqual(["PROTOCOL_ERROR"])
    await clock.advance(60_000)
    expect(transport.peers).toHaveLength(1)
  })

  test("PING carries the last round trip; PONG measures it", async () => {
    const client = makeClient({ pingInterval: 1000 })
    const peer = await connected(client)
    await clock.advance(1000)
    const first = peer.last()
    expect(first.type).toBe(ClientFrameType.PING)
    expect(first.header[1]).toBe(0) // no measurement yet
    await clock.advance(40)
    peer.frame(ServerFrameType.PONG, [first.header[0] ?? 0])
    expect(client.latency).toBe(40)
    await clock.advance(960)
    const second = peer.last()
    expect(second.header[0]).toBe((first.header[0] ?? 0) + 1)
    expect(second.header[1]).toBe(40)
  })
})

describe("joins", () => {
  test("sends [mode, target, options, contractHash]", async () => {
    const client = makeClient()
    const peer = await connected(client)
    void client.joinOrCreate(
      "counter",
      { level: 2 },
      { state: Counter, contract },
    )
    await Promise.resolve()
    expect(peer.last().body).toEqual([
      JoinMode.JOIN_OR_CREATE,
      "counter",
      { level: 2 },
      contractHash(contract),
    ])
    void client.create("counter")
    await Promise.resolve()
    expect(peer.last().body).toEqual([JoinMode.CREATE, "counter", null, null])
  })

  test("a handshake with extra trailing elements is accepted", async () => {
    const client = makeClient()
    const { room } = await joined(client, ["v2-field", { more: true }])
    expect(room.id).toBe("room-1")
    expect(room.reconnectionToken).toBe("token-1")
    expect(room.state.count.get()).toBe(5)
  })

  test("JOIN_ERROR: extra elements ignored; unknown codes become JOIN_FAILED", async () => {
    const client = makeClient()
    const peer = await connected(client)
    const a = client.joinOrCreate("counter")
    await Promise.resolve()
    peer.frame(
      ServerFrameType.JOIN_ERROR,
      [peer.last().header[0] ?? 0],
      ["ROOM_FULL", "full", "trailing"],
    )
    const full = await a
    expect(full.isErr() && full.error.code).toBe("ROOM_FULL")

    const b = client.joinOrCreate("counter")
    await Promise.resolve()
    peer.frame(
      ServerFrameType.JOIN_ERROR,
      [peer.last().header[0] ?? 0],
      ["FROM_THE_FUTURE", "?"],
    )
    const future = await b
    expect(future.isErr() && future.error.code).toBe("JOIN_FAILED")
    expect(future.isErr() && future.error.context).toEqual({
      code: "FROM_THE_FUTURE",
    })
  })

  test("CODEC_MISMATCH: leaves the seat and fails locally", async () => {
    const client = makeClient()
    const peer = await connected(client)
    const joining = client.joinOrCreate(
      "counter",
      {},
      { state: Counter, contract },
    )
    await Promise.resolve()
    peer.frame(
      ServerFrameType.JOIN_SUCCESS,
      [peer.last().header[0] ?? 0, 7],
      [
        "room-1",
        "counter",
        "session-1",
        null,
        contractHash(contract),
        "a-codec-this-client-lacks",
        [],
        [],
      ],
    )
    const result = await joining
    expect(result.isErr() && result.error.code).toBe("CODEC_MISMATCH")
    expect(peer.last()).toEqual({
      type: ClientFrameType.LEAVE,
      header: [7],
      body: undefined,
    })
  })

  test("a join the server never answers times out", async () => {
    const client = makeClient({ joinTimeout: 500 })
    await connected(client)
    const joining = client.joinOrCreate("counter")
    await Promise.resolve()
    await clock.advance(499)
    expect(transport.peer.closed).toBeUndefined()
    await clock.advance(1)
    const result = await joining
    expect(result.isErr() && result.error.code).toBe("TIMEOUT")
  })

  test("a connection lost mid-join fails the join", async () => {
    const client = makeClient()
    const peer = await connected(client)
    const joining = client.joinOrCreate("counter")
    await Promise.resolve()
    peer.close(1006)
    const result = await joining
    expect(result.isErr() && result.error.code).toBe("CONNECTION_LOST")
  })

  test("LEAVE before the snapshot fails the join with LEFT", async () => {
    const client = makeClient()
    const peer = await connected(client)
    const joining = client.joinOrCreate("counter", {}, { state: Counter })
    await Promise.resolve()
    acceptJoinWithoutSnapshot(peer)
    peer.frame(ServerFrameType.LEAVE, [1, LeaveCode.KICKED])
    const result = await joining
    expect(result.isErr() && result.error.code).toBe("LEFT")
  })
})

function acceptJoinWithoutSnapshot(peer: Peer): void {
  peer.frame(
    ServerFrameType.JOIN_SUCCESS,
    [peer.last().header[0] ?? 0, 1],
    [
      "room-1",
      "counter",
      "session-1",
      "token-1",
      contractHash(contract),
      "messagepack",
      ["ping"],
      ["pong"],
    ],
  )
}

describe("rooms", () => {
  test("typed send packs positionally under the handshake's id", async () => {
    const client = makeClient()
    const { peer, room } = await joined(client)
    expect(room.send("ping", { n: 7 }).isOk()).toBe(true)
    expect(peer.last()).toEqual({
      type: ClientFrameType.ROOM_MESSAGE,
      header: [1, 0],
      body: [7],
    })
  })

  test("typed onMessage decodes by name; unmapped ids are dropped", async () => {
    const client = makeClient()
    const { peer, room } = await joined(client)
    const got: { n: number; at: number }[] = []
    room.onMessage("pong", (message) => got.push(message))
    await clock.advance(0) // releases frames held during the join
    peer.frame(ServerFrameType.ROOM_MESSAGE, [1, 0], [3, 125])
    peer.frame(ServerFrameType.ROOM_MESSAGE, [1, 5], [])
    expect(got).toEqual([{ n: 3, at: 12.5 }])
    expect(warnings).toContain("dropped message: unknown message id 5")
  })

  test("raw bodies: extra trailing elements are ignored", async () => {
    const client = makeClient()
    const { peer, room } = await joined(client)
    await clock.advance(0)
    const raw: unknown[] = []
    room.onMessageRaw((type, message) => raw.push([type, message]))
    peer.frame(ServerFrameType.ROOM_MESSAGE_RAW, [1], ["hi", { a: 1 }, "v2"])
    expect(raw).toEqual([["hi", { a: 1 }]])
  })

  test("unknown frame types and frames for unknown rooms are dropped", async () => {
    const client = makeClient()
    const { peer, room } = await joined(client)
    await clock.advance(0)
    peer.bytes(Uint8Array.of(77, 1, 2))
    peer.frame(ServerFrameType.CLIENT_JOINED, [42], "someone")
    expect(warnings).toEqual(["dropped frame: unknown frame type 77"])
    expect(room.status).toBe("joined")
    expect(client.connectionState).toBe("connected")
  })

  test("every snapshot resets the replica", async () => {
    const client = makeClient()
    const { peer, room } = await joined(client)
    await clock.advance(0)
    const first = room.state
    snapshot(peer, 1, [
      [4, 0, "ClientTest.Counter", ["count"], ["float64"]],
      [0, 0, 0, 9],
    ])
    expect(room.state).not.toBe(first)
    expect(room.state.count.get()).toBe(9)
    expect(first.count.get()).toBe(5)
  })

  test("a bad patch is a desync: re-sync through reconnection", async () => {
    const client = makeClient()
    const { peer, room } = await joined(client)
    await clock.advance(0)
    const errors: string[] = []
    room.onError((code) => errors.push(code))
    const bad = encodeFrame(
      ServerFrameType.STATE_PATCH,
      [1],
      encode([[0, 99, 0, 1]]),
    ).unwrap()
    peer.bytes(bad)
    expect(errors).toEqual(["DESYNC"])
    expect(peer.closed?.[0]).toBe(4000)
    expect(client.connectionState).toBe("reconnecting")
    expect(room.status).toBe("reconnecting")

    await clock.advance(1000)
    const next = transport.peer
    expect(next).not.toBe(peer)
    next.open()
    expect(next.last().body).toEqual([
      JoinMode.RECONNECT,
      "token-1",
      null,
      contractHash(contract),
    ])
  })
})

describe("leaveOnPageExit", () => {
  /** Joins a second room (roomRef 2) on the same connection. */
  async function joinSecond(client: BungohanClient, peer: Peer) {
    const joining = client.join("counter", undefined, { state: Counter })
    await Promise.resolve()
    peer.frame(
      ServerFrameType.JOIN_SUCCESS,
      [peer.last().header[0] ?? 0, 2],
      ["room-2", "counter", "session-2", "token-2", "", "messagepack", [], []],
    )
    snapshot(peer, 2, snapshotOps)
    return (await joining).unwrap()
  }

  /** The LEAVEs sent so far, by roomRef. */
  const leaves = (peer: Peer) =>
    peer.sent
      .filter((frame) => frame.type === ClientFrameType.LEAVE)
      .map((frame) => frame.header[0])

  test("beforeunload leaves every room and closes, synchronously", async () => {
    const client = makeClient()
    const { peer, room } = await joined(client)
    const second = await joinSecond(client, peer)
    const page = new EventTarget()
    client.leaveOnPageExit(page)

    const exit = new Event("beforeunload", { cancelable: true })
    page.dispatchEvent(exit)
    // No await between the event and these: a page being torn down may
    // never run a promise continuation.
    expect(leaves(peer)).toEqual([1, 2])
    expect(peer.closed?.[0]).toBe(1000)
    expect(room.status).toBe("left")
    expect(second.status).toBe("left")
    expect(client.connectionState).toBe("disconnected")
    // A cancelled beforeunload is what makes the browser ask "leave page?".
    expect(exit.defaultPrevented).toBe(false)
  })

  test("the pagehide that follows beforeunload sends nothing more", async () => {
    const client = makeClient()
    const { peer } = await joined(client)
    const page = new EventTarget()
    client.leaveOnPageExit(page)
    page.dispatchEvent(new Event("beforeunload"))
    const sent = peer.sent.length
    const closed = peer.closed
    page.dispatchEvent(new Event("pagehide"))
    expect(peer.sent).toHaveLength(sent)
    expect(peer.closed).toBe(closed)
    expect(leaves(peer)).toEqual([1])
  })

  test("pagehide alone leaves too (no beforeunload, e.g. mobile)", async () => {
    const client = makeClient()
    const { peer, room } = await joined(client)
    const page = new EventTarget()
    client.leaveOnPageExit(page)
    page.dispatchEvent(new Event("pagehide"))
    expect(leaves(peer)).toEqual([1])
    expect(peer.closed?.[0]).toBe(1000)
    expect(room.status).toBe("left")
  })

  test("the returned function removes both listeners", async () => {
    const client = makeClient()
    const { peer, room } = await joined(client)
    const added: string[] = []
    const removed: string[] = []
    const page = new EventTarget()
    const spy = {
      addEventListener: (
        ...args: Parameters<EventTarget["addEventListener"]>
      ) => {
        added.push(args[0])
        page.addEventListener(...args)
      },
      removeEventListener: (
        ...args: Parameters<EventTarget["removeEventListener"]>
      ) => {
        removed.push(args[0])
        page.removeEventListener(...args)
      },
    }
    const stop = client.leaveOnPageExit(spy)
    expect(added.sort()).toEqual(["beforeunload", "pagehide"])
    stop()
    expect(removed.sort()).toEqual(["beforeunload", "pagehide"])
    page.dispatchEvent(new Event("beforeunload"))
    page.dispatchEvent(new Event("pagehide"))
    expect(leaves(peer)).toEqual([])
    expect(peer.closed).toBeUndefined()
    expect(room.status).toBe("joined")
  })

  test("without a window it is a no-op that returns a no-op", async () => {
    expect(typeof window).toBe("undefined") // Bun, like Node and workers
    const client = makeClient()
    const { peer, room } = await joined(client)
    const stop = client.leaveOnPageExit()
    expect(stop).toBeFunction()
    stop()
    expect(peer.sent.at(-1)?.type).not.toBe(ClientFrameType.LEAVE)
    expect(room.status).toBe("joined")
  })
})
