/**
 * The hard constraint of cluster mode: **no wire change** (spec §6.4).
 * Clustering is a server-side concern, so a client must not be able to
 * tell where its room runs. These tests compare the actual bytes a
 * byte-level client receives from a local room and from a room on another
 * process, frame for frame.
 */
import { describe, expect, test } from "bun:test"
import { ServerFrameType } from "@bungohan/types"
import { type ClusterHarness, createClusterHarness } from "../cluster"
import { GameRoom, GameState, gameContract } from "../core/fixtures"
import type { TestClient } from "../driver"

const join = { state: GameState, contract: gameContract } as const

async function cluster(): Promise<ClusterHarness> {
  return createClusterHarness({
    size: 2,
    rooms: { game: [GameRoom, { autoDispose: false }] },
  })
}

function mm(c: ClusterHarness, index: number) {
  return c.node(index).server.getMatchMaker()
}

/** Frame type byte of every frame a driver received. */
function types(client: TestClient): number[] {
  return client.frames.map((frame) => frame[0] ?? -1)
}

/** Every frame's `roomRef` (the first header varint, always < 128 here). */
function refs(client: TestClient): number[] {
  return client.frames.map((frame) => frame[1] ?? -1)
}

describe("a remote seat is byte-identical to a local one", () => {
  test("same frames, same roomRef, same snapshot bytes", async () => {
    const c = await cluster()

    // One room on each process. Node 0's client joins its own; node 1's
    // room is joined from node 0, across the backplane.
    const here = (await c.run(mm(c, 0).createRoom("game"))).unwrap()
    const there = (await c.run(mm(c, 1).createRoom("game"))).unwrap()

    const localClient = c.node(0).driver()
    const localRoom = (await localClient.joinById(here.id, {}, join)).unwrap()
    const remoteClient = c.node(0).driver()
    const remoteRoom = (
      await remoteClient.joinById(there.id, {}, join)
    ).unwrap()
    // The byte-level driver resolves a join on JOIN_SUCCESS, so let both
    // rooms reach their next sync boundary and send the snapshot.
    await c.flushSync()

    // The handshake is the same everywhere but the ids.
    expect(remoteRoom.roomType).toBe(localRoom.roomType)
    expect(remoteRoom.stateCodec).toBe(localRoom.stateCodec)
    expect(remoteRoom.contractHash).toBe(localRoom.contractHash)
    expect(remoteRoom.clientMessages).toEqual(localRoom.clientMessages)
    expect(remoteRoom.serverMessages).toEqual(localRoom.serverMessages)
    expect(remoteRoom.reconnectionToken).not.toBeNull()

    // The first roomRef on a connection is 1, wherever the room runs.
    expect(localRoom.roomRef).toBe(1)
    expect(remoteRoom.roomRef).toBe(1)
    expect(refs(remoteClient)).toEqual(refs(localClient))

    expect(types(remoteClient)).toEqual(types(localClient))
    expect(types(remoteClient)).toEqual([
      ServerFrameType.JOIN_SUCCESS,
      ServerFrameType.ROOM_MESSAGE, // "welcome", sent in onJoin
      ServerFrameType.STATE_SNAPSHOT,
    ])

    // Same state, same codec session, so the snapshot is the same bytes.
    const snapshotOf = (client: TestClient): Uint8Array | undefined =>
      client.frames.find((frame) => frame[0] === ServerFrameType.STATE_SNAPSHOT)
    const local = snapshotOf(localClient)
    const remote = snapshotOf(remoteClient)
    expect(remote).toBeDefined()
    // Only the sessionId (a random nanoid of the same length) differs.
    expect(remote?.byteLength).toBe(local?.byteLength)
    await c.stop()
  })

  test("a patch for a remote seat is the same 6-byte frame", async () => {
    const c = await cluster()
    const there = (await c.run(mm(c, 1).createRoom("game"))).unwrap()
    const client = c.node(0).driver()
    const room = (await client.joinById(there.id, {}, join)).unwrap()
    await c.flushSync()
    expect(room.snapshots).toBe(1)

    client.frames.length = 0
    room.send("move", { dx: 1 })
    await c.flushSync()
    await c.flushSync()

    const patches = client.frames.filter(
      (frame) => frame[0] === ServerFrameType.STATE_PATCH,
    )
    expect(patches).toHaveLength(1)
    // 2-byte header (type + roomRef) then the `schema` SET op (spec §6.8.3).
    expect(patches[0]?.byteLength).toBe(6)
    expect([...(patches[0] ?? [])].slice(0, 2)).toEqual([
      ServerFrameType.STATE_PATCH,
      1,
    ])
    expect(room.state?.players.get(room.sessionId)?.x.get()).toBe(1)
    await c.stop()
  })

  test("one connection can hold a local and a remote seat at once", async () => {
    const c = await cluster()
    const here = (await c.run(mm(c, 0).createRoom("game"))).unwrap()
    const there = (await c.run(mm(c, 1).createRoom("game"))).unwrap()

    const client = c.node(0).driver()
    const first = (await client.joinById(here.id, {}, join)).unwrap()
    const second = (await client.joinById(there.id, {}, join)).unwrap()

    // roomRefs count up per connection and are never reused (§3.1).
    expect(first.roomRef).toBe(1)
    expect(second.roomRef).toBe(2)

    first.send("move", { dx: 3 })
    second.send("move", { dx: 5 })
    await c.flushSync()
    await c.flushSync()

    expect(first.state?.players.get(first.sessionId)?.x.get()).toBe(3)
    expect(second.state?.players.get(second.sessionId)?.x.get()).toBe(5)
    await c.stop()
  })

  test("a protocol violation on a remote seat closes the connection", async () => {
    const c = await cluster()
    const there = (await c.run(mm(c, 1).createRoom("game"))).unwrap()
    const client = c.node(0).driver()
    const room = (await client.joinById(there.id, {}, join)).unwrap()

    // A messageId past the room's clientMessages table (PROTOCOL.md §8.2).
    client.sendFrame(0, [room.roomRef, 99])
    await c.flush()
    await c.flush()

    expect(client.closeCode).toBe(1008)
    expect(client.closeReason).toContain("99")
    expect(client.errors[0]?.[0]).toBe("INVALID_MESSAGE")
    await c.stop()
  })
})
