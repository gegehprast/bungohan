# Rooms and their lifecycle

A room is one running game: its state, its seats and its logic. You
extend `Room`, override the hooks you need, and register the class with
`server.defineRoomType(name, RoomClass, options?)`. The server creates
instances as clients ask for them. A room class takes no constructor
arguments.

Hooks are your code and may throw. The framework catches the error,
reports it to `server.onError` (with `context.source` naming the hook),
and carries on. One bad hook doesn't crash a room.

## The order of events

| When | Hook |
|---|---|
| a join creates the room | static `onAuth` → `onCreate` → `onJoin` |
| a join enters an existing room | `onAuth` → `onJoin` |
| every simulation step (60/s) | `onTick(deltaTime)` |
| before every state sync (20/s) | `onBeforeSync()` |
| a client leaves, is kicked, or its held seat expires | `onLeave(client, consented)` |
| a client's connection drops and its seat is held | `onDisconnect(client)` |
| a held seat's client comes back | `onReconnect(client)` |
| nobody connected, a held seat may come back | `onPause()` … `onResume()` |
| the room is disposed | `onDispose()` |

## Authentication

<!-- snippet: docs/examples/src/lifecycle.ts#auth -->
[`docs/examples/src/lifecycle.ts`](../examples/src/lifecycle.ts)

```ts
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
```
<!-- /snippet -->

- The client passes a token with `createBungohanClient({ url, token })`.
  It arrives as `context.token` (from `?token=` or an
  `Authorization: Bearer` header).
  `context` also has `ip`, `headers` and `searchParams`. Its type,
  `ConnectionContext`, comes from `@bungohan/core`.
- Return `false` to refuse (the client gets `AUTH_FAILED`), an object to
  admit *and* attach it as `client.auth`, or `true` to admit with a copy
  of the connection's auth ([below](#authenticating-a-connection-once);
  `{}` if the server doesn't set it).
- **The static `onAuth`** runs only when the join would *create* the
  room, before `onCreate`, since there is no instance yet. **The
  instance `onAuth`** runs for joins into an existing room, where it can
  look at the room's state.
- **Implement both if every join must be checked.** The default static
  `onAuth` admits everyone, so a room that overrides only the instance
  one lets the creating join in unchecked. `defineRoomType` logs a
  warning when it sees that. If what you check is who the player is,
  check it once in the server's
  [`authenticate`](#authenticating-a-connection-once) instead: it runs
  once per connection, and every join waits for it before either hook.
- `onAuth` runs for every join: each room a connection joins, and each
  reservation consumed. It doesn't run when a client
  [resumes a held seat](#reconnection); the reconnection token proves
  the seat. Every join on one connection sees the same `context.token`.
- A static method can't see the room's contract type, so declare the
  `options` parameter's type yourself.

The framework verifies nothing itself: checking tokens, rate-limiting
logins and serving over `wss://` in production are yours to do.

### Authenticating a connection once

`onAuth` runs for every join, so a credential that works only once (a
login ticket your web backend issued, redeemed with a Redis `GETDEL`)
would be spent by a player's first room and refused by the next. Check
it once per connection instead, with the server's `authenticate` option:

<!-- snippet: docs/examples/src/authenticate.ts#authenticate -->
[`docs/examples/src/authenticate.ts`](../examples/src/authenticate.ts)

```ts
/** Admits a connection whose `?token=` is an unused ticket, once. */
export function redeemTicket(tickets: Tickets) {
  return async (context: ConnectionContext): Promise<AuthResult> => {
    if (context.token === undefined) return false
    const userId = await tickets.redeem(context.token)
    return userId === undefined ? false : { userId }
  }
}

export function createGameServer(tickets: Tickets) {
  return createBungohanServer({ authenticate: redeemTicket(tickets) })
}
```
<!-- /snippet -->

- It runs once, when a connection opens, and gets the same `context` as
  `onAuth`. It returns what `onAuth` returns: an object (kept as
  `connection.auth`), `true` (`{}`) or `false`.
- Every join on the connection waits for it. If it refused, each join
  fails with `AUTH_FAILED`, and with `JOIN_FAILED` if it threw (reported
  to `server.onError` with `source: "authenticate"`). The connection
  stays open; the client reconnects to try other credentials.
- A room's `onAuth` returning `true`, which is what the default one
  does, gives the seat a copy of `connection.auth` as `client.auth`. A
  room that needs more reads `client.connection?.auth`:

<!-- snippet: docs/examples/src/authenticate.ts#rooms -->
[`docs/examples/src/authenticate.ts`](../examples/src/authenticate.ts)

```ts
/** No `onAuth`: every admitted connection may sit down. */
export class TableRoom extends Room {
  protected override async onJoin(client: Client): Promise<void> {
    // A copy of what authenticate returned.
    console.log(`${String(client.auth["userId"])} sat down`)
  }
}

/** Checks the connection's user without touching the ticket again. */
export class VipRoom extends Room {
  public static vips = new Set(["ada"])

  protected static override async onAuth(client: Client) {
    const userId = client.connection?.auth?.["userId"]
    // true: client.auth becomes a copy of the connection's auth.
    return typeof userId === "string" && VipRoom.vips.has(userId)
  }

  protected override async onAuth(client: Client) {
    return VipRoom.onAuth(client)
  }
}
```
<!-- /snippet -->

- In [cluster mode](scaling.md) it runs on the process that holds the
  socket, and its result travels with each join to the room's process,
  so a ticket is redeemed once wherever the rooms are. Return plain,
  serializable data.
- A reconnection is a new connection. Give the client a token *provider*
  so it fetches a fresh ticket each time
  ([client guide](client.md#one-time-tokens)).

## Creating, joining, leaving

<!-- snippet: docs/examples/src/lifecycle.ts#create-join-leave -->
[`docs/examples/src/lifecycle.ts`](../examples/src/lifecycle.ts)

```ts
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
```
<!-- /snippet -->

- **`this.state`** can be assigned as a field initializer or in
  `onCreate`. Replacing it later works too: every client gets a fresh
  snapshot of the new state at the next sync.
- **`onJoin`'s third argument** is what `onAuth` returned. Anything a
  handler sends to the joining client from `onJoin` reaches it right after
  its join succeeds.
- **`onLeave`'s `consented`** is `true` when the client left on purpose,
  and `false` for a kick, a dropped connection that can't be resumed, or a
  held seat that expired.
- **`this.clock`** is the server's clock. Use it for game timers
  (`setTimeout`, `setInterval`, `now()`) instead of the global timers, so
  tests can drive them.
- **`this.clients`** maps `sessionId` to `Client`, including seats still
  joining and seats held for reconnection. A `Client` has `sessionId`,
  `auth`, a free `userData` slot, `connected`, and `status`.

Other controls: `this.lock()` / `unlock()` (a locked room accepts no new
joins through matchmaking), `makePrivate()` / `makePublic()` (a private
room can only be joined by id), `disconnectClient(client, code?)` (a kick:
the client leaves this room, its connection stays open), `dispose()`, and
`setSimulationTickRate(fps)` / `setStateSyncTickRate(hz)`, which work
from `onCreate`. A room disposes itself when its last seat is released,
unless its type was registered with `autoDispose: false`.

## Reconnection

When a client's connection drops without it leaving, the server **holds
its seat**: the `Client` stays in the room with `connected === false`, it
receives nothing, and the others see no one leave. The client library
reconnects on its own with backoff (after 1 s, 2 s, 4 s, …), and on
success resumes as *the same* `Client`, with the same `sessionId`.
`onJoin` doesn't run again.

<!-- snippet: docs/examples/src/lifecycle.ts#reconnect -->
[`docs/examples/src/lifecycle.ts`](../examples/src/lifecycle.ts)

```ts
/** The connection dropped; the seat is held (30 s by default). */
protected override onDisconnect(client: Client): void {
  this.state.members.get(client.sessionId)?.online.set("away")
}

/** Same `Client`, same sessionId, new connection. No onJoin runs. */
protected override onReconnect(client: Client): void {
  this.state.members.get(client.sessionId)?.online.set("online")
}
```
<!-- /snippet -->

- `onDisconnect` is where you stop what the player was doing, such as
  their last input. Otherwise their character keeps walking during the
  grace period.
- If the seat isn't resumed within `reconnectionTimeout` seconds (default
  30), it's released with `onLeave(client, false)`.
- `allowReconnection: false` (in `defineRoomType` options) releases seats
  at once instead: a drop is then `onLeave(client, false)` directly, and
  `onDisconnect` doesn't run.
- Nothing is replayed. Messages sent while the client was away are lost,
  and it gets a full, fresh snapshot of the state when it comes back.

## Pausing

<!-- snippet: docs/examples/src/lifecycle.ts#pause -->
[`docs/examples/src/lifecycle.ts`](../examples/src/lifecycle.ts)

```ts
/** Nobody connected, but a held seat may still come back. */
protected override onPause(): void {
  console.log(`${this.id} paused: both loops stopped`)
}

protected override onResume(): void {
  console.log(`${this.id} resumed`)
}
```
<!-- /snippet -->

A room whose clients have all dropped, while at least one seat is held,
**pauses**: its simulation and sync loops stop, so `onTick` doesn't run.
It resumes when a held seat reconnects or someone new joins.

## Presence

`this.setPresence(sessionId, data)`, `getPresence`, `getAllPresence` and
`removePresence` keep a small per-seat record on the server: never sent
to clients, cleared when the seat is released. It's meant for code outside
the room, which can read it from the `Room` object. What clients should
see belongs in the state.

## Persistence

With a store configured (`store: { provider }` or `store: { config: { url } }`
for Redis, in `ServerOptions`), a room can save and load its state:

- `await this.saveState()` saves `this.state` (or the state you pass).
  Nothing saves automatically: what changed since your last call is lost
  in a crash.
- `await this.loadState()` returns a new instance of the current state's
  class, filled from the store, or `undefined` if nothing is saved.
  Assign it to `this.state`.
- Both return a `Result`, and both are no-ops (`ok(undefined)`) without a
  store.
- The key comes from `stateKey()`, by default `room:<type>:<id>:state`.

Only synchronized fields are saved, at full precision. Plain fields are
not.

### What survives a restart

**Room ids are random and never reissued.** After a restart, or on
another process, no room has the old id: `joinById` with it fails with
`ROOM_NOT_FOUND`, and the clients' reconnection tokens are void, since a
token names its room. The default `stateKey()` contains the id, so
nothing would ever load it again. What survives is the saved state,
under a key you choose:

- **Override `stateKey()`** with a key from your game, not the room id:
  one fixed key, as the example above does, or a world or match id
  taken from the create options in `onCreate`.
- **Bring the rooms back yourself.** On startup, create one room per
  saved key (`server.getMatchMaker().createRoom(WorldRoom, { worldId })`),
  and let its `onCreate` call `loadState()`. Put the key in
  `this.metadata` so clients can find the room with `query`.
- **Players join again as new seats.** Seats, presence, plain fields and
  timers aren't saved. Anything a player must not lose (progress,
  items) belongs in the saved state, not in a seat.

## Giving a room its dependencies

The server constructs rooms itself, with no arguments, so a room can't
take its services (a profile service, a database) through its
constructor. Build the class inside a function instead, and every hook
reads the dependencies from the closure. That includes the static
`onAuth`, which runs before any instance exists:

<!-- snippet: docs/examples/src/dependencies.ts#deps -->
[`docs/examples/src/dependencies.ts`](../examples/src/dependencies.ts)

```ts
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
```
<!-- /snippet -->

Each deployment passes its own:

<!-- snippet: docs/examples/src/dependencies.ts#http-profiles -->
[`docs/examples/src/dependencies.ts`](../examples/src/dependencies.ts)

```ts
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
```
<!-- /snippet -->

A test passes a fake, with no network involved (see
[testing](testing.md#real-io-in-join-hooks) for testing against the real
service). Keep the explicit `RoomClass<…>` return type: an inferred one
exposes `Room`'s internals, and a package that emits declaration files
fails to build with it (TS4094).

## Server callbacks

Besides the room hooks, the server reports events across all rooms:
`server.onConnect(connection)`, `server.onJoin(client, room)`,
`server.onLeave(client, room, consented)` and
`server.onError(error, context)`. `server.onJoin` doesn't fire for a
reconnection, since the seat never left. `server.getRoomManager()` adds
`onRoomCreated(room)` and `onRoomDisposed(room)`. Each returns an
unsubscribe function.

## Next

- [Matchmaking](matchmaking.md)
- [Testing](testing.md)
