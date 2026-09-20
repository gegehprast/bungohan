/**
 * A remote join must deliver the *same values* as a local one (spec
 * §6.4.1). Backplane messages are encoded with the server's `ISerializer`
 * (MessagePack), not JSON, so a `Uint8Array` stays binary, `NaN` and
 * `±Infinity` stay numbers, and a `Date` stays a `Date`. Under JSON they
 * became `{"0":1,…}`, `null`, `null` and an ISO string — and only for
 * rooms that happened to live on another process.
 */
import { beforeEach, describe, expect, test } from "bun:test"
import { RoomProxy } from "@bungohan/core"
import { type ClusterHarness, createClusterHarness } from "../cluster"
import {
  EchoRoom,
  EchoState,
  expectTricky,
  received,
  resetReceived,
  trickyPayload,
} from "./fixtures"

const join = { state: EchoState } as const

async function cluster(): Promise<ClusterHarness> {
  return createClusterHarness({
    size: 2,
    rooms: { echo: [EchoRoom, { autoDispose: false }] },
  })
}

function mm(c: ClusterHarness, index: number) {
  return c.node(index).server.getMatchMaker()
}

/** The `EchoRoom` a node owns. */
function owned(c: ClusterHarness, index: number, id: string): EchoRoom {
  const room = mm(c, index).getRoom(id)
  if (!(room instanceof EchoRoom)) throw new Error("not a local EchoRoom")
  return room
}

beforeEach(resetReceived)

describe("join options", () => {
  test("a local and a remote join deliver identical options", async () => {
    const c = await cluster()
    const here = (await c.run(mm(c, 0).createRoom("echo"))).unwrap()
    const there = (await c.run(mm(c, 1).createRoom("echo"))).unwrap()

    const client = await c.connect(0)
    ;(await client.joinById(here.id, trickyPayload(), join)).unwrap()
    ;(await client.joinById(there.id, trickyPayload(), join)).unwrap()

    // One join was served here, the other by the process that owns the
    // room; both pushed onto the same array in this test process.
    expect(received.join).toHaveLength(2)
    const [local, remote] = received.join
    expectTricky(local, expect)
    expectTricky(remote, expect)
    expect(remote).toEqual(local)
    await c.stop()
  })

  test("options a room is created with survive the trip", async () => {
    const c = await cluster()
    ;(await c.run(mm(c, 0).createRoom("echo", trickyPayload()))).unwrap()
    ;(
      await c.run(
        mm(c, 0).createRoom("echo", trickyPayload(), (processes) => {
          const remote = processes.find((p) => p.id === "p1")
          if (remote === undefined) throw new Error("p1 missing")
          return remote
        }),
      )
    ).unwrap()

    expect(received.create).toHaveLength(2)
    for (const options of received.create) expectTricky(options, expect)
    await c.stop()
  })

  test("a room message carries the same values wherever the room is", async () => {
    const c = await cluster()
    const here = (await c.run(mm(c, 0).createRoom("echo"))).unwrap()
    const there = (await c.run(mm(c, 1).createRoom("echo"))).unwrap()
    const client = await c.connect(0)
    const local = (await client.joinById(here.id, {}, join)).unwrap()
    const remote = (await client.joinById(there.id, {}, join)).unwrap()

    local.sendRaw("say", trickyPayload())
    remote.sendRaw("say", trickyPayload())
    await c.flush()

    expect(received.message).toHaveLength(2)
    for (const payload of received.message) expectTricky(payload, expect)
    expect(received.message[1]).toEqual(received.message[0])
    await c.stop()
  })
})

describe("proxied broadcasts", () => {
  test("a payload broadcast through a RoomProxy arrives intact", async () => {
    const c = await cluster()
    const there = (await c.run(mm(c, 1).createRoom("echo"))).unwrap()
    const client = await c.connect(0)
    const room = (await client.joinById(there.id, {}, join)).unwrap()
    const heard: unknown[] = []
    room.onMessageRaw((_type, payload) => heard.push(payload))
    await c.flush()

    // Baseline: the owning process broadcasts it itself.
    owned(c, 1, there.id).blast(trickyPayload())
    await c.flush()

    // The same payload, sent from the other process through a proxy: it
    // crosses the backplane before the room ever encodes it.
    const proxy = (await c.run(mm(c, 0).joinById(there.id))).unwrap()
    expect(proxy).toBeInstanceOf(RoomProxy)
    ;(proxy as RoomProxy).broadcastRawMessage("payload", trickyPayload())
    await c.flush()

    expect(heard).toHaveLength(2)
    const [direct, proxied] = heard
    expectTricky(direct, expect)
    expectTricky(proxied, expect)
    expect(proxied).toEqual(direct)
    await c.stop()
  })
})

describe("relayed frames", () => {
  test("frame bytes cross the backplane as bytes, not as text", async () => {
    // A snapshot's codec bytes are arbitrary binary; a JSON hop would have
    // needed base64 (a third larger) or would have corrupted them.
    const c = await cluster()
    const there = (await c.run(mm(c, 1).createRoom("echo"))).unwrap()
    const driver = c.node(0).driver()
    const room = (await driver.joinById(there.id, {}, join)).unwrap()
    await c.flushSync()

    expect(room.snapshots).toBe(1)
    expect(room.state?.turn.get()).toBe(0)
    await c.stop()
  })
})
