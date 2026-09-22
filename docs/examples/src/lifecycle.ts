import {
  type Client,
  type ConnectionContext,
  createInt,
  createSchemaMap,
  createString,
  f,
  Room,
  type RoomOnCreateOptions,
  Schema,
  type TimerId,
} from "@bungohan/core"

export class Member extends Schema {
  public static override readonly schemaName = "Member"
  public name = createString("")
  public online = createString<"online" | "away">("online")
}

export class GuildState extends Schema {
  public static override readonly schemaName = "GuildState"
  public members = createSchemaMap(f.string, Member)
  public treasury = createInt(f.uint32)
}

/** Stand-in for real token verification (a JWT check, a session lookup). */
export async function verifyToken(
  token: string | undefined,
): Promise<{ userId: string; name: string } | undefined> {
  if (token === undefined || !token.startsWith("user:")) return undefined
  const userId = token.slice("user:".length)
  return { userId, name: userId }
}

// #region auth
export class GuildRoom extends Room<GuildState> {
  protected override state = new GuildState()
  public banned = new Set<string>()
  private saveTimer: TimerId | undefined

  /** Runs only when this join *creates* the room, before `onCreate`. */
  protected static override async onAuth(
    _client: Client,
    _options: Record<string, unknown>,
    context: ConnectionContext,
  ) {
    return (await verifyToken(context.token)) ?? false
  }

  /** Runs for every join into an existing room. */
  protected override async onAuth(
    _client: Client,
    _options: Record<string, unknown>,
    context: ConnectionContext,
  ) {
    const user = await verifyToken(context.token)
    if (user === undefined || this.banned.has(user.userId)) return false
    return user // becomes client.auth, and onJoin's third argument
  }
  // #endregion auth

  // #region create-join-leave
  protected override async onCreate(
    _options: RoomOnCreateOptions & Record<string, unknown>,
  ): Promise<void> {
    // Restore what a previous room saved (ok(undefined) if nothing was).
    const loaded = await this.loadState()
    if (loaded.isOk() && loaded.value !== undefined) this.state = loaded.value
    // Save every minute, on the server's clock.
    this.saveTimer = this.clock.setInterval(() => void this.saveState(), 60_000)
  }

  protected override async onJoin(
    client: Client,
    _options: Record<string, unknown>,
    auth: Record<string, unknown>,
  ): Promise<void> {
    const member = new Member()
    member.name.set(typeof auth["name"] === "string" ? auth["name"] : "?")
    this.state.members.set(client.sessionId, member)
    // Presence: per-seat data kept on the server, never sent to clients.
    this.setPresence(client.sessionId, { joinedAt: this.clock.now() })
  }

  /** `consented`: the client left on purpose (not a drop or a kick). */
  protected override async onLeave(
    client: Client,
    consented: boolean,
  ): Promise<void> {
    this.state.members.delete(client.sessionId)
    if (!consented) console.log(`${client.sessionId} dropped for good`)
  }

  protected override async onDispose(): Promise<void> {
    if (this.saveTimer !== undefined) this.clock.clearInterval(this.saveTimer)
    await this.saveState()
  }

  /** One saved guild, whatever room id it is loaded into. */
  protected override stateKey(): string {
    return "guild:main"
  }
  // #endregion create-join-leave

  // #region reconnect
  /** The connection dropped; the seat is held (30 s by default). */
  protected override onDisconnect(client: Client): void {
    this.state.members.get(client.sessionId)?.online.set("away")
  }

  /** Same `Client`, same sessionId, new connection. No onJoin runs. */
  protected override onReconnect(client: Client): void {
    this.state.members.get(client.sessionId)?.online.set("online")
  }
  // #endregion reconnect

  // #region pause
  /** Nobody connected, but a held seat may still come back. */
  protected override onPause(): void {
    console.log(`${this.id} paused: both loops stopped`)
  }

  protected override onResume(): void {
    console.log(`${this.id} resumed`)
  }
  // #endregion pause
}
