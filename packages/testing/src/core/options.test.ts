/**
 * Typed join and create options (spec §4.1.2, PROTOCOL.md §6.2.1), end to
 * end: declared in the contract, typed on both ends, decoded against the
 * declarations before any hook runs, and converted the same way when the
 * server builds them itself.
 */
import { beforeEach, describe, expect, test } from "bun:test"
import { Client, Room, type RoomOnCreateOptions } from "@bungohan/core"
import { Schema } from "@bungohan/state"
import {
  contractHash,
  defineContract,
  defineMessage,
  f,
  type InferCreateOptions,
  type InferJoinOptions,
} from "@bungohan/types"
import { createTestHarness, type TestHarness } from "../harness"

const ArenaCreate = defineMessage("arenaCreate", {
  map: f.enum("dust", "ice"),
  rounds: f.uint8,
})
const ArenaJoin = defineMessage("arenaJoin", {
  name: f.string,
  aim: f.fixed(2),
  team: f.optional(f.uint8),
  spin: f.float64,
})
const Ping = defineMessage("ping", {})

const arenaContract = defineContract({
  client: { ping: Ping },
  server: {},
  options: { create: ArenaCreate, join: ArenaJoin },
})

type Create = InferCreateOptions<typeof arenaContract>
type Join = InferJoinOptions<typeof arenaContract>

/** What the arena's hooks were handed, in order. */
const seen: [hook: string, options: unknown][] = []

class ArenaState extends Schema {
  public static override schemaName = "Options.Arena"
}

class ArenaRoom extends Room<ArenaState, typeof arenaContract> {
  public static override contract = arenaContract
  public override state = new ArenaState()

  protected static override async onAuth(
    _client: Client,
    options: Join,
  ): Promise<boolean> {
    seen.push(["static onAuth", options])
    return true
  }

  protected override async onCreate(
    options: RoomOnCreateOptions & Create,
  ): Promise<void> {
    // Typed from the declaration: no narrowing by hand.
    const map: "dust" | "ice" = options.map
    seen.push(["onCreate", { map, rounds: options.rounds }])
  }

  protected override async onAuth(
    _client: Client,
    options: Join,
  ): Promise<boolean> {
    seen.push(["onAuth", options])
    return true
  }

  protected override async onJoin(
    _client: Client,
    options: Join,
  ): Promise<void> {
    const name: string = options.name
    const team: number | undefined = options.team
    void team
    seen.push(["onJoin", { ...options, name }])
  }
}

/** The same contract as a client built before `spin` was added. */
const olderContract = defineContract({
  client: { ping: Ping },
  server: {},
  options: {
    create: ArenaCreate,
    join: defineMessage("arenaJoin", {
      name: f.string,
      aim: f.fixed(2),
      team: f.optional(f.uint8),
    }),
  },
})

const join = { state: ArenaState, contract: arenaContract } as const

async function arena(): Promise<TestHarness> {
  return createTestHarness({ rooms: { arena: ArenaRoom } })
}

beforeEach(() => {
  seen.length = 0
})

describe("declaration", () => {
  test("options are part of the contract hash; a contract without them hashes as before", () => {
    const plain = defineContract({ client: { ping: Ping }, server: {} })
    expect(contractHash(plain)).toBe(contractHash({ ...plain, options: {} }))
    expect(contractHash(arenaContract)).not.toBe(contractHash(plain))
    expect(contractHash(olderContract)).not.toBe(contractHash(arenaContract))
  })

  test("create options can't declare what onCreate already receives", async () => {
    const clash = defineContract({
      client: {},
      server: {},
      options: {
        create: defineMessage("clash", { maxClients: f.uint8 }),
      },
    })
    class ClashRoom extends Room<Schema, typeof clash> {
      public static override contract = clash
    }
    await expect(
      createTestHarness({ rooms: { clash: ClashRoom } }),
    ).rejects.toThrow(/options\.create\.maxClients/)
  })
})

describe("from a client", () => {
  test("create and join options reach the hooks typed, as decoding produced them", async () => {
    const h = await arena()
    const client = await h.connect()
    const room = (
      await client.joinOrCreate(
        "arena",
        {
          create: { map: "ice", rounds: 300 },
          join: { name: "ann", aim: 1.234, spin: -0 },
        },
        join,
      )
    ).unwrap()

    expect(seen.map(([hook]) => hook)).toEqual([
      "static onAuth",
      "onCreate",
      "onJoin",
    ])
    // uint8 saturated, fixed:2 rounded, −0 kept, the absent optional absent.
    expect(seen[1]?.[1]).toEqual({ map: "ice", rounds: 255 })
    const joined = seen[2]?.[1] as Record<string, unknown>
    expect(joined).toEqual({ name: "ann", aim: 1.23, spin: -0 })
    expect(Object.is(joined["spin"], -0)).toBe(true)
    expect("team" in joined).toBe(false)
    expect(seen[0]?.[1]).toEqual(joined)

    // A second client joins the room: join options only, instance onAuth.
    seen.length = 0
    const other = await h.connect()
    ;(
      await other.joinById(
        room.id,
        { name: "bo", aim: -2.25, team: 2, spin: 0.5 },
        join,
      )
    ).unwrap()
    const expected = { name: "bo", aim: -2.25, team: 2, spin: 0.5 }
    expect(seen).toEqual([
      ["onAuth", expected],
      ["onJoin", expected],
    ])
    await h.stop()
  })

  test("options that don't decode fail with INVALID_OPTIONS before anything happens", async () => {
    const h = await arena()
    // A client built without the declarations sends a MessagePack map.
    const driver = h.driver()
    const joined = await driver.joinOrCreate(
      "arena",
      { name: "ann", aim: 1, spin: 0 },
      { contractHash: contractHash(arenaContract) },
    )
    expect(joined.isErr() && joined.error.code).toBe("INVALID_OPTIONS")
    expect(h.server.getMatchMaker().getRoomCount()).toBe(0)
    expect(seen).toEqual([])
    expect(driver.connected).toBe(true)
    await h.stop()
  })

  test("a client built against older declarations fails with CONTRACT_MISMATCH", async () => {
    const h = await arena()
    const client = await h.connect()
    const stale = await client.joinOrCreate(
      "arena",
      {
        create: { map: "dust", rounds: 1 },
        join: { name: "ann", aim: 1 },
      },
      { contract: olderContract },
    )
    expect(stale.isErr() && stale.error.code).toBe("CONTRACT_MISMATCH")

    // Without the hash check its bytes are still read against the room's
    // declarations, exactly: they are one float short.
    const driver = h.driver()
    const unchecked = await driver.joinOrCreate(
      "arena",
      { create: { map: "dust", rounds: 1 }, join: { name: "ann", aim: 1 } },
      { contract: olderContract, contractHash: null },
    )
    expect(unchecked.isErr() && unchecked.error.code).toBe("INVALID_OPTIONS")
    expect(seen).toEqual([])
    await h.stop()
  })
})

describe("built by the server", () => {
  test("createRoom with the class is typed, and converted like a client's", async () => {
    const h = await arena()
    const mm = h.server.getMatchMaker()
    ;(await mm.createRoom(ArenaRoom, { map: "dust", rounds: 999 })).unwrap()
    expect(seen).toEqual([["onCreate", { map: "dust", rounds: 255 }]])

    // By name the options aren't typed, so the conversion is the check.
    const bad = await mm.createRoom("arena", { map: "lava", rounds: 1 })
    expect(bad.isErr() && bad.error.code).toBe("INVALID_OPTIONS")
    const missing = await mm.createRoom("arena", { rounds: 1 })
    expect(missing.isErr() && missing.error.code).toBe("INVALID_OPTIONS")
    expect(mm.getRoomCount()).toBe(1)
    await h.stop()
  })

  test("a reservation holds converted join options, and creates with its create options", async () => {
    const h = await arena()
    const mm = h.server.getMatchMaker()
    const reservation = (
      await mm.reserve(
        ArenaRoom,
        { name: "cy", aim: 0.125, spin: 3 },
        undefined,
        { map: "ice", rounds: 2 },
      )
    ).unwrap()
    expect(seen).toEqual([["onCreate", { map: "ice", rounds: 2 }]])

    // By name nothing checks the types, so the conversion refuses it.
    const refused = await mm.reserve("arena", {
      name: "dee",
      aim: 0,
      spin: "fast",
    })
    expect(refused.isErr() && refused.error.code).toBe("INVALID_OPTIONS")

    const client = await h.connect()
    ;(await client.consumeReservation(reservation, join)).unwrap()
    // fixed:2 rounds half away from zero: 0.125 → 0.13.
    expect(seen.slice(1)).toEqual([
      ["onAuth", { name: "cy", aim: 0.13, spin: 3 }],
      ["onJoin", { name: "cy", aim: 0.13, spin: 3 }],
    ])
    await h.stop()
  })

  test("room.join for a bot converts its options too", async () => {
    const h = await arena()
    const mm = h.server.getMatchMaker()
    const room = (
      await mm.createRoom(ArenaRoom, { map: "dust", rounds: 1 })
    ).unwrap()
    if (!(room instanceof ArenaRoom)) throw new Error("not an ArenaRoom")
    seen.length = 0
    ;(
      await room.join(new Client("bot", undefined), {
        name: "bot",
        aim: 9.999,
        spin: 1,
      })
    ).unwrap()
    expect(seen.at(-1)).toEqual(["onJoin", { name: "bot", aim: 10, spin: 1 }])
    await h.stop()
  })

  test("a class must name exactly one room type", async () => {
    const h = await createTestHarness({
      rooms: { a: ArenaRoom, b: ArenaRoom },
    })
    const mm = h.server.getMatchMaker()
    const ambiguous = await mm.createRoom(ArenaRoom, { map: "dust", rounds: 1 })
    expect(ambiguous.isErr() && ambiguous.error.code).toBe("INVALID_OPTIONS")
    class Stray extends Room {}
    const stray = await mm.createRoom(Stray)
    expect(stray.isErr() && stray.error.code).toBe("ROOM_TYPE_NOT_DEFINED")
    await h.stop()
  })
})
