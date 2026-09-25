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
`defineRoomType`) is reachable by clients only by id. That makes it the
basis for invite codes: share the id, or publish a short code in the
room's metadata and look it up with `query`. Private hides a room from
clients' matchmaking, not from the server's: a lobby can still place
players in private rooms through [`where` pools and keys](#pools-and-keys).

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

Metadata is read when a query runs: change `this.metadata` any time
(a seat count, a phase) and the next `query` sees it, on this process
and on the others, which answer from their rooms as they are then. A
query returns as soon as every live process has answered. Two limits: a
process that doesn't answer within the collection window
(`cluster.gatherTimeout`, 200 ms by default) is missing from that
result, and a `RoomProxy` you hold keeps the metadata it was created
with until `refresh()`.

Get the matchmaker from `server.getMatchMaker()`, or `getMatchMaker()`
anywhere once the server exists.

On their own, `joinOrCreate` and `reserve` take the first available
room of the *type*. To keep players apart by mode, region or skill band
within one type, give them a `where` ([below](#pools-and-keys)), or pick
a room with `query` and hold a seat in it with
[`reserveById`](#reservations).

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

A seat taken from a reservation has `client.joinedBy === "reservation"`,
set by the server, so a room that admits only players its lobby placed
checks it:

<!-- snippet: docs/examples/src/matchmaking.ts#reserved-only -->
[`docs/examples/src/matchmaking.ts`](../examples/src/matchmaking.ts)

```ts
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
```
<!-- /snippet -->

`joinedBy` is otherwise `"join"` (an existing room, by id or through
matchmaking), `"create"` (the join created the room) or `"server"`
(`room.join(client)`). A reconnection keeps the seat's value.

Concurrent `reserve` calls need no queue: like `joinOrCreate`, one that
arrives while another is creating a room waits for that room, and takes a
seat in it if one is left.

To hold a seat in a room your code chose (with `query`, say), use
`reserveById`:

<!-- snippet: docs/examples/src/matchmaking.ts#reserve-by-id -->
[`docs/examples/src/matchmaking.ts`](../examples/src/matchmaking.ts)

```ts
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
```
<!-- /snippet -->

- `reserveById(roomId, joinOptions)` finds the room as `joinById`
  does, on any process: private rooms are fine, and so is a room on a
  draining process. A locked room is `ROOM_LOCKED`, a full one
  `ROOM_FULL`, a missing one `ROOM_NOT_FOUND`.
- The seat is then like any other reservation. Sending the client the
  room id instead would race other players to the last seat.

## Pools and keys

The server-side `joinOrCreate`, `reserve`, `createRoom` and `joinRoom`
take a `Placement` where they take a process selector. It narrows which
rooms they may pick.

**`where`** splits one room type into pools by metadata:

<!-- snippet: docs/examples/src/matchmaking.ts#pools -->
[`docs/examples/src/matchmaking.ts`](../examples/src/matchmaking.ts)

```ts
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
```
<!-- /snippet -->

- A room matches when its `metadata` has each `where` entry (`===`, as in
  `query`). Values are strings, numbers, booleans or `null`.
- A room created for the call starts with the `where` entries in its
  metadata, over the create options' own `metadata`. So pools can come
  from your database at run time, with no room type per pool. If
  `onCreate` or later code changes those entries, the room leaves the
  pool.
- Concurrent calls for the same pool create one room between them, on
  any process (see [scaling](scaling.md#one-room-per-pool)).
- Private rooms are in their pool too. A room type registered with
  `visibility: "private"` can serve `where` pools, so a lobby that
  reserves every seat keeps its rooms out of `query` and `GET /rooms`
  while still sharing them. Without a `where` (or a key), the pool is the
  one clients' `joinOrCreate` uses, which never picks a private room:
  each call creates a new one and takes its seat there.

**`key`** names one room of the type, for rooms that stand for
something outside the server (a record in your database, a scheduled
match):

<!-- snippet: docs/examples/src/matchmaking.ts#keys -->
[`docs/examples/src/matchmaking.ts`](../examples/src/matchmaking.ts)

```ts
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
```
<!-- /snippet -->

- At most one room of the type has a given key, across the cluster.
  `joinOrCreate` and `reserve` return or reserve in that room whether
  or not it's available: a full or locked one is `ROOM_FULL` or
  `ROOM_LOCKED`, never a second room. A private keyed room is fine.
- `createRoom` with a key that's taken fails with `ROOM_EXISTS`.
  `joinRoom` finds it without creating it.
- The room's `key` is set for its whole life and shows in `query`
  listings. Once the room is disposed, the key is free again.
- A key can't contain NUL or a lone surrogate (`INVALID_OPTIONS`).
- `process` in a `Placement` is the process selector, for where a room
  is created in [cluster mode](scaling.md).

Clients can't pass a `where` or a key: their joins carry join options,
and what a player may join is the server's call. Have a lobby reserve
the seat and hand the client the reservation.

## Server-side rooms

`matchMaker.createRoom(RoomClass, createOptions)` creates a room nobody
has joined yet, such as a lobby at startup. A room that nobody ever
joins stays until it's disposed, and `autoDispose` only applies once it has
had a seat. A join that fails (refused by `onAuth`, say) doesn't count:
it leaves the room as it was, so a stranger with the id can't get it
disposed. `matchMaker.joinOrCreate` and `joinRoom` return a room
without seating anyone, and `removeRoom(id)` disposes one.
`getAllRooms()`, `getRoom(id)`, `getRoomCount()` and `getClientCount()`
are about this process only.

## Next

- [client-js and React](client.md)
- [Scaling with cluster mode](scaling.md)
