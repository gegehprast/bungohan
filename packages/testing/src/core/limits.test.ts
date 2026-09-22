/**
 * Per-connection limits (spec §6.9): backpressure on the way out, rate
 * limits on the way in. A client that has stopped reading is simulated
 * with `LoopbackTransport.stall`, which keeps queueing frames for it
 * exactly as an unread socket would.
 */
import { describe, expect, test } from "bun:test"
import { ClientFrameType, CloseCode } from "@bungohan/types"
import type { ServerHarness } from "../harness"
import { GameState, gameContract } from "./fixtures"
import { type GameView, serverRoom, setup } from "./helpers"

/** Moves a player and syncs, so each tick carries a patch. */
async function churn(
  h: ServerHarness,
  view: GameView,
  ticks: number,
): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    view.send("move", { dx: i % 2 === 0 ? 1 : -1 })
    await h.flushSync()
  }
}

/** The server-side seat behind a joined view. */
function seatOf(h: ServerHarness, view: GameView) {
  const seat = serverRoom(h, view).getClient(view.sessionId)
  if (seat === undefined) throw new Error("no seat for that view")
  return seat
}

describe("backpressure", () => {
  test("a client that stops reading is paused, then re-synced in full", async () => {
    const { h, join } = await setup(
      {},
      { limits: { backpressure: { pauseBytes: 300, resumeBytes: 100 } } },
    )
    const client = h.connect()
    const view = await join(client)
    const seat = seatOf(h, view)
    expect(seat._pausedSince).toBeUndefined()

    h.transport.stall(client.socket.clientId)
    await churn(h, view, 40)

    // Paused: the seat is out of the delta stream while its queue drains.
    expect(seat._pausedSince).toBeDefined()
    expect(seat._synced).toBe(false)
    const queued = h.transport.bufferedAmount(client.socket.clientId)
    expect(queued).toBeGreaterThan(300)
    const patchesWhilePaused = view.patches

    // Nothing more is generated for it, so the queue stops growing.
    await churn(h, view, 20)
    expect(h.transport.bufferedAmount(client.socket.clientId)).toBe(queued)

    // Reading again: the backlog drains and a fresh snapshot re-syncs it.
    const snapshotsBefore = view.snapshots
    h.transport.unstall(client.socket.clientId)
    await h.flushSync()
    await h.flushSync()
    expect(seat._pausedSince).toBeUndefined()
    expect(view.snapshots).toBeGreaterThan(snapshotsBefore)
    expect(view.patches).toBeGreaterThan(patchesWhilePaused)
    expect(client.closeCode).toBeUndefined()

    // And it is in sync again, having missed patches while paused.
    await churn(h, view, 2)
    expect(view.state?.players.get(view.sessionId)?.x.get()).toBe(
      serverRoom(h, view).state.players.get(view.sessionId)?.x.get(),
    )
    await h.stop()
  })

  test("RoomMetrics.syncPauses counts each pause", async () => {
    const { h, join } = await setup(
      {},
      {
        metrics: { enabled: true },
        limits: { backpressure: { pauseBytes: 300, resumeBytes: 100 } },
      },
    )
    const client = h.connect()
    const view = await join(client)
    const pauses = () => h.server.getAllRoomMetrics().unwrap()[0]?.syncPauses
    expect(pauses()).toBe(0)

    for (let round = 1; round <= 2; round++) {
      h.transport.stall(client.socket.clientId)
      await churn(h, view, 80)
      expect(pauses()).toBe(round) // once per pause, not per tick paused
      h.transport.unstall(client.socket.clientId)
      await h.flushSync()
      await h.flushSync()
    }
    await h.stop()
  })

  test("a client that never reads is shed with 1013", async () => {
    const { h, join } = await setup(
      {},
      {
        metrics: { enabled: true },
        limits: {
          backpressure: { pauseBytes: 300, resumeBytes: 100, maxPausedMs: 500 },
        },
      },
    )
    const client = h.connect()
    const view = await join(client)
    h.transport.stall(client.socket.clientId)
    await churn(h, view, 60) // 50 ms per sync tick: well past 500 ms paused

    expect(h.server.getServerMetrics().unwrap().totalShed).toBe(1)
    h.transport.unstall(client.socket.clientId)
    await h.flush()
    expect(client.closeCode).toBe(CloseCode.TRY_AGAIN_LATER)
    expect(client.closeReason).toContain("read too slowly")
    await h.stop()
  })

  test("a shed client can reconnect and keep its seat", async () => {
    const { h, join } = await setup(
      { allowReconnection: true },
      {
        limits: {
          backpressure: { pauseBytes: 300, resumeBytes: 100, maxPausedMs: 500 },
        },
      },
    )
    const client = h.connect()
    const view = await join(client)
    const token = view.reconnectionToken
    if (token === null) throw new Error("no reconnection token")
    const room = serverRoom(h, view)
    const before = room.state.players.get(view.sessionId)?.x.get()

    h.transport.stall(client.socket.clientId)
    await churn(h, view, 60)
    h.transport.unstall(client.socket.clientId)
    await h.flush()
    expect(client.closeCode).toBe(CloseCode.TRY_AGAIN_LATER)

    // 1013 is not 1008 precisely because this is allowed to happen.
    const again = (
      await h
        .connect()
        .reconnect(token, { state: GameState, contract: gameContract })
    ).unwrap()
    await h.flushSync()
    expect(again.sessionId).toBe(view.sessionId)
    expect(again.snapshots).toBe(1)
    expect(again.state?.players.get(again.sessionId)?.x.get()).toBe(
      room.state.players.get(again.sessionId)?.x.get(),
    )
    expect(before).toBeDefined()
    await h.stop()
  })

  test("one huge backlog is shed without waiting", async () => {
    const { h, join } = await setup(
      {},
      {
        metrics: { enabled: true },
        limits: { backpressure: { pauseBytes: 100, disconnectBytes: 200 } },
      },
    )
    const client = h.connect()
    const view = await join(client)
    h.transport.stall(client.socket.clientId)
    // Chat is broadcast, so each message is a frame the stalled client
    // never reads; the hard limit trips on the send path, not on a timer.
    for (let i = 0; i < 40; i++) view.send("say", { text: `message ${i}` })
    await h.flush()

    expect(h.server.getServerMetrics().unwrap().totalShed).toBe(1)
    h.transport.unstall(client.socket.clientId)
    await h.flush()
    expect(client.closeCode).toBe(CloseCode.TRY_AGAIN_LATER)
    expect(client.closeReason).toContain("send queue over")
    await h.stop()
  })

  test("limits: false leaves a stalled client alone", async () => {
    const { h, join } = await setup(
      {},
      { metrics: { enabled: true }, limits: false },
    )
    const client = h.connect()
    const view = await join(client)
    h.transport.stall(client.socket.clientId)
    await churn(h, view, 60)

    expect(seatOf(h, view)._pausedSince).toBeUndefined()
    expect(h.server.getServerMetrics().unwrap().totalShed).toBe(0)
    expect(client.closeCode).toBeUndefined()
    await h.stop()
  })
})

describe("rate limits", () => {
  test("a flood of frames is shed with 1013", async () => {
    const { h, join } = await setup(
      {},
      {
        metrics: { enabled: true },
        limits: { messages: { perSecond: 10, burst: 10 } },
      },
    )
    const client = h.connect()
    const view = await join(client)
    for (let i = 0; i < 40; i++) view.send("move", { dx: 1 })
    await h.flush()

    expect(client.closeCode).toBe(CloseCode.TRY_AGAIN_LATER)
    expect(client.closeReason).toContain("too many frames")
    expect(h.server.getServerMetrics().unwrap().totalShed).toBe(1)
    await h.stop()
  })

  test("a flood of bytes is shed even within the frame limit", async () => {
    const { h, join } = await setup(
      {},
      { limits: { messages: { bytesPerSecond: 500 } } },
    )
    const client = h.connect()
    const view = await join(client)
    for (let i = 0; i < 10; i++) view.send("say", { text: "x".repeat(200) })
    await h.flush()

    expect(client.closeCode).toBe(CloseCode.TRY_AGAIN_LATER)
    expect(client.closeReason).toContain("too many bytes")
    await h.stop()
  })

  test("normal play stays well under the defaults", async () => {
    const { h, join } = await setup({}, { metrics: { enabled: true } })
    const client = h.connect()
    const view = await join(client)
    // 60 inputs plus chat: a busy second of a real game.
    for (let i = 0; i < 60; i++) view.send("move", { dx: 1 })
    for (let i = 0; i < 5; i++) view.send("say", { text: "hello" })
    await h.flushSync()

    expect(client.closeCode).toBeUndefined()
    expect(h.server.getServerMetrics().unwrap().totalShed).toBe(0)
    await h.stop()
  })

  test("too many joins are refused without closing the connection", async () => {
    const { h } = await setup({}, { limits: { joins: { perMinute: 2 } } })
    const client = h.connect()
    const first = await client.joinOrCreate("game")
    const second = await client.joinOrCreate("game")
    const third = await client.joinOrCreate("game")

    expect(first.isOk()).toBe(true)
    expect(second.isOk()).toBe(true) // the second attempt spends the budget
    expect(third.isErr() && third.error.code).toBe("RATE_LIMITED")
    expect(client.closeCode).toBeUndefined() // still usable
    await h.stop()
  })

  test("the rate recovers as time passes", async () => {
    const { h, join } = await setup(
      {},
      { limits: { messages: { perSecond: 20, burst: 5 } } },
    )
    const client = h.connect()
    const view = await join(client)
    for (let i = 0; i < 20; i++) {
      view.send("move", { dx: 1 })
      await h.tick(100) // 10 frames/s: under the limit
    }
    expect(client.closeCode).toBeUndefined()
    await h.stop()
  })

  test("the limiter is charged before the frame is decoded", async () => {
    const { h } = await setup(
      {},
      { limits: { messages: { perSecond: 5, burst: 5 } } },
    )
    const client = h.connect()
    // Garbage frames: a violation would be 1008, but the rate limit is
    // charged first, so a flood of junk is shed as 1013 instead.
    for (let i = 0; i < 30; i++) {
      client.sendFrame(ClientFrameType.ROOM_MESSAGE_RAW, [1], "not-an-array")
    }
    await h.flush()
    expect(client.closeCode).toBe(CloseCode.TRY_AGAIN_LATER)
    await h.stop()
  })
})
