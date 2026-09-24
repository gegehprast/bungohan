import {
  type Client,
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

// #region reserve-by-id
/** Holds a seat in the fullest open match on a map, not just any match. */
export async function reserveInFullest(map: "dunes" | "docks", rating: number) {
  const open = await openMatches(map)
  if (open.isErr()) return open
  const [fullest] = open.value.sort((a, b) => b.clients - a.clients)
  if (fullest === undefined) {
    return getMatchMaker().reserve(MatchRoom, { rating }, undefined, { map })
  }
  // ROOM_FULL if it filled up since the query: pick again.
  return getMatchMaker().reserveById(fullest.id, { rating })
}
// #endregion reserve-by-id

// #region pools
/** A seat in an open match of the player's band; one room type serves all. */
export function reserveInBand(band: "bronze" | "silver", rating: number) {
  return getMatchMaker().reserve(
    MatchRoom,
    { rating },
    // Only rooms whose metadata has band === `band`. One created for it
    // starts with { band } in its metadata, so the next call finds it.
    { where: { band } },
    { map: "dunes" },
  )
}
// #endregion pools

// #region keys
/**
 * The room for a scheduled match your database knows as `matchId`: found
 * wherever it runs, created the first time it's needed, never twice.
 */
export async function reserveInScheduled(matchId: string, rating: number) {
  return getMatchMaker().reserve(
    MatchRoom,
    { rating },
    { key: matchId }, // ROOM_FULL when that match is full, not a new room
    { map: "docks" },
  )
}
// #endregion keys

// #region reserved-only
/**
 * Only players the lobby placed. A room id can leak (a shared link, an
 * old listing); a reservation can't be made up.
 */
export class PlacedMatchRoom extends Room {
  protected static override async onAuth(client: Client) {
    return client.joinedBy === "reservation"
  }

  protected override async onAuth(client: Client) {
    return client.joinedBy === "reservation"
  }
}
// #endregion reserved-only
