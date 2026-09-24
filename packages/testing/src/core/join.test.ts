/**
 * Core end to end over the loopback: the join protocol (spec §6.7) and
 * typed messages in both directions.
 */
import { describe, expect, test } from "bun:test"
import { Client } from "@bungohan/core"
import type { Result } from "@bungohan/result"
import { contractHash, type JoinMode, ServerFrameType } from "@bungohan/types"
import type { JoinFailure } from "../driver"
import { calls, faults, GameState, gameContract } from "./fixtures"
import { frameTypes, serverRoom, setup } from "./helpers"

describe("join handshake", () => {
  test("JOIN_SUCCESS carries the handshake; the snapshot waits for a sync boundary", async () => {
    const { h, join } = await setup()
    const client = h.connect()
    const room = await join(client)

    expect(room.roomRef).toBe(1)
    expect(room.roomType).toBe("game")
    expect(room.sessionId).toMatch(/^[\w-]{12}$/)
    expect(room.reconnectionToken?.startsWith(`${room.roomId}.`)).toBe(true)
    expect(room.contractHash).toBe(contractHash(gameContract))
    expect(room.stateCodec).toBe("schema")
    expect(room.clientMessages).toEqual(["move", "say", "boom"])
    expect(room.serverMessages).toEqual(["welcome", "said"])

    // The message sent inside onJoin arrived after the handshake…
    expect(frameTypes(client)).toEqual([
      ServerFrameType.JOIN_SUCCESS,
      ServerFrameType.ROOM_MESSAGE,
    ])
    expect(room.received("welcome")).toEqual([
      { sessionId: room.sessionId, players: 1 },
    ])
    // …and the snapshot comes at the next sync boundary.
    expect(room.snapshots).toBe(0)
    await h.tick(50)
    expect(room.snapshots).toBe(1)
    expect(room.state?.players.get(room.sessionId)?.name.get()).toBe(
      room.sessionId,
    )
    expect(calls).toEqual([
      "static onAuth",
      "onCreate",
      `onJoin ${room.sessionId}`,
    ])
    await h.stop()
  })

  test("a second client joins the same room; the first hears CLIENT_JOINED", async () => {
    const { h, join } = await setup()
    const a = await join()
    const b = await join()
    expect(b.roomId).toBe(a.roomId)
    expect(a.joined).toEqual([b.sessionId])
    expect(calls).toContain("onAuth") // instance onAuth for an existing room
    await h.tick(50)
    expect(a.state?.players.size).toBe(2)
    expect(b.state?.players.size).toBe(2)
    await h.stop()
  })

  test("typed messages both ways, broadcast encoded once", async () => {
    const { h, join } = await setup()
    const a = await join()
    const b = await join()
    await h.tick(50)

    b.send("say", { text: "hello" })
    a.send("move", { dx: 1.25 })
    await h.flush()
    const said = { from: b.sessionId, text: "hello" }
    expect(a.received("said")).toEqual([said])
    expect(b.received("said")).toEqual([said])

    await h.tick(50)
    expect(b.state?.players.get(a.sessionId)?.x.get()).toBe(1.25)
    await h.stop()
  })

  test("raw messages carry their type inline", async () => {
    const { h, join } = await setup()
    const room = await join()
    room.sendRaw("echo", { any: ["shape", 1] })
    await h.flush()
    expect(room.messages.at(-1)).toEqual({
      type: "echo",
      payload: { any: ["shape", 1] },
      raw: true,
    })
    await h.stop()
  })

  test("one connection can be in several rooms, each with its own roomRef", async () => {
    const { h } = await setup()
    const client = h.connect()
    const opts = { state: GameState, contract: gameContract }
    const one = (await client.create("game", {}, opts)).unwrap()
    const two = (await client.create("game", {}, opts)).unwrap()
    expect([one.roomRef, two.roomRef]).toEqual([1, 2])
    expect(one.roomId).not.toBe(two.roomId)
    two.send("move", { dx: 2 })
    await h.flush()
    await h.tick(50)
    expect(two.state?.players.get(two.sessionId)?.x.get()).toBe(2)
    expect(one.state?.players.get(one.sessionId)?.x.get()).toBe(0)
    await h.stop()
  })
})

describe("join errors", () => {
  test("every JOIN_ERROR code a client can get", async () => {
    const { h, join } = await setup({ maxClients: 2 })
    const client = h.connect()
    const code = async (result: Promise<Result<unknown, JoinFailure>>) => {
      const r = await result
      return r.isErr() ? r.error.code : "ok"
    }
    const opts = { state: GameState, contract: gameContract }

    expect(await code(client.joinOrCreate("nope"))).toBe(
      "ROOM_TYPE_NOT_DEFINED",
    )
    expect(await code(client.join("game"))).toBe("ROOM_NOT_FOUND")
    expect(await code(client.joinById("missing"))).toBe("ROOM_NOT_FOUND")
    expect(
      await code(client.joinOrCreate("game", {}, { contractHash: "deadbeef" })),
    ).toBe("CONTRACT_MISMATCH")
    expect(await code(client.reconnect("nope.token"))).toBe("INVALID_TOKEN")
    expect(await code(client.consumeReservation("nope"))).toBe(
      "RESERVATION_NOT_FOUND",
    )
    expect(await code(client.request(9 as JoinMode, "game", {}))).toBe(
      "INVALID_OPTIONS",
    )

    const room = await join(client)
    expect(await code(client.joinById(room.roomId, {}, opts))).toBe(
      "ALREADY_JOINED",
    )
    const other = h.connect()
    serverRoom(h, room).lock()
    expect(await code(other.joinById(room.roomId, {}, opts))).toBe(
      "ROOM_LOCKED",
    )
    serverRoom(h, room).unlock()
    await join(other)
    expect(await code(h.connect().joinById(room.roomId, {}, opts))).toBe(
      "ROOM_FULL",
    )

    faults.denyAuth = true
    expect(await code(h.connect().create("game", {}, opts))).toBe("AUTH_FAILED")
    await h.stop()
  })

  test("JOIN_ERROR leaves nothing behind", async () => {
    const { h, join, errors } = await setup()
    const first = await join()
    const before = serverRoom(h, first).getClientCount()

    faults.onJoin = true
    const failed = await h
      .connect()
      .joinOrCreate("game", {}, { state: GameState, contract: gameContract })
    expect(failed.isErr() && failed.error.code).toBe("JOIN_FAILED")
    expect(serverRoom(h, first).getClientCount()).toBe(before)
    expect(calls.some((c) => c.startsWith("onLeave"))).toBe(false)
    expect(errors.map(([e, ctx]) => [e.message, ctx.source])).toEqual([
      ["onJoin failed", "onJoin"],
    ])

    faults.onJoin = false
    faults.onCreate = true
    const created = await h.connect().create("game")
    expect(created.isErr() && created.error.code).toBe("JOIN_FAILED")
    await h.flush()
    expect(h.server.getMatchMaker().getRoomCount()).toBe(1)
    await h.stop()
  })

  test("joins are refused once shutdown began", async () => {
    const { h, join } = await setup()
    const client = h.connect()
    await join(client)
    const stopping = h.server.stop()
    const refused = await client.joinOrCreate("game")
    expect(refused.isErr() && refused.error.code).toBe("SERVER_SHUTTING_DOWN")
    await stopping
  })
})

describe("reservations", () => {
  test("a reserved seat is taken with CONSUME_RESERVATION", async () => {
    const { h } = await setup({ maxClients: 1 })
    const mm = h.server.getMatchMaker()
    const reservation = (await mm.reserve("game")).unwrap()
    const room = mm.getRoom(reservation.roomId)
    expect(room?.getSeatCount()).toBe(1)
    // The reservation holds the only seat.
    const full = await h.connect().joinById(reservation.roomId)
    expect(full.isErr() && full.error.code).toBe("ROOM_FULL")

    const view = (
      await h.connect().consumeReservation(reservation.id, {
        contract: gameContract,
      })
    ).unwrap()
    expect(view.sessionId).toBe(reservation.sessionId)
    expect(view.roomId).toBe(reservation.roomId)
    const again = await h.connect().consumeReservation(reservation.id)
    expect(again.isErr() && again.error.code).toBe("RESERVATION_NOT_FOUND")
    await h.stop()
  })

  test("an expired reservation frees its seat and disposes the empty room", async () => {
    const { h } = await setup({ reservationTimeout: 10 })
    const mm = h.server.getMatchMaker()
    const reservation = (await mm.reserve("game")).unwrap()
    await h.tick(10_001)
    const late = await h.connect().consumeReservation(reservation.id)
    expect(late.isErr() && late.error.code).toBe("RESERVATION_EXPIRED")
    expect(mm.getRoom(reservation.roomId)).toBeUndefined()
    await h.stop()
  })

  test("reserveById holds a seat in the chosen room, private ones included", async () => {
    const { h } = await setup({ maxClients: 2 })
    const mm = h.server.getMatchMaker()
    const first = (await mm.createRoom("game")).unwrap()
    const chosen = (await mm.createRoom("game")).unwrap()
    chosen.makePrivate()
    const reservation = (await mm.reserveById(chosen.id)).unwrap()
    expect(reservation.roomId).toBe(chosen.id)
    expect(chosen.getSeatCount()).toBe(1)
    expect(first.getSeatCount()).toBe(0)
    const view = (
      await h.connect().consumeReservation(reservation.id, {
        contract: gameContract,
      })
    ).unwrap()
    expect(view.roomId).toBe(chosen.id)
    await h.stop()
  })

  test("reserveById refuses as joinById does", async () => {
    const { h } = await setup({ maxClients: 1 })
    const mm = h.server.getMatchMaker()
    const code = async (id: string) => {
      const reserved = await mm.reserveById(id)
      return reserved.isErr() ? reserved.error.code : "ok"
    }
    expect(await code("missing")).toBe("ROOM_NOT_FOUND")
    const room = (await mm.createRoom("game")).unwrap()
    room.lock()
    expect(await code(room.id)).toBe("ROOM_LOCKED")
    room.unlock()
    expect(await code(room.id)).toBe("ok")
    expect(await code(room.id)).toBe("ROOM_FULL")
    await h.stop()
  })
})

describe("server-side joins", () => {
  test("Room.join seats a connectionless client (a bot)", async () => {
    const { h, join } = await setup()
    const human = await join()
    const room = serverRoom(h, human)
    const bot = new Client("bot-1")
    ;(await room.join(bot)).unwrap()
    await h.flush()
    expect(human.joined).toEqual(["bot-1"])
    expect(room.game.players.has("bot-1")).toBe(true)
    ;(await room.leave(bot)).unwrap()
    await h.flush()
    expect(human.left).toEqual(["bot-1"])
    await h.stop()
  })
})
