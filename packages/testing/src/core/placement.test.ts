/**
 * Server-side matchmaking with a `Placement`: `where` pools of one room
 * type, and keyed rooms (one per key).
 */
import { describe, expect, test } from "bun:test"
import { gameContract } from "./fixtures"
import { setup } from "./helpers"

describe("where", () => {
  test("joinOrCreate picks and creates rooms in the matching pool", async () => {
    const { h } = await setup({ autoDispose: false })
    const mm = h.server.getMatchMaker()
    const low = (
      await mm.joinOrCreate("game", {}, { where: { tier: "low" } })
    ).unwrap()
    expect(low.metadata).toEqual({ tier: "low" })
    const again = (
      await mm.joinOrCreate("game", {}, { where: { tier: "low" } })
    ).unwrap()
    expect(again.id).toBe(low.id)
    const high = (
      await mm.joinOrCreate("game", {}, { where: { tier: "high" } })
    ).unwrap()
    expect(high.id).not.toBe(low.id)
    // No where: any available room of the type.
    const any = (await mm.joinOrCreate("game")).unwrap()
    expect([low.id, high.id]).toContain(any.id)
    await h.stop()
  })

  test("concurrent calls for one pool create one room", async () => {
    const { h } = await setup({ autoDispose: false })
    const mm = h.server.getMatchMaker()
    const where = { tier: "low", seats: 6 }
    const rooms = await Promise.all([
      mm.joinOrCreate("game", {}, { where }),
      mm.reserve("game", {}, { where: { seats: 6, tier: "low" } }),
      mm.joinOrCreate("game", {}, { where }),
    ])
    const [a, reserved, b] = rooms
    const id = a.unwrap().id
    expect(b.unwrap().id).toBe(id)
    expect(reserved.unwrap().roomId).toBe(id)
    expect(mm.getRoomCount()).toBe(1)
    await h.stop()
  })

  test("the where entries win over the create options' metadata", async () => {
    const { h } = await setup()
    const mm = h.server.getMatchMaker()
    const room = (
      await mm.createRoom(
        "game",
        { metadata: { tier: "high", mode: "duel" } },
        { where: { tier: "low" } },
      )
    ).unwrap()
    expect(room.metadata).toEqual({ tier: "low", mode: "duel" })
    await h.stop()
  })
})

describe("where on a private room type", () => {
  test("reserve and joinOrCreate share one private room per pool", async () => {
    const { h } = await setup({ autoDispose: false, visibility: "private" })
    const mm = h.server.getMatchMaker()
    const first = (
      await mm.reserve("game", {}, { where: { region: "eu" } })
    ).unwrap()
    const second = (
      await mm.reserve("game", {}, { where: { region: "eu" } })
    ).unwrap()
    expect(second.roomId).toBe(first.roomId)
    const room = (
      await mm.joinOrCreate("game", {}, { where: { region: "eu" } })
    ).unwrap()
    expect(room.id).toBe(first.roomId)
    expect(room.visibility).toBe("private")
    const other = (
      await mm.reserve("game", {}, { where: { region: "us" } })
    ).unwrap()
    expect(other.roomId).not.toBe(first.roomId)
    expect(mm.getRoomCount()).toBe(2)
    const found = (
      await mm.joinRoom("game", {}, { where: { region: "eu" } })
    ).unwrap()
    expect(found.id).toBe(first.roomId)
    // Still hidden from clients' matchmaking, and from query by default.
    expect((await mm.query({ type: "game" })).unwrap()).toEqual([])
    const view = await h.connect().join("game", {}, { contract: gameContract })
    expect(view.isErr() && view.error.code).toBe("ROOM_NOT_FOUND")
    const seated = (
      await h.connect().consumeReservation(first.id, { contract: gameContract })
    ).unwrap()
    expect(seated.roomId).toBe(first.roomId)
    await h.stop()
  })

  test("a full private pool room makes a new one, not a failure", async () => {
    const { h } = await setup({
      autoDispose: false,
      visibility: "private",
      maxClients: 1,
    })
    const mm = h.server.getMatchMaker()
    const where = { region: "eu" }
    const a = (await mm.reserve("game", {}, { where })).unwrap()
    const b = (await mm.reserve("game", {}, { where })).unwrap()
    expect(b.roomId).not.toBe(a.roomId)
    expect(mm.getRoomCount()).toBe(2)
    await h.stop()
  })

  test("reserve without where seats in the private room it created", async () => {
    const { h } = await setup({ autoDispose: false, visibility: "private" })
    const mm = h.server.getMatchMaker()
    // The type alone is the pool clients' joinOrCreate uses, which never
    // sees a private room: each call creates one, and holds a seat in it.
    const a = (await mm.reserve("game", {})).unwrap()
    const b = (await mm.reserve("game", {})).unwrap()
    expect(b.roomId).not.toBe(a.roomId)
    for (const room of mm.getAllRooms()) expect(room.getSeatCount()).toBe(1)
    await h.stop()
  })
})

describe("key", () => {
  test("joinOrCreate returns the keyed room whether or not it's available", async () => {
    const { h } = await setup({ autoDispose: false, maxClients: 1 })
    const mm = h.server.getMatchMaker()
    const room = (await mm.joinOrCreate("game", {}, { key: "m1" })).unwrap()
    expect(room.key).toBe("m1")
    room.lock()
    const again = (await mm.joinOrCreate("game", {}, { key: "m1" })).unwrap()
    expect(again.id).toBe(room.id)
    const other = (await mm.joinOrCreate("game", {}, { key: "m2" })).unwrap()
    expect(other.id).not.toBe(room.id)
    const listed = (await mm.query({ type: "game" })).unwrap()
    expect(listed.map((r) => r.key).sort()).toEqual(["m1", "m2"])
    await h.stop()
  })

  test("createRoom refuses a key that is taken, and frees it on dispose", async () => {
    const { h } = await setup({ autoDispose: false })
    const mm = h.server.getMatchMaker()
    const room = (await mm.createRoom("game", {}, { key: "m1" })).unwrap()
    const twice = await mm.createRoom("game", {}, { key: "m1" })
    expect(twice.isErr() && twice.error.code).toBe("ROOM_EXISTS")
    await room.dispose()
    const after = (await mm.createRoom("game", {}, { key: "m1" })).unwrap()
    expect(after.id).not.toBe(room.id)
    await h.stop()
  })

  test("concurrent keyed calls create one room", async () => {
    const { h } = await setup({ autoDispose: false })
    const mm = h.server.getMatchMaker()
    const [a, b, c] = await Promise.all([
      mm.joinOrCreate("game", {}, { key: "m1" }),
      mm.createRoom("game", {}, { key: "m1" }),
      mm.joinOrCreate("game", {}, { key: "m1" }),
    ])
    expect(b.isErr() && b.error.code).toBe("ROOM_EXISTS")
    expect(c.unwrap().id).toBe(a.unwrap().id)
    expect(mm.getRoomCount()).toBe(1)
    await h.stop()
  })

  test("reserve takes a seat in the keyed room, private or full as it is", async () => {
    const { h } = await setup({ autoDispose: false, maxClients: 1 })
    const mm = h.server.getMatchMaker()
    const room = (await mm.createRoom("game", {}, { key: "m1" })).unwrap()
    room.makePrivate()
    const reservation = (await mm.reserve("game", {}, { key: "m1" })).unwrap()
    expect(reservation.roomId).toBe(room.id)
    const full = await mm.reserve("game", {}, { key: "m1" })
    expect(full.isErr() && full.error.code).toBe("ROOM_FULL")
    expect(mm.getRoomCount()).toBe(1)
    const view = (
      await h.connect().consumeReservation(reservation.id, {
        contract: gameContract,
      })
    ).unwrap()
    expect(view.roomId).toBe(room.id)
    await h.stop()
  })

  test("joinRoom finds by key or where, and creates nothing", async () => {
    const { h } = await setup({ autoDispose: false })
    const mm = h.server.getMatchMaker()
    const missing = await mm.joinRoom("game", {}, { key: "m1" })
    expect(missing.isErr() && missing.error.code).toBe("ROOM_NOT_FOUND")
    const keyed = (await mm.createRoom("game", {}, { key: "m1" })).unwrap()
    const pooled = (
      await mm.createRoom("game", {}, { where: { tier: "low" } })
    ).unwrap()
    expect((await mm.joinRoom("game", {}, { key: "m1" })).unwrap().id).toBe(
      keyed.id,
    )
    const low = await mm.joinRoom("game", {}, { where: { tier: "low" } })
    expect(low.unwrap().id).toBe(pooled.id)
    expect(mm.getRoomCount()).toBe(2)
    await h.stop()
  })
})
