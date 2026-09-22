# Matchmaking

Matchmaking decides which room a player ends up in. Most games need
only the client's join methods. Server-side matchmaking (a lobby that
places players) uses reservations.

## From the client

| Method | Joins |
|---|---|
| `client.joinOrCreate(type, …)` | the first available room of the type, or a new one |
| `client.create(type, …)` | a new room, always |
| `client.join(type, …)` | an available room of the type, or fails with `ROOM_NOT_FOUND` |
| `client.joinById(roomId, …)` | that room, private rooms included |
| `client.consumeReservation(reservation, …)` | a seat the server reserved |
| `client.reconnect(roomId, token, …)` | a held seat, after a page reload (see the [client guide](client.md#resuming-after-a-reload)) |

"Available" means public, unlocked, not full, and not being disposed.
Concurrent joins don't overfill a room: the seat is taken before any of
your code runs. Nor does a concurrent `joinOrCreate` create a second room:
while one is creating a room, the others wait for it and then join it,
whether they come from clients or from the server's `matchMaker`
(`joinOrCreate`, `reserve`). If that room fills up before they get a seat,
or fails to create, they look again and create their own.

A private room (`makePrivate()`, or `visibility: "private"` in
`defineRoomType`) is reachable only by id. That makes it the basis for
invite codes: share the id, or publish a short code in the room's
metadata and look it up with `query`.

`joinById` fails with `ROOM_LOCKED`, `ROOM_FULL` or `ROOM_NOT_FOUND` as
the case may be. The other failures a join can return (`AUTH_FAILED`,
`CONTRACT_MISMATCH`, `RATE_LIMITED`, …) are listed in the `ClientErrorCode`
type.

## Metadata and queries

A room's state is private to it. What the rest of the server may know
about a room (its map, mode, host name) goes in `this.metadata`:

<!-- snippet: docs/examples/src/matchmaking.ts#metadata -->
[`docs/examples/src/matchmaking.ts`](../examples/src/matchmaking.ts)

```ts
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
```
<!-- /snippet -->

`matchMaker.query` lists ready rooms of a type, filtered on metadata and
by any function you like. In cluster mode it covers every process:

<!-- snippet: docs/examples/src/matchmaking.ts#query -->
[`docs/examples/src/matchmaking.ts`](../examples/src/matchmaking.ts)

```ts
/** Open matches on one map, from every process in a cluster. */
export async function openMatches(map: "dunes" | "docks") {
  return getMatchMaker().query({
    type: "match",
    metadata: { map }, // exact match on metadata fields
    filters: [(room) => room.clients < room.maxClients],
    limit: 20,
  })
}
```
<!-- /snippet -->

Each listing (`RoomListingInfo`) has `id`, `type`, `clients`,
`maxClients`, `visibility`, `locked`, `metadata`, `processId` and
`draining`. Private rooms are left out unless you pass
`includePrivate: true`, and rooms on a
[draining](scaling.md#draining-a-process) process unless you pass
`includeDraining: true`. Clients can't
query directly: a lobby room that sends them the list is the usual way.

Get the matchmaker from `server.getMatchMaker()`, or `getMatchMaker()`
anywhere once the server exists.

**Metadata doesn't steer `joinOrCreate` or `reserve`.** They take the
first available room of the *type*. To keep players apart by mode,
region or skill band, register a room type per pool (`"duel"`, `"squad"`),
or pick a room with `query` and send the client its id.

## Reservations

A reservation holds a seat for a player before they join, which is how a
server-side matchmaker places people. The lobby reserves, sends the
client the reservation, and the client consumes it:

<!-- snippet: docs/examples/src/matchmaking.ts#reserve -->
[`docs/examples/src/matchmaking.ts`](../examples/src/matchmaking.ts)

```ts
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
```
<!-- /snippet -->

<!-- snippet: docs/examples/src/matchmaking.client.ts#consume -->
[`docs/examples/src/matchmaking.client.ts`](../examples/src/matchmaking.client.ts)

```ts
export async function findMatch(client: IBungohanClient) {
  const joined = await client.joinOrCreate("lobby", undefined, {
    contract: lobbyContract,
  })
  if (joined.isErr()) return joined
  const lobby = joined.value

  const reservation = await new Promise<Reservation>((resolve) => {
    lobby.onMessage("found", resolve)
    lobby.send("find", {})
  })
  // Takes the reserved seat; its options were given when it was reserved.
  return client.consumeReservation(reservation, {
    state: MatchState,
    contract: matchContract,
  })
}
```
<!-- /snippet -->

- `reserve(RoomClass, joinOptions, processSelector?, createOptions?)`
  finds an available room of the type or creates one, and holds a seat
  under a new `sessionId`. Pass the class (not its name) to have the
  options typed.
- The seat counts against `maxClients` until it's consumed or expires
  (`reservationTimeout`, default 60 s). A late client gets
  `RESERVATION_EXPIRED`.
- When consumed, the room's instance `onAuth` and `onJoin` run with the
  options given at reservation time. The client's own options don't
  count.

Concurrent `reserve` calls need no queue: like `joinOrCreate`, one that
arrives while another is creating a room waits for that room, and takes a
seat in it if one is left.

## Server-side rooms

`matchMaker.createRoom(RoomClass, createOptions)` creates a room nobody
has joined yet, such as a lobby at startup. A room that nobody ever
joins stays until it's disposed, and `autoDispose` only applies once it has
had a seat. `matchMaker.joinOrCreate` and `joinRoom` return a room
without seating anyone, and `removeRoom(id)` disposes one.
`getAllRooms()`, `getRoom(id)`, `getRoomCount()` and `getClientCount()`
are about this process only.

## Next

- [client-js and React](client.md)
- [Scaling with cluster mode](scaling.md)
