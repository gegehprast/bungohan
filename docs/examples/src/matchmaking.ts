import {
  createString,
  defineContract,
  defineMessage,
  f,
  getMatchMaker,
  type InferCreateOptions,
  Room,
  type RoomOnCreateOptions,
  Schema,
} from "@bungohan/core"

export class MatchState extends Schema {
  public static override readonly schemaName = "MatchState"
  public map = createString("")
}

export const matchContract = defineContract({
  client: {},
  server: {},
  options: {
    create: defineMessage("matchCreate", { map: f.enum("dunes", "docks") }),
    join: defineMessage("matchJoin", { rating: f.uint16 }),
  },
})

// #region metadata
export class MatchRoom extends Room<MatchState, typeof matchContract> {
  public static override contract = matchContract
  protected override state = new MatchState()

  protected override async onCreate(
    options: RoomOnCreateOptions & InferCreateOptions<typeof matchContract>,
  ): Promise<void> {
    this.state.map.set(options.map)
    this.maxClients = 2
    // Metadata is what matchmaking can see of a room without joining it.
    this.metadata["map"] = options.map
  }

  protected override async onJoin(): Promise<void> {
    // A full match stops appearing to joinOrCreate and query.
    if (this.getClientCount() >= this.maxClients) this.lock()
  }
}
// #endregion metadata

// #region query
/** Open matches on one map, from every process in a cluster. */
export async function openMatches(map: "dunes" | "docks") {
  return getMatchMaker().query({
    type: "match",
    metadata: { map }, // exact match on metadata fields
    filters: [(room) => room.clients < room.maxClients],
    limit: 20,
  })
}
// #endregion query

export const Find = defineMessage("find", {})
export const Found = defineMessage("found", {
  id: f.string,
  roomId: f.string,
  roomType: f.string,
  sessionId: f.string,
  expiresAt: f.float64,
})

export const lobbyContract = defineContract({
  client: { find: Find },
  server: { found: Found },
})

// #region reserve
/**
 * Server-side matchmaking: the lobby decides where a player goes, holds
 * a seat there, and hands the client the reservation to consume.
 */
export class LobbyRoom extends Room<Schema, typeof lobbyContract> {
  public static override contract = lobbyContract

  protected override async onCreate(): Promise<void> {
    this.onMessage("find", async (client) => {
      // Concurrent calls are safe: a reserve() that arrives while another
      // is creating a match waits for that match instead of making one.
      const reserved = await getMatchMaker().reserve(
        MatchRoom,
        { rating: 1200 }, // the seat's join options
        undefined, // a process selector, in cluster mode
        { map: "dunes" }, // create options, if a room has to be created
      )
      if (reserved.isErr()) return // log it, tell the client…
      this.send(client, "found", reserved.value)
    })
  }
}
// #endregion reserve
