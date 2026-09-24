/**
 * `client.joinedBy`: how each seat was taken, set by the server.
 */
import { expect, test } from "bun:test"
import { Client, Room } from "@bungohan/core"
import { createServerHarness } from "../harness"
import { gameContract } from "./fixtures"
import { serverRoom, setup } from "./helpers"

const opts = { contract: gameContract }

test("each way of taking a seat is told apart", async () => {
  const { h, join } = await setup({ maxClients: 10 })
  const creator = await join()
  const room = serverRoom(h, creator)
  const found = await join()
  const byId = (await h.connect().joinById(creator.roomId, {}, opts)).unwrap()
  const reservation = (
    await h.server.getMatchMaker().reserveById(creator.roomId)
  ).unwrap()
  const reserved = (
    await h.connect().consumeReservation(reservation.id, opts)
  ).unwrap()
  const bot = new Client("bot-1")
  ;(await room.join(bot)).unwrap()

  const how = (sessionId: string) => room.getClient(sessionId)?.joinedBy
  expect(how(creator.sessionId)).toBe("create")
  expect(how(found.sessionId)).toBe("join")
  expect(how(byId.sessionId)).toBe("join")
  expect(how(reserved.sessionId)).toBe("reservation")
  expect(how("bot-1")).toBe("server")
  await h.stop()
})

test("a reconnection keeps how the seat was first taken", async () => {
  const { h } = await setup()
  const mm = h.server.getMatchMaker()
  const reservation = (await mm.reserve("game")).unwrap()
  const first = h.connect()
  const view = (await first.consumeReservation(reservation.id, opts)).unwrap()
  await first.close(1006)
  await h.flush()
  const back = (
    await h.connect().reconnect(view.reconnectionToken ?? "", opts)
  ).unwrap()
  expect(back.sessionId).toBe(view.sessionId)
  const room = mm.getRoom(view.roomId)
  expect(room?.getClient(view.sessionId)?.joinedBy).toBe("reservation")
  await h.stop()
})

test("a room can admit only players with a reservation", async () => {
  class PlacedOnly extends Room {
    protected static override async onAuth(client: Client) {
      return client.joinedBy === "reservation"
    }

    protected override async onAuth(client: Client) {
      return client.joinedBy === "reservation"
    }
  }
  const h = await createServerHarness({
    define: (s) => s.defineRoomType("placed", PlacedOnly),
  })
  const mm = h.server.getMatchMaker()
  const room = (await mm.createRoom("placed")).unwrap()
  room.makePrivate() // not listed; its id may still leak
  const direct = await h.connect().joinById(room.id)
  expect(direct.isErr() && direct.error.code).toBe("AUTH_FAILED")
  const reservation = (await mm.reserveById(room.id)).unwrap()
  const placed = await h.connect().consumeReservation(reservation.id)
  expect(placed.isOk()).toBe(true)
  await h.stop()
})

test("a refused join doesn't dispose a room it didn't create", async () => {
  class Closed extends Room {
    protected override async onAuth() {
      return false
    }

    protected static override async onAuth() {
      return false
    }
  }
  const h = await createServerHarness({
    define: (s) => s.defineRoomType("closed", Closed),
  })
  const room = (await h.server.getMatchMaker().createRoom("closed")).unwrap()
  const refused = await h.connect().joinById(room.id)
  expect(refused.isErr() && refused.error.code).toBe("AUTH_FAILED")
  expect(room.isDisposed).toBe(false)
  expect(h.server.getMatchMaker().getRoom(room.id)).toBe(room)
  await h.stop()
})

test("a refused reserved seat still lets its empty room go", async () => {
  class Closed extends Room {
    protected override async onAuth() {
      return false
    }
  }
  const h = await createServerHarness({
    define: (s) => s.defineRoomType("closed", Closed),
  })
  const mm = h.server.getMatchMaker()
  const reservation = (await mm.reserve("closed")).unwrap()
  const refused = await h.connect().consumeReservation(reservation.id)
  expect(refused.isErr() && refused.error.code).toBe("AUTH_FAILED")
  await h.flush()
  expect(mm.getRoom(reservation.roomId)).toBeUndefined()
  await h.stop()
})
