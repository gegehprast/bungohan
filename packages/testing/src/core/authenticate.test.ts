/**
 * `ServerOptions.authenticate` (spec §10.1): a connection's credentials
 * are checked once, every join waits for that, and rooms inherit the
 * result.
 */
import { describe, expect, test } from "bun:test"
import {
  type AuthResult,
  type Client,
  type ConnectionContext,
  createBungohanServer,
  Room,
  type RoomClass,
} from "@bungohan/core"
import { ClientFrameType, JoinMode, ServerFrameType } from "@bungohan/types"
import { createServerHarness } from "../harness"
import { GameState, gameContract } from "./fixtures"
import { serverRoom, setup } from "./helpers"

const opts = { state: GameState, contract: gameContract }

/** One-time tickets, as a `GETDEL` in a real store would redeem them. */
function tickets(...valid: string[]) {
  const unused = new Map(valid.map((ticket, i) => [ticket, `user-${i + 1}`]))
  const seen: (string | undefined)[] = []
  return {
    seen,
    authenticate(context: ConnectionContext): AuthResult {
      seen.push(context.token)
      const userId =
        context.token === undefined ? undefined : unused.get(context.token)
      if (context.token === undefined || userId === undefined) return false
      unused.delete(context.token)
      return { userId }
    },
  }
}

describe("authenticate", () => {
  test("a one-time ticket is redeemed once, however many rooms the connection joins", async () => {
    const auth = tickets("t1")
    const { h } = await setup({}, { authenticate: auth.authenticate })
    const client = h.connect({ token: "t1" })
    const first = (await client.create("game", {}, opts)).unwrap()
    const second = (await client.create("game", {}, opts)).unwrap()
    expect(second.roomId).not.toBe(first.roomId)
    expect(auth.seen).toEqual(["t1"])
    // GameRoom's onAuth returns true: each seat gets the connection's auth.
    for (const view of [first, second]) {
      const seat = serverRoom(h, view).getClient(view.sessionId)
      expect(seat?.auth).toEqual({ userId: "user-1" })
      expect(seat?.connection?.auth).toEqual({ userId: "user-1" })
    }
    await h.stop()
  })

  test("each seat gets its own copy of the connection's auth", async () => {
    const { h, join } = await setup({}, { authenticate: () => ({ n: 1 }) })
    const client = h.connect()
    const view = await join(client)
    const seat = serverRoom(h, view).getClient(view.sessionId)
    if (seat === undefined) throw new Error("no seat")
    seat.auth["n"] = 2
    expect(seat.connection?.auth).toEqual({ n: 1 })
    await h.stop()
  })

  test("a refused connection fails every join with AUTH_FAILED and stays open", async () => {
    const auth = tickets("t1")
    const { h, join } = await setup({}, { authenticate: auth.authenticate })
    // A spent ticket, on a second connection.
    await join(h.connect({ token: "t1" }))
    const client = h.connect({ token: "t1" })
    for (let i = 0; i < 2; i++) {
      const joined = await client.create("game", {}, opts)
      expect(joined.isErr() && joined.error.code).toBe("AUTH_FAILED")
    }
    expect(auth.seen).toEqual(["t1", "t1"])
    expect(client.closeCode).toBeUndefined()
    await h.stop()
  })

  test("it gates reconnection and reservations too", async () => {
    const auth = tickets("t1")
    const { h, join } = await setup({}, { authenticate: auth.authenticate })
    const client = h.connect({ token: "t1" })
    const view = await join(client)
    const token = view.reconnectionToken ?? ""
    await client.close(1006)
    await h.flush()
    const again = h.connect({ token: "t1" })
    const resumed = await again.reconnect(token, opts)
    expect(resumed.isErr() && resumed.error.code).toBe("AUTH_FAILED")
    const reserved = (await h.server.getMatchMaker().reserve("game")).unwrap()
    const consumed = await again.consumeReservation(reserved.id, opts)
    expect(consumed.isErr() && consumed.error.code).toBe("AUTH_FAILED")
    await h.stop()
  })

  test("a throw fails every join with JOIN_FAILED, reported once", async () => {
    let runs = 0
    const { h, errors } = await setup(
      {},
      {
        authenticate: () => {
          runs++
          throw new Error("ticket store down")
        },
      },
    )
    const client = h.connect()
    for (let i = 0; i < 2; i++) {
      const joined = await client.create("game", {}, opts)
      expect(joined.isErr() && joined.error.code).toBe("JOIN_FAILED")
    }
    expect(runs).toBe(1)
    expect(
      errors.map(([error, context]) => [error.message, context.source]),
    ).toEqual([["ticket store down", "authenticate"]])
    await h.stop()
  })

  test("a join waits for a slow authenticate; the connection opens at once", async () => {
    let admit: (result: AuthResult) => void = () => {}
    const pending = new Promise<AuthResult>((resolve) => {
      admit = resolve
    })
    const connected: (Record<string, unknown> | undefined)[] = []
    const { h } = await setup({}, { authenticate: () => pending })
    h.server.onConnect((connection) => connected.push(connection.auth))
    const client = h.connect()
    // A raw JOIN: the driver's own join would give up after one flush.
    client.sendFrame(
      ClientFrameType.JOIN,
      [1],
      [JoinMode.CREATE, "game", {}, null],
    )
    await h.flush()
    expect(connected).toEqual([undefined])
    expect(client.frames).toEqual([])
    expect(h.server.getMatchMaker().getRoomCount()).toBe(0)
    admit({ userId: "late" })
    await h.flush()
    expect(client.frames[0]?.[0]).toBe(ServerFrameType.JOIN_SUCCESS)
    const [room] = h.server.getMatchMaker().getAllRooms()
    expect(room?.getClients().map((seat) => seat.auth)).toEqual([
      { userId: "late" },
    ])
    await h.stop()
  })

  test("without authenticate every connection is admitted with {}", async () => {
    const { h, join } = await setup()
    const view = await join(h.connect())
    const seat = serverRoom(h, view).getClient(view.sessionId)
    expect(seat?.connection?.auth).toEqual({})
    expect(seat?.auth).toEqual({})
    await h.stop()
  })

  test("a room's onAuth can read the connection's auth, and its object wins", async () => {
    const seen: unknown[] = []
    class VipRoom extends Room {
      protected static override async onAuth(client: Client) {
        seen.push(client.connection?.auth)
        return client.connection?.auth?.["vip"] === true && { tier: "gold" }
      }
    }
    const h = await createServerHarness({
      server: { authenticate: (context) => ({ vip: context.token === "vip" }) },
      define: (s) => s.defineRoomType("vip", VipRoom),
    })
    const pleb = await h.connect({ token: "x" }).create("vip", {})
    expect(pleb.isErr() && pleb.error.code).toBe("AUTH_FAILED")
    const vip = (await h.connect({ token: "vip" }).create("vip", {})).unwrap()
    const room = h.server.getMatchMaker().getRoom(vip.roomId)
    expect(room?.getClient(vip.sessionId)?.auth).toEqual({ tier: "gold" })
    expect(seen).toEqual([{ vip: false }, { vip: true }])
    await h.stop()
  })
})

describe("onAuth written once", () => {
  function warningsFor(RoomClass: RoomClass<Room>): string[] {
    const warnings: string[] = []
    const sink = { ...console, warn: (line: string) => warnings.push(line) }
    const server = createBungohanServer({ logger: { sink } })
    server.defineRoomType("checked", RoomClass)
    return warnings
  }

  test("an instance onAuth without the static one warns at definition", () => {
    class Guarded extends Room {
      protected override async onAuth() {
        return false
      }
    }
    const [warning, ...rest] = warningsFor(Guarded)
    expect(rest).toEqual([])
    expect(warning).toContain('room type "checked": Guarded overrides')
  })

  test("both hooks, or neither, don't", () => {
    class Both extends Room {
      protected static override async onAuth() {
        return true
      }
      protected override async onAuth() {
        return false
      }
    }
    class StaticFromBase extends Both {}
    expect(warningsFor(Both)).toEqual([])
    expect(warningsFor(StaticFromBase)).toEqual([])
    expect(warningsFor(class Open extends Room {})).toEqual([])
  })
})
