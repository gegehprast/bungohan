import {
  type AuthResult,
  type Client,
  type ConnectionContext,
  createFiltered,
  createNumber,
  createSchemaMap,
  createString,
  f,
  Room,
  type RoomClass,
  Schema,
} from "@bungohan/core"

export class Hero extends Schema {
  public static override readonly schemaName = "Hero"
  public owner = createString("") // a sessionId
  public name = createString("")
  public level = createNumber()
  // Only the hero's own player receives this.
  public quest = createFiltered(
    createString(""),
    function (this: Hero, client) {
      return this.owner.get() === client.sessionId
    },
  )
}

export class PartyState extends Schema {
  public static override readonly schemaName = "PartyState"
  public heroes = createSchemaMap(f.string, Hero)
}

// #region deps
/** What the party needs from outside: one per deployment, or per test. */
export interface Profiles {
  /** The player a session token belongs to, or undefined. */
  playerOf(token: string): Promise<string | undefined>
  /** The player's hero, or undefined if they haven't made one. */
  heroOf(playerId: string): Promise<{ name: string; level: number } | undefined>
}

/** Both onAuth hooks share this, so it takes the service as an argument. */
async function authenticate(
  profiles: Profiles,
  context: ConnectionContext,
): Promise<AuthResult> {
  if (context.token === undefined) return false
  const playerId = await profiles.playerOf(context.token)
  return playerId === undefined ? false : { playerId }
}

/** Builds the room class around its dependencies. */
export function createPartyRoom(
  profiles: Profiles,
): RoomClass<Room<PartyState>> {
  return class PartyRoom extends Room<PartyState> {
    protected override state = new PartyState()

    // Static hooks see `profiles` too, though no instance exists yet.
    protected static override onAuth(
      _client: Client,
      _options: Record<string, unknown>,
      context: ConnectionContext,
    ): Promise<AuthResult> {
      return authenticate(profiles, context)
    }

    protected override onAuth(
      _client: Client,
      _options: Record<string, unknown>,
      context: ConnectionContext,
    ): Promise<AuthResult> {
      return authenticate(profiles, context)
    }

    protected override async onJoin(
      client: Client,
      _options: Record<string, unknown>,
      auth: Record<string, unknown>,
    ): Promise<void> {
      const found = await profiles.heroOf(String(auth["playerId"]))
      // A throw refuses the join (JOIN_FAILED).
      if (found === undefined) throw new Error("no hero yet")
      const hero = new Hero()
      hero.owner.set(client.sessionId)
      hero.name.set(found.name)
      hero.level.set(found.level)
      this.state.heroes.set(client.sessionId, hero)
    }
  }
}
// #endregion deps

// #region http-profiles
/** The production service: another process, over HTTP. */
export function httpProfiles(baseUrl: string): Profiles {
  const get = async (path: string, token?: string): Promise<unknown> => {
    const response = await fetch(`${baseUrl}${path}`, {
      headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    })
    return response.ok ? response.json() : undefined
  }
  return {
    async playerOf(token) {
      const body = await get("/session", token)
      return typeof body === "object" && body !== null && "playerId" in body
        ? String(body.playerId)
        : undefined
    },
    async heroOf(playerId) {
      const body = await get(`/heroes/${encodeURIComponent(playerId)}`)
      if (typeof body !== "object" || body === null) return undefined
      if (!("name" in body) || !("level" in body)) return undefined
      const { name, level } = body
      return typeof name === "string" && typeof level === "number"
        ? { name, level }
        : undefined
    },
  }
}

// In the entry point:
//   server.defineRoomType("party", createPartyRoom(httpProfiles(PROFILES_URL)))
// #endregion http-profiles
