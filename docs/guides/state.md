# State and schemas

A room's **state** is a tree of objects that the server owns and every
client mirrors. You change it on the server, and the framework works out
what changed and sends only that. This page covers how to declare it.

## Why factories, not types

State fields are created with factory functions:

<!-- snippet: docs/examples/src/state.ts#primitives -->
[`docs/examples/src/state.ts`](../examples/src/state.ts)

```ts
export class Stats extends Schema {
  public static override readonly schemaName = "Stats"

  public speed = createNumber(1.5) // float64: exact, 9 bytes on the wire
  public accuracy = createFloat32(0.5) // float32: ~7 significant digits
  public x = createFixedPoint(2) // 0.01 steps, 1–5 bytes
  public health = createInt(f.uint8, 100) // an integer 0…255, 1 byte
  public level = createInt(f.int32)
  public name = createString("")
  public team = createString<"red" | "blue">("red") // a string union
  public alive = createBoolean(true)
}
```
<!-- /snippet -->

Each factory returns a small **wrapper** object that holds the value.
The wrapper does three jobs a plain property can't:

1. **It records changes.** `x.set(5)` marks exactly that field of exactly
   that object as changed, so the next patch carries that one value and
   nothing else. No diffing of the whole tree, no re-sending of objects.
2. **It carries a runtime type.** `createFixedPoint(2)` tells the encoder
   to send a scaled integer, `createInt(f.uint8)` a single byte. TypeScript
   types are erased when compiled, so the declaration has to exist as a
   value for the server to know how to encode it, and for the client to
   decode it without any type tags on the wire.
3. **It notifies listeners**, on the client side as well
   (`onChange`, see [below](#listening-to-changes)).

There are no decorators and no `reflect-metadata`, so there is nothing to
configure in `tsconfig.json`. A field's TypeScript type is simply the
wrapper's: `createString<"red" | "blue">("red")` gives a `StringState`
that only accepts those two strings.

Read and write through `get()` and `set(value)`, or the `value` accessor
(`stats.level.value += 1`).

### `schemaName`

Every class needs its own `static schemaName`: its name on the wire. The
client uses it to know which of its classes to build. It must be a
static on that class itself (an inherited one doesn't count), and unique
among the classes a room uses. Don't rely on the JavaScript class name,
because bundlers minify it. A room whose state is missing one fails
`defineRoomType` at startup.

## Picking a number type

| Factory | Wire | Use it for |
|---|---|---|
| `createNumber()` | float64, 9 bytes | anything that must be exact, or whose range you don't know |
| `createFloat32()` | 4 bytes, ~7 significant digits | smooth values where a tiny error doesn't matter |
| `createFixedPoint(n)` | a zigzag integer, usually 1–3 bytes | positions, angles, anything with a known resolution (`n` decimal places, 0–9) |
| `createInt(f.int8 … f.uint32)` | the integer, 1 byte for 8-bit kinds | counts, health, scores, ids |

Fixed-point and float32 are **lossy on the wire only**. The server keeps
the exact value you set (so `x += vx * dt` accumulates correctly, even in
steps smaller than the resolution), and clients receive the rounded value.
A write that doesn't change the rounded value sends nothing at all. Fixed
point rounds half away from zero and saturates at the 32-bit integer
range: at 2 decimals that's ±21,474,836.47, which is plenty for a map in
pixels. Integers truncate toward zero and saturate at their kind's range,
so setting a `uint8` to 300 sends 255.

For a position, `createFixedPoint(1)` (0.1 px) or `createFixedPoint(2)`
(0.01 px) is almost always the right choice. Positions change constantly,
and this is where most of a game's bandwidth goes.

## Collections

<!-- snippet: docs/examples/src/state.ts#collections -->
[`docs/examples/src/state.ts`](../examples/src/state.ts)

```ts
export class Item extends Schema {
  public static override readonly schemaName = "Item"
  public label = createString("")
}

export class Inventory extends Schema {
  public static override readonly schemaName = "Inventory"

  // Primitive elements are declared with the `f` builders…
  public prices = createMap(f.string, f.fixed(2)) // MapState<string, number>
  public unlocked = createSet(f.uint16) // SetState<number>
  public log = createArray(f.string) // ArrayState<string>

  // …Schema elements with their class.
  public items = createSchemaMap(f.uint32, Item) // SchemaMapState<number, Item>
  public equipped = createSchemaSet(Item)
  public hotbar = createSchemaArray(Item)
}
```
<!-- /snippet -->

- **Primitive collections** take `f` builders for their elements:
  `f.float64`, `f.float32`, `f.fixed(n)`, `f.string` and `f.bool` as
  values. Integer kinds aren't value types: use `f.float64` (exact up to
  2^53) or `f.fixed(0)`.
- **Keys** (map keys and set elements) are exact, never rounded:
  `f.string`, `f.float64`, or an integer kind such as `f.uint32`. An
  integer key is much cheaper on the wire than a generated string id.
- **Schema collections** take the element class.

They work like their native counterparts, and every mutation is recorded
as it happens, so a patch carries "add key 7" rather than the whole map:

<!-- snippet: docs/examples/src/state.ts#collections-use -->
[`docs/examples/src/state.ts`](../examples/src/state.ts)

```ts
export function stock(inventory: Inventory): void {
  inventory.prices.set("sword", 12.5)
  inventory.unlocked.add(3)
  inventory.log.push("opened the shop")

  const sword = new Item()
  sword.label.set("Sword")
  inventory.items.set(1, sword)
  inventory.hotbar.push(sword) // collections may share an instance
}
```
<!-- /snippet -->

Maps have `get`, `set`, `delete`, `has`, `clear`, `size`, `keys()`,
`values()`, iteration and `forEach`. Arrays have `push`, `pop`, `shift`,
`unshift`, `splice`, `set(index, v)`, `sort`, `reverse` and the read
methods. Sets have `add`, `delete`, `has` and `clear`. For the complete
list, see the classes' types (`MapState`, `ArrayState`, `SetState` and
their `Schema*` variants) in `@bungohan/state`.

The same Schema instance may be held by several collections, or by one
map under several keys. It can't appear twice in one array.

## Nested objects, and the ownership rule

A field may hold another Schema instance directly:

<!-- snippet: docs/examples/src/state.ts#nested -->
[`docs/examples/src/state.ts`](../examples/src/state.ts)

```ts
export class Hero extends Schema {
  public static override readonly schemaName = "Hero"

  public stats = new Stats() // a nested Schema field
  public inventory = new Inventory()

  // Plain fields are never synchronized: server-only data lives here.
  public velocityX = 0
  public lastAttackAt = 0
}
```
<!-- /snippet -->

Replacing it (`hero.stats = new Stats()`) is synchronized too: clients get
the new object's full content.

**A nested field owns its instance exclusively.** An instance held by a
nested field can't also be in a collection or another nested field, and
the reverse. The reason is on the client side: each client keeps its own
object behind a nested field and updates it in place, so a second holder
of the same instance would silently stop receiving updates. Rather than
let that desync happen, the server refuses the assignment. The field (or
collection) is left unchanged, and it logs a `console.error` naming both
places. It doesn't throw, because this can happen in the middle of a
tick.

To move an instance, release it first, then place it (within one tick is
fine):

<!-- snippet: docs/examples/src/state.ts#ownership -->
[`docs/examples/src/state.ts`](../examples/src/state.ts)

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

These checks run from the moment an instance is part of a room's state.
An object you build before attaching it can't be checked while it's
detached. A problem found when it's attached is logged, not refused. If
you want it caught at the assignment instead, create the object with
`Schema.create(Holder)`, which initializes it at once.

## Plain fields are never synced

Only wrapper fields and nested Schema instances are part of the state.
Anything else on the class (a number, an array, a `Map`) stays on
whichever object it lives on. That is the intended home for server-only
data on a class both sides import: velocities, cooldowns, timestamps (see
`velocityX` in the example above). On the client, the same field just
keeps its initial value. Names starting with `_` are reserved for the
framework: don't use them for either kind.

## Per-client visibility

`createFiltered` wraps a field so that each client only receives it when
a filter says so:

<!-- snippet: docs/examples/src/state.ts#filtered -->
[`docs/examples/src/state.ts`](../examples/src/state.ts)

```ts
export class Card extends Schema {
  public static override readonly schemaName = "Card"

  public owner = createString("") // a sessionId
  public face = createString("") // visible to everyone
  // Only the owner's client receives this; others see "".
  public secret = createFiltered(
    createString(""),
    function (this: Card, client) {
      return this.owner.get() === client.id
    },
  )
}
```
<!-- /snippet -->

- The filter gets the client (its `id` is the `sessionId`) and runs
  with `this` as the instance. It must be pure and cheap: it runs on
  every sync tick, for every client, for every filtered field.
- When a field becomes visible to a client, that client receives its
  current value. When it becomes hidden, the client sees the zero value
  (`""`, `0`, `false`) or, for a collection, an empty one.
- A filter on a collection covers everything inside it. Filters nest:
  all of them must pass.
- A filter that throws counts as hidden, and is logged.
- Don't move an instance from inside a filtered subtree to outside it (or
  back). Clients that never saw it would receive only a reference to it.

Filtering has a cost only where you use it. Without filtered fields, one
patch is encoded once and sent to everyone. With them, clients that see
the same thing still share one encoded patch.

## Listening to changes

On the client, the replica's wrappers fire listeners after each patch is
applied:

- primitives: `field.onChange((value, previous) => …)`
- collections: `onAdd((value, key) => …)`, `onRemove((value, key) => …)`,
  and (maps and arrays) `onChange((value, previous, key) => …)` when an
  existing key or index is replaced. Note the order: value first, then
  key.

Each returns a function that removes the listener. Register them through
`room.listen(…)`, so they survive a reconnection. The
[client guide](client.md#listening-to-state) shows the pattern.

## Next

- [Messages and contracts](messages.md)
- [Gotchas](../gotchas.md)
