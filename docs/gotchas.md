# Gotchas

The rules people actually hit, each with its fix.

## `schemaName` is required

Every Schema class needs its own static `schemaName`, its name on the
wire:

<!-- snippet: docs/examples/src/gotchas.ts#schemaname-bad -->
[`docs/examples/src/gotchas.ts`](examples/src/gotchas.ts)

```ts
// ✗ No schemaName: clients can't match the class by name.
export class Enemy extends Schema {
  public hp = createNumber(100)
}
```
<!-- /snippet -->

<!-- snippet: docs/examples/src/gotchas.ts#schemaname-good -->
[`docs/examples/src/gotchas.ts`](examples/src/gotchas.ts)

```ts
// ✓ Its own static schemaName, unique among the room's classes.
export class Monster extends Schema {
  public static override readonly schemaName = "Monster"
  public hp = createNumber(100)
}
```
<!-- /snippet -->

`defineRoomType` checks every class reachable from the room's state and
throws at startup (`TypeError: defineRoomType("…") is invalid: …`),
listing each problem. An inherited `schemaName` doesn't count, and two
classes in one room can't share a name. **Fix:** give each class its own
`public static override readonly schemaName = "…"`.

## Plain class fields are never synced

<!-- snippet: docs/examples/src/gotchas.ts#plain-field -->
[`docs/examples/src/gotchas.ts`](examples/src/gotchas.ts)

```ts
export class Tower extends Schema {
  public static override readonly schemaName = "Tower"

  public hp = 100 // ✗ a plain field: stays on the server, never synced
  public armor = createInt(f.uint8, 5) // ✓ a wrapper: synced
}
```
<!-- /snippet -->

Only fields created with the `create*` factories, and nested Schema
instances, are synchronized. A plain property changes on the server and
nowhere else, with no error. On the client, it keeps its initializer's
value. **Fix:** use a factory (`createInt(f.uint8, 100)`). Keep plain
fields for server-only data on purpose.

## A nested field owns its object exclusively

An instance held by a nested field can't be in a collection or another
nested field at the same time. The server refuses such an assignment,
leaves the field unchanged, and logs a `console.error`. It doesn't throw.
If you see that log, a move went in the wrong order. **Fix:** release,
then place:

<!-- snippet: docs/examples/src/state.ts#ownership -->
[`docs/examples/src/state.ts`](examples/src/state.ts)

```ts
/** Moves an item from the inventory into the hero's hands, correctly. */
export function equip(hero: Holder, id: number): boolean {
  const item = hero.bag.get(id)
  if (item === undefined) return false
  // A nested field owns its instance exclusively: release it from every
  // collection first, then assign it. (Same tick is fine.)
  hero.bag.delete(id)
  hero.hand = item
  return true
}

export class Holder extends Schema {
  public static override readonly schemaName = "Holder"
  public bag = createSchemaMap(f.uint32, Item)
  public hand = new Item()
}
```
<!-- /snippet -->

Collections, on the other hand, may share an instance.
[Why](guides/state.md#nested-objects-and-the-ownership-rule).

## Message handlers aren't awaited

Each handler is called as its message arrives, and the next message
doesn't wait for it. An `async` handler that awaits can therefore finish
**after** a later message's handler, even for the same client. **Fix:**
if order matters across an `await`, chain each client's work:

<!-- snippet: docs/examples/src/messages.ts#ordered -->
[`docs/examples/src/messages.ts`](examples/src/messages.ts)

```ts
/**
 * Handlers aren't awaited: if one awaits, a later message's handler can
 * run (and finish) first, even from the same client. Chain per client
 * when order matters.
 */
export class OrderedRoom extends Room<ChatState, typeof chatContract> {
  public static override contract = chatContract
  protected override state = new ChatState()
  private readonly queues = new Map<string, Promise<void>>()

  protected override async onCreate(): Promise<void> {
    this.onMessage("say", (client, message) =>
      this.inOrder(client, async () => {
        const clean = await moderate(this.clock, message.text) // slow, async
        const said = { from: client.sessionId, text: clean, at: 0 }
        this.broadcast("said", said)
      }),
    )
  }

  protected override async onLeave(client: Client): Promise<void> {
    this.queues.delete(client.sessionId)
  }

  /** Runs `work` after this client's previous work has finished. */
  private inOrder(client: Client, work: () => Promise<void>): Promise<void> {
    const previous = this.queues.get(client.sessionId) ?? Promise.resolve()
    const next = previous.then(work, work)
    this.queues.set(client.sessionId, next)
    return next
  }
}
```
<!-- /snippet -->

## Join options are only typed if you declare them

Without `options` in the contract, `onJoin` gets `Record<string,
unknown>`, and the client can send anything. **Fix:** declare them, and
both ends are typed and the server decodes them against the declaration:

<!-- snippet: docs/examples/src/options.ts#declare -->
[`docs/examples/src/options.ts`](examples/src/options.ts)

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

Then pass `{ create, join }` to `create`/`joinOrCreate` and the join
options alone to `join`/`joinById`. See
[Join and create options](guides/options.md).

## The contract goes on the class too

`Room<State, typeof contract>` types the room, but types vanish at run
time. The room also needs `public static override contract = contract`,
and the client needs `{ state, contract }` at every join. Forgetting the
static is a compile error at `defineRoomType`. Joining without it on the
client gives an untyped room, where typed `send` doesn't compile. Forcing
the type with type arguments instead (`joinOrCreate<State, typeof
contract>(…)`) compiles, but `send` then fails with `UNKNOWN_MESSAGE`,
because the contract object is what encodes the payload.

## Keep the room, not `room.state`

Every snapshot builds a new replica: after a reconnection, a server-side
state replacement, or a re-sync of a slow client. A saved `room.state`,
or listeners registered straight on its fields, go quiet after that.
**Fix:** read `room.state` when you need it, and register listeners with
`room.listen(state => …)` ([how](guides/client.md#listening-to-state)).

## Validate values, not types

Messages and options are decoded against their declarations, so their
*types* are guaranteed. Their *values* are whatever a (possibly hostile)
client sent. **Fix:** check game rules in every handler: lengths, ranges,
whose turn it is.

## Two `useRoom` joins under StrictMode

In development, `<StrictMode>` makes `useRoom` join twice, and with
`"create"` that creates two rooms. **Fix:** create from an event handler.
See [React and StrictMode](guides/client.md#react-and-strictmode).

## Other limitations

- **Nothing is replayed.** Messages sent to a client while it was
  reconnecting are lost, and it gets a fresh snapshot. Put anything that
  must survive a drop in the state.
- **Filters must be pure**, and they run every sync tick for every
  client. Don't move an instance across a filter boundary (from inside a
  filtered field to outside it, or back).
- **Ownership checks need an attached object.** An object you build and
  fill before attaching it to the state can't be checked until it's
  attached. Problems are then logged, not refused. `Schema.create(Class)`
  initializes an object at once, so it's checked from the start.
- **A Schema instance can't appear twice in one array** (maps and sets
  may share it).
- **Subclasses as collection elements** must be known to the client. It
  registers every class its state class declares. An element of a
  subclass declared nowhere is left out and reported as `UNKNOWN_CLASS`
  on `room.onError`. Import it and call `SchemaRegistry.register(Sub)`.
- **A stale client fails its join** with `CONTRACT_MISMATCH` after any
  contract change. Deploy client and server together.
- **Cluster mode** has a few more; see
  [Scaling](guides/scaling.md#limitations).
