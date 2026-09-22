import {
  type BungohanServer,
  type Client,
  type CreateArg,
  createInt,
  createString,
  defineContract,
  defineMessage,
  f,
  type InferCreateOptions,
  type InferJoinOptions,
  Room,
  type RoomOnCreateOptions,
  Schema,
} from "@bungohan/core"

export class RaceState extends Schema {
  public static override readonly schemaName = "RaceState"
  public track = createString("")
  public laps = createInt(f.uint8)
  public drivers = createInt(f.uint8)
}

// #region declare
export const raceContract = defineContract({
  client: {},
  server: {},
  options: {
    create: defineMessage("raceCreate", {
      track: f.enum("oval", "canyon", "city"),
      laps: f.uint8,
    }),
    join: defineMessage("raceJoin", {
      driver: f.string,
      car: f.optional(f.string),
    }),
  },
})

export type RaceCreate = InferCreateOptions<typeof raceContract>
// { track: "oval" | "canyon" | "city"; laps: number }
export type RaceJoin = InferJoinOptions<typeof raceContract>
// { driver: string; car?: string }
export type RaceCreateArg = CreateArg<typeof raceContract>
// { create: RaceCreate; join: RaceJoin }: what create/joinOrCreate take
// #endregion declare

// #region room
export class RaceRoom extends Room<RaceState, typeof raceContract> {
  public static override contract = raceContract
  protected override state = new RaceState()

  protected override async onCreate(
    options: RoomOnCreateOptions & RaceCreate,
  ): Promise<void> {
    // Framework settings (roomId, maxClients, metadata, …) and the
    // declared create options arrive together.
    this.state.track.set(options.track)
    this.state.laps.set(Math.min(Math.max(options.laps, 1), 50))
  }

  protected override async onJoin(
    _client: Client,
    options: RaceJoin,
  ): Promise<void> {
    if (options.car !== undefined)
      console.log(`${options.driver}: ${options.car}`)
    this.state.drivers.set(this.state.drivers.get() + 1)
  }
}
// #endregion room

// #region server-built
/** The server can create a room with the same, typed, options. */
export async function openRace(server: BungohanServer) {
  // Passing the class (not its name) types the options from its contract.
  return server
    .getMatchMaker()
    .createRoom(RaceRoom, { track: "canyon", laps: 3 })
}
// #endregion server-built

// #region untyped
/** A room whose contract declares no options receives them untyped. */
export class SandboxRoom extends Room {
  public mode = "classic"

  protected override async onCreate(
    options: RoomOnCreateOptions & Record<string, unknown>,
  ): Promise<void> {
    // Anything MessagePack carries: narrow before use.
    if (typeof options["mode"] === "string") this.mode = options["mode"]
  }
}
// #endregion untyped
