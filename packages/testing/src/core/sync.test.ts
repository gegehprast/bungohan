/**
 * State sync end to end (spec §5.6, §5.7.10, §6.7): per-client filtering,
 * encode-once frames, zero-byte idle rooms and reconnection snapshots.
 */
import { describe, expect, test } from "bun:test"
import {
  type IStateCodec,
  type IStateCodecSession,
  SchemaCodec,
} from "@bungohan/serializer"
import { type MessageDef, ServerFrameType } from "@bungohan/types"
import { calls, GameState, gameContract, Player } from "./fixtures"
import { serverRoom, setup } from "./helpers"

/** Counts `encodeOps` calls, to prove frames are encoded once. */
class CountingCodec implements IStateCodec {
  public encodes = 0
  private readonly _inner = new SchemaCodec()

  public getName(): string {
    return this._inner.getName()
  }

  public createSession(): IStateCodecSession {
    const inner = this._inner.createSession()
    return {
      encodeOps: (ops) => {
        this.encodes++
        return inner.encodeOps(ops)
      },
      decodeOps: (data) => inner.decodeOps(data),
      getTable: () => inner.getTable(),
    }
  }

  public encodeMessage(def: MessageDef, payload: unknown) {
    return this._inner.encodeMessage(def, payload)
  }

  public decodeMessage<M extends MessageDef>(def: M, data: Uint8Array) {
    return this._inner.decodeMessage(def, data)
  }
}

describe("filtering", () => {
  test("each client sees only its own secret", async () => {
    const { h, join } = await setup()
    const a = await join()
    const b = await join()
    await h.tick(50)

    const mine = (view: typeof a, of: string) =>
      view.state?.players.get(of)?.secret.get()
    expect(mine(a, a.sessionId)).toBe(`secret-of-${a.sessionId}`)
    expect(mine(a, b.sessionId)).toBe("")
    expect(mine(b, b.sessionId)).toBe(`secret-of-${b.sessionId}`)
    expect(mine(b, a.sessionId)).toBe("")
    expect(a.stateErrors).toEqual([])
    await h.stop()
  })

  test("a filtered change goes only to the client that can see it", async () => {
    const { h, join } = await setup()
    const ac = h.connect()
    const bc = h.connect()
    const a = await join(ac)
    const b = await join(bc)
    await h.tick(50)
    const bFrames = bc.frames.length

    serverRoom(h, a).game.players.get(a.sessionId)?.secret.set("changed")
    await h.tick(50)
    expect(a.state?.players.get(a.sessionId)?.secret.get()).toBe("changed")
    expect(bc.frames.length).toBe(bFrames)
    expect(b.patches).toBe(0)
    await h.stop()
  })

  test("clients with the same view share one encoded frame", async () => {
    const codec = new CountingCodec()
    const { h, join } = await setup({}, { stateCodec: codec })
    const clients = [h.connect(), h.connect(), h.connect()]
    for (const client of clients) await join(client)
    await h.tick(50) // three snapshots, one encode each (per-client filters)

    codec.encodes = 0
    h.resetStats()
    serverRoom(h, { roomId: (await join()).roomId }).game.turn.set(7)
    await h.tick(50)
    // The joiner's snapshot is its own encode; the shared patch is one more.
    expect(codec.encodes).toBe(2)
    const patches = clients.map((c) => c.frames.at(-1))
    expect(patches[0]?.[0]).toBe(ServerFrameType.STATE_PATCH)
    expect(patches[1]).toEqual(patches[0])
    expect(patches[2]).toEqual(patches[0])
    await h.stop()
  })
})

describe("bandwidth", () => {
  test("an idle room costs 0 bytes", async () => {
    const { h, join } = await setup()
    await join()
    await join()
    await h.tick(50) // snapshots out
    h.resetStats()
    await h.tick(10_000) // 200 sync ticks, 600 simulation steps
    expect(h.bytesSent()).toBe(0)
    expect(h.bytesReceived()).toBe(0)
    await h.stop()
  })

  test("one position change is one 6-byte frame", async () => {
    const { h, join } = await setup()
    const client = h.connect()
    const room = await join(client)
    await h.tick(50)
    room.send("move", { dx: 1.5 })
    await h.flush()
    h.resetStats()
    const before = client.frames.length
    await h.tick(50)
    // [STATE_PATCH, roomRef 1] + schema op SET(target 2, field 1, zigzag
    // 150): 01 02 ac 02 (PROTOCOL.md §13.1.3). MessagePack took 9 bytes.
    expect(h.bytesSent()).toBe(6)
    expect([...(client.frames[before] ?? [])]).toEqual([
      0x03, 0x01, 0x01, 0x02, 0xac, 0x02,
    ])
    expect(room.state?.players.get(room.sessionId)?.x.get()).toBe(1.5)
    await h.stop()
  })

  test("patches never reach a client before its snapshot", async () => {
    const { h, join } = await setup()
    const a = await join()
    await h.tick(50)
    const b = await join() // not yet snapshotted
    serverRoom(h, a).game.turn.set(1)
    await h.tick(50) // patch to a, then b's snapshot (already containing turn 1)
    expect(a.patches).toBeGreaterThan(0)
    expect(b.patches).toBe(0)
    expect(b.snapshots).toBe(1)
    expect(b.state?.turn.get()).toBe(1)
    await h.stop()
  })

  test("a room without state still completes joins with an empty snapshot", async () => {
    const { Room } = await import("@bungohan/core")
    class Lobby extends Room {}
    const { h } = await setup()
    h.define("lobby", Lobby)
    const view = (await h.connect().joinOrCreate("lobby")).unwrap()
    await h.tick(50)
    expect(view.snapshots).toBe(1)
    await h.stop()
  })

  test("a replaced state is re-sent to everyone as a fresh snapshot", async () => {
    const { h, join } = await setup()
    const room = await join()
    await h.tick(50)
    const server = serverRoom(h, room)
    const next = new GameState()
    next.turn.set(42)
    const player = new Player()
    player.owner.set(room.sessionId)
    player.secret.set("kept")
    next.players.set(room.sessionId, player)
    ;(server as unknown as { state: GameState }).state = next
    await h.tick(50)
    expect(room.snapshots).toBe(2)
    expect(room.state?.turn.get()).toBe(42)
    expect(room.state?.players.get(room.sessionId)?.secret.get()).toBe("kept")
    expect(room.stateErrors).toEqual([])
    await h.stop()
  })
})

describe("reconnection", () => {
  const opts = { state: GameState, contract: gameContract }

  test("a dropped client reconnects to the same seat and gets a full snapshot", async () => {
    const { h, join } = await setup()
    const ac = h.connect()
    const a = await join(ac)
    const b = await join()
    await h.tick(50)
    const token = a.reconnectionToken
    if (token === null) throw new Error("no token")

    await ac.close(4999) // not consented
    const server = serverRoom(h, a)
    expect(server.getClient(a.sessionId)?.status).toBe("reconnecting")
    expect(b.left).toEqual([]) // the seat is held, nobody left
    // Held seats are left out of sync; the room keeps running for b.
    serverRoom(h, a).game.turn.set(3)
    await h.tick(50)
    expect(b.state?.turn.get()).toBe(3)

    const again = (await h.connect().reconnect(token, opts)).unwrap()
    expect(again.sessionId).toBe(a.sessionId)
    expect(again.roomRef).toBe(1)
    expect(again.reconnectionToken).not.toBe(token)
    expect(again.snapshots).toBe(0)
    await h.tick(50)
    expect(again.snapshots).toBe(1)
    expect(again.state?.turn.get()).toBe(3)
    expect(again.state?.players.get(a.sessionId)?.secret.get()).toBe(
      `secret-of-${a.sessionId}`,
    )
    // No second onJoin, no CLIENT_JOINED for a seat that never left.
    expect(calls.filter((c) => c === `onJoin ${a.sessionId}`)).toHaveLength(1)
    expect(b.joined).toEqual([])

    // The old token is spent.
    const stale = await h.connect().reconnect(token)
    expect(stale.isErr() && stale.error.code).toBe("INVALID_TOKEN")
    await h.stop()
  })

  test("the room pauses while its only client is away, and resumes", async () => {
    const { h, join } = await setup()
    const ac = h.connect()
    const a = await join(ac)
    await h.tick(50)
    const server = serverRoom(h, a)

    await ac.close(4999)
    expect(server.isPaused).toBe(true)
    expect(calls.at(-1)).toBe("onPause")
    const pending = h.clock.pendingTimers()
    // Paused: only the reconnection timeout is scheduled, no loops.
    expect(pending).toBe(1)

    const again = (
      await h.connect().reconnect(a.reconnectionToken ?? "", opts)
    ).unwrap()
    expect(server.isPaused).toBe(false)
    // Resumed before the seat is handed back (spec §6.7.5).
    expect(calls.slice(-2)).toEqual(["onResume", `onReconnect ${a.sessionId}`])
    await h.tick(50)
    expect(again.snapshots).toBe(1)
    await h.stop()
  })

  test("a new client joining a paused room resumes it and gets its snapshot", async () => {
    const { h, join } = await setup()
    const ac = h.connect()
    const a = await join(ac)
    await h.tick(50)
    const server = serverRoom(h, a)
    await ac.close(4999)
    expect(server.isPaused).toBe(true)

    const b = await join()
    expect(server.isPaused).toBe(false)
    expect(calls.at(-1)).toBe("onResume")
    await h.tick(50)
    expect(b.snapshots).toBe(1)
    expect(b.state?.players.has(b.sessionId)).toBe(true)
    // The loops run again: a change reaches b at the next boundary.
    server.game.turn.set(7)
    await h.tick(50)
    expect(b.state?.turn.get()).toBe(7)
    await h.stop()
  })

  test("onDisconnect and onReconnect bracket a held seat", async () => {
    const { h, join } = await setup()
    const ac = h.connect()
    const a = await join(ac)
    const b = await join()
    await h.tick(50)
    calls.length = 0

    await ac.close(4999)
    expect(calls).toEqual([`onDisconnect ${a.sessionId}`])
    const again = (
      await h.connect().reconnect(a.reconnectionToken ?? "", opts)
    ).unwrap()
    expect(again.sessionId).toBe(a.sessionId)
    expect(calls).toEqual([
      `onDisconnect ${a.sessionId}`,
      `onReconnect ${a.sessionId}`,
    ])
    // What onReconnect sent arrived after the handshake, on the new seat.
    expect(again.received("welcome")).toEqual([
      { sessionId: a.sessionId, players: 2 },
    ])
    expect(b.left).toEqual([])
    await h.stop()
  })

  test("a seat that isn't held gets onLeave, not onDisconnect", async () => {
    const { h, join } = await setup({ allowReconnection: false })
    const ac = h.connect()
    const a = await join(ac)
    await join()
    calls.length = 0
    await ac.close(4999)
    expect(calls).toEqual([`onLeave ${a.sessionId} false`])
    await h.stop()
  })

  test("a held seat that expires gets onLeave, and no onReconnect", async () => {
    const { h, join } = await setup({ reconnectionTimeout: 5 })
    const ac = h.connect()
    const a = await join(ac)
    await join()
    calls.length = 0
    await ac.close(4999)
    await h.tick(5_000)
    expect(calls).toEqual([
      `onDisconnect ${a.sessionId}`,
      `onLeave ${a.sessionId} false`,
    ])
    await h.stop()
  })

  test("an expired seat is released with onLeave(false)", async () => {
    const { h, join } = await setup({ reconnectionTimeout: 5 })
    const ac = h.connect()
    const a = await join(ac)
    const b = await join()
    await h.tick(50)
    await ac.close(4999)
    await h.tick(5_000)
    expect(calls).toContain(`onLeave ${a.sessionId} false`)
    expect(b.left).toEqual([a.sessionId])
    await h.tick(50)
    expect(b.state?.players.has(a.sessionId)).toBe(false)
    const late = await h.connect().reconnect(a.reconnectionToken ?? "")
    expect(late.isErr() && late.error.code).toBe("INVALID_TOKEN")
    await h.stop()
  })

  test("without allowReconnection a drop is a leave", async () => {
    const { h, join } = await setup({ allowReconnection: false })
    const ac = h.connect()
    const a = await join(ac)
    const b = await join()
    expect(a.reconnectionToken).toBeNull()
    await ac.close(4999)
    expect(calls).toContain(`onLeave ${a.sessionId} false`)
    expect(b.left).toEqual([a.sessionId])
    await h.stop()
  })
})
