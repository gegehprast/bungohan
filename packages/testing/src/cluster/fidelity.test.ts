/**
 * A remote join must deliver the *same values* as a local one (spec
 * §6.4.1). Backplane messages are encoded with the server's `ISerializer`
 * (MessagePack), not JSON, so a `Uint8Array` stays binary, `NaN` and
 * `±Infinity` stay numbers, and a `Date` stays a `Date`. Under JSON they
 * became `{"0":1,…}`, `null`, `null` and an ISO string — and only for
 * rooms that happened to live on another process.
 */
import { beforeEach, describe, expect, test } from "bun:test"
import { type ProcessInfo, RoomProxy } from "@bungohan/core"
import { type ClusterHarness, createClusterHarness } from "../cluster"
import {
  EchoRoom,
  EchoState,
  expectTricky,
  received,
  resetReceived,
  resetTypedReceived,
  TypedEchoRoom,
  trickyPayload,
  typedContract,
  typedReceived,
} from "./fixtures"

const join = { state: EchoState } as const

async function cluster(): Promise<ClusterHarness> {
  return createClusterHarness({
    size: 2,
    rooms: {
      echo: [EchoRoom, { autoDispose: false }],
      typed: [TypedEchoRoom, { autoDispose: false }],
    },
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

beforeEach(() => {
  resetReceived()
  resetTypedReceived()
})

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

describe("typed options (spec §4.1.2)", () => {
  const typedJoin = { state: EchoState, contract: typedContract } as const
  const onP1 = (processes: ProcessInfo[]): ProcessInfo => {
    const remote = processes.find((p) => p.id === "p1")
    if (remote === undefined) throw new Error("p1 missing")
    return remote
  }

  test("a client's typed options reach a remote room as the same bytes", async () => {
    const c = await cluster()
    const create = { spin: -0, rounds: 1 }
    const here = (
      await c.run(mm(c, 0).createRoom(TypedEchoRoom, create))
    ).unwrap()
    const there = (
      await c.run(mm(c, 1).createRoom(TypedEchoRoom, create))
    ).unwrap()
    const client = await c.connect(0)
    const options = { name: "ann", aim: 1.234, spin: -0, team: -3 }
    ;(await client.joinById(here.id, options, typedJoin)).unwrap()
    ;(await client.joinById(there.id, options, typedJoin)).unwrap()

    const [local, remote] = typedReceived.join
    expect(local).toEqual({ name: "ann", aim: 1.23, spin: -0, team: -3 })
    expect(remote).toEqual(local)
    expect(Object.is((remote as { spin: number }).spin, -0)).toBe(true)
    await c.stop()
  })

  test("createRoom's typed options are converted identically on either process", async () => {
    const c = await cluster()
    const create = { spin: -0, rounds: 300 }
    ;(await c.run(mm(c, 0).createRoom(TypedEchoRoom, create))).unwrap()
    ;(await c.run(mm(c, 0).createRoom(TypedEchoRoom, create, onP1))).unwrap()

    const [local, remote] = typedReceived.create
    expect(local).toEqual({ spin: -0, rounds: 255 })
    expect(remote).toEqual(local)
    // A MessagePack hop alone would have turned −0 into 0 (PROTOCOL.md §4).
    expect(Object.is((remote as { spin: number }).spin, -0)).toBe(true)
    await c.stop()
  })

  test("a reservation made from another process holds the same converted join options", async () => {
    const c = await cluster()
    const there = (
      await c.run(mm(c, 1).createRoom(TypedEchoRoom, { spin: 0, rounds: 1 }))
    ).unwrap()
    const options = { name: "bo", aim: 0.125, spin: -0 }
    // Made where the room is, and made from p0, which finds p1's room.
    const owner = (
      await c.run(mm(c, 1).reserve(TypedEchoRoom, options))
    ).unwrap()
    const remote = (
      await c.run(mm(c, 0).reserve(TypedEchoRoom, options))
    ).unwrap()
    expect([owner.roomId, remote.roomId]).toEqual([there.id, there.id])
    for (const reservation of [owner, remote]) {
      const client = await c.connect(0)
      ;(await client.consumeReservation(reservation, typedJoin)).unwrap()
    }

    const [here, relayed] = typedReceived.join
    expect(here).toEqual({ name: "bo", aim: 0.13, spin: -0 })
    expect(relayed).toEqual(here)
    expect(Object.is((relayed as { spin: number }).spin, -0)).toBe(true)
    await c.stop()
  })

  test("typed options that don't decode are refused by the owning process", async () => {
    const c = await cluster()
    const there = (
      await c.run(mm(c, 1).createRoom(TypedEchoRoom, { spin: 0, rounds: 1 }))
    ).unwrap()
    const driver = c.node(0).driver()
    const joined = await c.run(
      driver.joinById(there.id, { name: "ann" }, { contractHash: null }),
    )
    expect(joined.isErr() && joined.error.code).toBe("INVALID_OPTIONS")
    expect(typedReceived.join).toEqual([])
    await c.stop()
  })
})
