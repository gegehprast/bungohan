# Join and create options

A client can send data with its join: its player name, the car it picked,
the settings for a room it is creating. Declared in the contract, those
options get what messages get: compile-time checking on both ends, and
decoding against the declaration instead of trust.

## Two kinds

- **Join options** come with every join: what a joiner tells the room
  about itself.
- **Create options** come only with a join that creates the room (the
  `create` and `joinOrCreate` modes): the settings for that new room.
  A `joinOrCreate` that finds an existing room never reads them.

<!-- snippet: docs/examples/src/options.ts#declare -->
[`docs/examples/src/options.ts`](../examples/src/options.ts)

```ts
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
```
<!-- /snippet -->

Declare either one, or both. When only one is declared, the other is a
message with no fields. `InferJoinOptions`, `InferCreateOptions` and
`CreateArg` give you their types.

## In the room

<!-- snippet: docs/examples/src/options.ts#room -->
[`docs/examples/src/options.ts`](../examples/src/options.ts)

```ts
export class RaceRoom extends Room<RaceState, typeof raceContract> {
  public static override contract = raceContract
  public override state = new RaceState()

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
```
<!-- /snippet -->

`onCreate` receives the create options merged with the framework's own
settings (`roomId`, `roomType`, `maxClients`, `metadata`, …). For that
reason a create option can't use one of those names: `defineRoomType`
refuses it at startup. `onAuth` and `onJoin` receive the join options.

As with messages, **the shape is guaranteed and the values are not.**
`laps` is certainly a `uint8`, but "0 laps" or "250 laps" is for your
code to refuse or clamp.

## From the client

<!-- snippet: docs/examples/src/options.client.ts#client -->
[`docs/examples/src/options.client.ts`](../examples/src/options.client.ts)

```ts
const race = { state: RaceState, contract: raceContract }

/** Creating modes take `{ create, join }`. */
export function hostRace(client: IBungohanClient, driver: string) {
  return client.create(
    "race",
    { create: { track: "oval", laps: 5 }, join: { driver } },
    race,
  )
}

/** Joining modes take the join options alone. */
export function joinRace(client: IBungohanClient, id: string, driver: string) {
  return client.joinById(id, { driver, car: "red" }, race)
}
```
<!-- /snippet -->

| Method | Options argument |
|---|---|
| `create`, `joinOrCreate` | `{ create, join }` when create options are declared; else the join options |
| `join`, `joinById` | the join options |

With declared options, the third argument (`{ state, contract }`) is
required, since the contract is what the options are encoded with.
Options that got past the types some other way fail locally with
`ENCODE_FAILED`, before anything is sent. A client whose options don't
match the server's declaration (it was built against an older contract)
fails with `CONTRACT_MISMATCH`.

## Options the server builds

The server can create rooms and reserve seats itself. Pass the room
**class** rather than its name, and the options are typed from its
contract:

<!-- snippet: docs/examples/src/options.ts#server-built -->
[`docs/examples/src/options.ts`](../examples/src/options.ts)

```ts
/** The server can create a room with the same, typed, options. */
export async function openRace(server: BungohanServer) {
  // Passing the class (not its name) types the options from its contract.
  return server
    .getMatchMaker()
    .createRoom(RaceRoom, { track: "canyon", laps: 3 })
}
```
<!-- /snippet -->

Server-built options go through the same encoding as a client's, so the
room receives exactly what the same options from a client would produce
(integers saturated, fixed-point rounded). Options that don't fit are an
`INVALID_OPTIONS` error, not a throw.

## Untyped options

A contract that declares no options (or a room with no contract) receives
whatever the client sent, as a plain object:

<!-- snippet: docs/examples/src/options.ts#untyped -->
[`docs/examples/src/options.ts`](../examples/src/options.ts)

```ts
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
```
<!-- /snippet -->

That's the escape hatch for dynamic data, and it costs you the narrowing.
Declare options as soon as their shape settles: a room that picks values
out by string key and checks each `typeof` is exactly what the
declaration saves you from.

## Next

- [Rooms and their lifecycle](rooms.md)
- [Matchmaking](matchmaking.md)
