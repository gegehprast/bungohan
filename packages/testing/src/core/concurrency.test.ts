/**
 * Concurrent find-or-create (spec §6.7.2): "a room being created is
 * registered at once, so a concurrent joinOrCreate waits for it rather than
 * creating a second one". Covers server-side `joinOrCreate` and `reserve`,
 * client `JOIN_OR_CREATE`, and any mix of them, including a room being
 * created that fills up or fails.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { BungohanClient } from "@bungohan/client-js"
import { type DefineRoomOptions, Room } from "@bungohan/core"
import { createInt, Schema } from "@bungohan/state"
import { f } from "@bungohan/types"
import { createTestHarness, type TestHarness } from "../harness"

class SlowState extends Schema {
  public static override readonly schemaName = "Concurrency.Slow"
  public n = createInt(f.uint8)
}

/** Rooms that finished `onCreate`, by id. */
const created: string[] = []
/** How many of the next creations fail (static onAuth or onCreate). */
const failing = { auth: 0, create: 0 }

/** `onCreate` takes 100 ms, like loading a map: a wide creation window. */
class SlowRoom extends Room<SlowState> {
  protected override state = new SlowState()

  protected static override async onAuth(): Promise<boolean> {
    if (failing.auth === 0) return true
    failing.auth--
    return false
  }

  protected override async onCreate(): Promise<void> {
    await new Promise<void>((resolve) => this.clock.setTimeout(resolve, 100))
    if (failing.create > 0) {
      failing.create--
      throw new Error("could not load the map")
    }
    created.push(this.id)
  }
}

const slow = { state: SlowState }

let h: TestHarness

async function harness(options: DefineRoomOptions = {}): Promise<TestHarness> {
  h = await createTestHarness({
    rooms: { slow: [SlowRoom, { autoDispose: false, ...options }] },
    client: { pingInterval: 0 },
  })
  return h
}

function mm() {
  return h.server.getMatchMaker()
}

/** Settles server-side calls: they wait on onCreate's 100 ms timer. */
async function run<T>(work: Promise<T>): Promise<T> {
  await h.tick(250)
  return work
}

async function clients(n: number): Promise<BungohanClient[]> {
  const out: BungohanClient[] = []
  for (let i = 0; i < n; i++) out.push(await h.connect())
  return out
}

beforeEach(() => {
  created.length = 0
  failing.auth = 0
  failing.create = 0
})

afterEach(async () => {
  await h.stop()
})

describe("one room for concurrent callers", () => {
  test("server-side joinOrCreate", async () => {
    await harness()
    const rooms = await run(
      Promise.all([
        mm().joinOrCreate("slow"),
        mm().joinOrCreate("slow"),
        mm().joinOrCreate("slow"),
      ]),
    )
    const ids = rooms.map((r) => r.unwrap().id)
    expect(new Set(ids).size).toBe(1)
    expect(created).toEqual([ids[0] ?? ""])
    expect(mm().getRoomCount()).toBe(1)
  })

  test("server-side reserve", async () => {
    await harness({ maxClients: 4 })
    const reservations = await run(
      Promise.all([mm().reserve("slow"), mm().reserve("slow")]),
    )
    const ids = reservations.map((r) => r.unwrap().roomId)
    expect(new Set(ids).size).toBe(1)
    expect(created).toHaveLength(1)
    expect(
      mm()
        .getRoom(ids[0] ?? "")
        ?.getSeatCount(),
    ).toBe(2)
  })

  test("client joinOrCreate", async () => {
    await harness()
    const [a, b, c] = await clients(3)
    const rooms = await Promise.all(
      [a, b, c].map((client) => client?.joinOrCreate("slow", {}, slow)),
    )
    const ids = rooms.map((r) => r?.unwrap().id)
    expect(new Set(ids).size).toBe(1)
    expect(created).toHaveLength(1)
    expect(
      mm()
        .getRoom(ids[0] ?? "")
        ?.getClientCount(),
    ).toBe(3)
  })

  test("server-side and client calls wait for each other", async () => {
    await harness({ maxClients: 8 })
    const [a, b] = await clients(2)
    const joins = [a, b].map((client) => client?.joinOrCreate("slow", {}, slow))
    const server = Promise.all([
      mm().joinOrCreate("slow"),
      mm().reserve("slow"),
    ])
    const [room, reservation] = await run(server)
    const [ja, jb] = await Promise.all(joins)
    const id = room.unwrap().id
    expect(reservation.unwrap().roomId).toBe(id)
    expect(ja?.unwrap().id).toBe(id)
    expect(jb?.unwrap().id).toBe(id)
    expect(created).toEqual([id])
  })

  test("a server-side call started first is joined by a client", async () => {
    await harness()
    const [client] = await clients(1)
    const server = mm().joinOrCreate("slow")
    const joined = await client?.joinOrCreate("slow", {}, slow)
    const room = await run(server)
    expect(joined?.unwrap().id).toBe(room.unwrap().id)
    expect(created).toHaveLength(1)
  })
})

describe("the room being created fills up", () => {
  test("client joins that don't fit get a room of their own", async () => {
    await harness({ maxClients: 1 })
    const all = await clients(3)
    const rooms = await Promise.all(
      all.map((client) => client.joinOrCreate("slow", {}, slow)),
    )
    const ids = rooms.map((r) => r.unwrap().id)
    expect(new Set(ids).size).toBe(3)
    expect(created).toHaveLength(3)
  })

  test("reservations that don't fit get a room of their own", async () => {
    await harness({ maxClients: 1 })
    const reservations = await run(
      Promise.all([mm().reserve("slow"), mm().reserve("slow")]),
    )
    const ids = reservations.map((r) => r.unwrap().roomId)
    expect(new Set(ids).size).toBe(2)
    expect(created).toHaveLength(2)
  })

  test("a reservation and a client join don't share a one-seat room", async () => {
    await harness({ maxClients: 1 })
    const [client] = await clients(1)
    const reserve = mm().reserve("slow")
    const joined = await client?.joinOrCreate("slow", {}, slow)
    const reservation = (await run(reserve)).unwrap()
    expect(joined?.unwrap().id).not.toBe(reservation.roomId)
    expect(created).toHaveLength(2)
  })
})

describe("the room being created fails", () => {
  test("onCreate throws: a waiting client creates its own", async () => {
    await harness()
    failing.create = 1
    const [a, b] = await clients(2)
    const [first, second] = await Promise.all([
      a?.joinOrCreate("slow", {}, slow),
      b?.joinOrCreate("slow", {}, slow),
    ])
    expect(first?.isErr() && first.error.code).toBe("JOIN_FAILED")
    expect(second?.isOk()).toBe(true)
    expect(created).toHaveLength(1)
  })

  test("static onAuth refuses the creator: a waiting client creates its own", async () => {
    await harness()
    failing.auth = 1
    const [a, b] = await clients(2)
    const [first, second] = await Promise.all([
      a?.joinOrCreate("slow", {}, slow),
      b?.joinOrCreate("slow", {}, slow),
    ])
    expect(first?.isErr() && first.error.code).toBe("AUTH_FAILED")
    expect(second?.isOk()).toBe(true)
    expect(created).toHaveLength(1)
  })

  test("onCreate throws: waiting server-side calls create their own", async () => {
    await harness()
    failing.create = 1
    const [room, reservation] = await run(
      Promise.all([mm().joinOrCreate("slow"), mm().reserve("slow")]),
    )
    expect(room.isErr() && room.error.code).toBe("ROOM_CREATE_FAILED")
    expect(reservation.isOk()).toBe(true)
    expect(created).toEqual([reservation.unwrap().roomId])
  })
})
