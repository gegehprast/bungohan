# Tutorial: Gem Grab

This tutorial builds a small, complete multiplayer game: players move
around a shared arena with the arrow keys (or WASD), and whoever walks
over a gem scores it. It takes you through every part of a Bungohan game:

1. [The state](#1-the-state)
2. [The contract](#2-the-contract)
3. [The room](#3-the-room)
4. [The server](#4-the-server)
5. [A browser client](#5-a-browser-client)
6. [The same client in React](#6-the-same-client-in-react)
7. [A test](#7-a-test)

The finished game is in the repository at
[`apps/tutorial/`](../apps/tutorial/), and every code block below is
copied from it. Its tests run with the rest of the repository's, so the
code here is code that compiles and works.

To play it from a checkout of the repository:

```sh
bun install
bun --filter @bungohan/tutorial-server dev      # ws://localhost:6060
bun --filter @bungohan/tutorial-client dev      # the page, vanilla version
bun --filter @bungohan/tutorial-client dev:react # the page, React version
```

Open the page in two tabs (add `?name=Ada` to the URL to pick a name) and
walk around in both.

## The layout

```text
apps/tutorial/
  shared/   state and contract: imported by the server AND the client
  server/   the room, the server entry point, the tests
  client/   the browser client, vanilla and React
```

The shared package is the important idea. The server and the client
import the same classes and declarations directly, with no build step or
generated code, so they can't drift apart. In your own project it can be
a folder, a workspace package, or anything both sides can import. Its
one dependency is `@bungohan/client-js`, which runs on the server as well
as in the browser and exports `Schema`, the field factories, `f` and
`defineContract`. The server adds `@bungohan/core`, and the client uses
`@bungohan/client-js` itself (and `react` for step 6).

Some constants both sides use:

<!-- snippet: apps/tutorial/shared/src/constants.ts#constants -->
[`apps/tutorial/shared/src/constants.ts`](../apps/tutorial/shared/src/constants.ts)

```ts
export const ARENA = {
  WIDTH: 800,
  HEIGHT: 600,
  /** Pixels per second. */
  PLAYER_SPEED: 200,
  /** How close a player must get to pick a gem up. */
  PICKUP_RADIUS: 20,
} as const

export const ROOM_TYPE = "arena"
export const DEFAULT_PORT = 6060
```
<!-- /snippet -->

## 1. The state

The state is what every player sees: here, the players and the gems.

<!-- snippet: apps/tutorial/shared/src/state.ts#imports -->
[`apps/tutorial/shared/src/state.ts`](../apps/tutorial/shared/src/state.ts)

```ts
import {
  createFixedPoint,
  createInt,
  createSchemaMap,
  createString,
  f,
  Schema,
} from "@bungohan/schema"
```
<!-- /snippet -->

<!-- snippet: apps/tutorial/shared/src/state.ts#player -->
[`apps/tutorial/shared/src/state.ts`](../apps/tutorial/shared/src/state.ts)

```ts
export class Player extends Schema {
  public static override readonly schemaName = "Player"

  public name = createString("")
  // Fixed-point with one decimal: 0.1 px is plenty for drawing, and it
  // costs 1–3 bytes on the wire instead of a 9-byte float.
  public x = createFixedPoint(1)
  public y = createFixedPoint(1)
  public score = createInt(f.uint16)
}
```
<!-- /snippet -->

A few things to notice:

- **Fields are created with factories**, not declared with types or
  decorators. `createString("")` returns a small wrapper object that
  holds the value, records every change, and notifies listeners. The
  wrapper is how the server knows exactly which field changed, so it can
  send that field alone. You read and write it with `get()` and `set()`.
- **Pick the narrowest type that fits.** `createFixedPoint(1)` stores a
  number with one decimal. On the wire it becomes a small integer (1–3
  bytes instead of a 9-byte float), and positions change on nearly every
  tick. `createInt(f.uint16)` is a whole number from 0 to 65,535. The
  server keeps full precision internally, and clients see the rounded
  value.
- **`schemaName` is required.** It's the class's name on the wire, and it
  must be the class's own static property. The JavaScript class name
  won't do, because minifiers rename classes.

<!-- snippet: apps/tutorial/shared/src/state.ts#gem -->
[`apps/tutorial/shared/src/state.ts`](../apps/tutorial/shared/src/state.ts)

```ts
export class Gem extends Schema {
  public static override readonly schemaName = "Gem"

  public x = createFixedPoint(1)
  public y = createFixedPoint(1)
}
```
<!-- /snippet -->

<!-- snippet: apps/tutorial/shared/src/state.ts#arena-state -->
[`apps/tutorial/shared/src/state.ts`](../apps/tutorial/shared/src/state.ts)

```ts
export class ArenaState extends Schema {
  public static override readonly schemaName = "ArenaState"

  /** Keyed by the player's `sessionId`. */
  public players = createSchemaMap(f.string, Player)
  /** Keyed by a small integer id: cheaper on the wire than a string. */
  public gems = createSchemaMap(f.uint32, Gem)
}
```
<!-- /snippet -->

`createSchemaMap(f.string, Player)` is a map from strings to `Player`
instances. The key and element types are passed as values (`f.string`,
`Player`), not only as type parameters, because the server needs them at
runtime to encode the map. TypeScript infers the map's type from them.
Gems are keyed by a small integer (`f.uint32`) because an integer key
costs a byte or two on every add and remove, where a generated string id
would cost twenty.

More on fields, collections and their rules:
[State and schemas](guides/state.md).

## 2. The contract

The contract lists the messages each side may send, and the options a
client passes when it joins:

<!-- snippet: apps/tutorial/shared/src/contract.ts#contract -->
[`apps/tutorial/shared/src/contract.ts`](../apps/tutorial/shared/src/contract.ts)

```ts
import {
  defineContract,
  defineMessage,
  f,
  type InferCreateOptions,
  type InferJoinOptions,
} from "@bungohan/schema"

/** Client → server: which way the player is holding the keys. */
export const Move = defineMessage("move", { dx: f.int8, dy: f.int8 })

/** Server → client: someone picked up a gem. */
export const GemCollected = defineMessage("gemCollected", {
  sessionId: f.string,
  score: f.uint16,
})

export const arenaContract = defineContract({
  client: { move: Move },
  server: { gemCollected: GemCollected },
  options: {
    /** Sent only by the client whose join creates the room. */
    create: defineMessage("arenaCreateOptions", { gems: f.uint8 }),
    /** Sent by every client that joins. */
    join: defineMessage("arenaJoinOptions", { name: f.string }),
  },
})

export type ArenaCreateOptions = InferCreateOptions<typeof arenaContract>
export type ArenaJoinOptions = InferJoinOptions<typeof arenaContract>
```
<!-- /snippet -->

- **`client`** messages go from clients to the server (the player's
  input), and **`server`** messages go the other way (announcements).
- **`options`** are what a client sends with its join. `join` options
  come with every join (the player's name), and `create` options only
  with a join that creates the room (how many gems it should have).
- `f.int8`, `f.uint16`, `f.string`, … are the field types. They are
  exact: a `dx` sent as `f.int8` arrives as an integer from -128 to 127,
  whatever the client code did.

This declaration gives you compile-time checking on both ends:
`room.send("move", { dx: "left" })` doesn't compile, on the server or the
client. There is no validation at run time, because none is needed to
guarantee the *types*: a message is decoded from compact binary using
this same declaration, so a field declared as a number can only come out
as a number. What the declaration can't know is what's *sensible*. An
`int8` can be 127, but a player shouldn't move 127 times faster. The room
checks that part, as you'll see next.

More: [Messages and contracts](guides/messages.md),
[Join and create options](guides/options.md).

## 3. The room

The room is where the game runs: it owns the state, reacts to players
joining and leaving, handles their messages, and steps the simulation.

<!-- snippet: apps/tutorial/server/src/ArenaRoom.ts#imports -->
[`apps/tutorial/server/src/ArenaRoom.ts`](../apps/tutorial/server/src/ArenaRoom.ts)

```ts
import { type Client, Room, type RoomOnCreateOptions } from "@bungohan/core"
import {
  ARENA,
  type ArenaCreateOptions,
  type ArenaJoinOptions,
  ArenaState,
  arenaContract,
  Gem,
  Player,
} from "@bungohan/tutorial-shared"
```
<!-- /snippet -->

<!-- snippet: apps/tutorial/server/src/ArenaRoom.ts#class -->
[`apps/tutorial/server/src/ArenaRoom.ts`](../apps/tutorial/server/src/ArenaRoom.ts)

```ts
export class ArenaRoom extends Room<ArenaState, typeof arenaContract> {
  // The contract, again, as a value: the type parameter is erased at
  // runtime, and the server needs the descriptors to decode messages.
  public static override contract = arenaContract
  // The synchronized state. Tests read it with the harness's `stateOf`.
  protected override state = new ArenaState()

  // Server-only bookkeeping: plain fields, never sent to anyone.
  private readonly directions = new Map<string, Direction>()
  private gemCount = 5
  private nextGemId = 0
```
<!-- /snippet -->

`Room<ArenaState, typeof arenaContract>` gives the room its state type
and its contract. That is what types `this.state`, `onMessage`, `send`
and `broadcast`. The contract is also assigned to `static contract`,
because TypeScript types don't exist at run time and the server needs the
declaration itself to decode messages. Forgetting it is a compile error
where you register the room.

`directions` is a plain `Map` on the room: server-side bookkeeping that
no client ever sees. Only the state's wrapper fields are synchronized.

### Creating the room

<!-- snippet: apps/tutorial/server/src/ArenaRoom.ts#on-create -->
[`apps/tutorial/server/src/ArenaRoom.ts`](../apps/tutorial/server/src/ArenaRoom.ts)

```ts
protected override async onCreate(
  options: RoomOnCreateOptions & ArenaCreateOptions,
): Promise<void> {
  // The type guarantees a uint8; how many gems make sense is game logic.
  this.gemCount = Math.min(Math.max(options.gems, 1), 20)
  for (let i = 0; i < this.gemCount; i++) this.spawnGem()

  this.onMessage("move", (client, { dx, dy }) => {
    // An int8 can be anything from -128 to 127: keep only the sign.
    this.directions.set(client.sessionId, {
      dx: Math.sign(dx),
      dy: Math.sign(dy),
    })
  })
}
```
<!-- /snippet -->

`onCreate` runs once, when the first join creates the room. Its options
are the framework's own settings (`roomId`, `maxClients`, …) merged with
the contract's create options, already decoded and typed.

`onMessage("move", …)` registers the handler for the `move` message. The
payload is typed from the contract (`{ dx: number; dy: number }`), and
the handler only records the direction. The movement itself happens in
the game loop, which keeps the simulation independent of how often
inputs arrive.

### Joining and leaving

<!-- snippet: apps/tutorial/server/src/ArenaRoom.ts#on-join -->
[`apps/tutorial/server/src/ArenaRoom.ts`](../apps/tutorial/server/src/ArenaRoom.ts)

```ts
protected override async onJoin(
  client: Client,
  options: ArenaJoinOptions,
): Promise<void> {
  const player = new Player()
  player.name.set(options.name.trim().slice(0, 16) || "Anonymous")
  player.x.set(Math.random() * ARENA.WIDTH)
  player.y.set(Math.random() * ARENA.HEIGHT)
  this.state.players.set(client.sessionId, player)
}

protected override async onLeave(client: Client): Promise<void> {
  this.state.players.delete(client.sessionId)
  this.directions.delete(client.sessionId)
}

/** The connection dropped; the seat is held for 30 s by default. */
protected override onDisconnect(client: Client): void {
  // Stop them walking while they're away.
  this.directions.delete(client.sessionId)
}
```
<!-- /snippet -->

`onJoin` gets the join options (typed from the contract) and adds a
`Player` to the state. That's all it takes for every client, the new one
included, to see the new player. `onLeave` removes it again.

`onDisconnect` is for a connection that *dropped*. The player hasn't left:
by default the server holds their seat for 30 seconds, and if their
client reconnects in time, they carry on as the same player. Meanwhile,
the room stops them walking. See
[Rooms and their lifecycle](guides/rooms.md) for all the hooks.

### The game loop

<!-- snippet: apps/tutorial/server/src/ArenaRoom.ts#on-tick -->
[`apps/tutorial/server/src/ArenaRoom.ts`](../apps/tutorial/server/src/ArenaRoom.ts)

```ts
  protected override onTick(deltaTime: number): void {
    const step = (ARENA.PLAYER_SPEED * deltaTime) / 1000
    for (const [sessionId, player] of this.state.players) {
      const direction = this.directions.get(sessionId)
      if (direction === undefined) continue
      player.x.set(clamp(player.x.get() + direction.dx * step, ARENA.WIDTH))
      player.y.set(clamp(player.y.get() + direction.dy * step, ARENA.HEIGHT))
      this.collectGems(sessionId, player)
    }
  }

  private collectGems(sessionId: string, player: Player): void {
    for (const [id, gem] of this.state.gems) {
      const distance = Math.hypot(
        gem.x.get() - player.x.get(),
        gem.y.get() - player.y.get(),
      )
      if (distance > ARENA.PICKUP_RADIUS) continue
      this.state.gems.delete(id)
      this.spawnGem()
      player.score.set(player.score.get() + 1)
      this.broadcast("gemCollected", { sessionId, score: player.score.get() })
    }
  }

  private spawnGem(): void {
    const gem = new Gem()
    gem.x.set(Math.random() * ARENA.WIDTH)
    gem.y.set(Math.random() * ARENA.HEIGHT)
    this.state.gems.set(this.nextGemId++, gem)
  }
}

function clamp(value: number, max: number): number {
  return Math.min(Math.max(value, 0), max)
}
```
<!-- /snippet -->

`onTick` runs 60 times a second with a fixed `deltaTime` in
milliseconds. The server sends state 20 times a second on its own
schedule, so three ticks of movement go out as one patch holding only
the fields that changed. A player standing still costs nothing, and an
idle room sends nothing at all.

`this.broadcast("gemCollected", …)` sends a contract message to every
client in the room. The payload is checked against the contract at
compile time.

## 4. The server

<!-- snippet: apps/tutorial/server/src/index.ts#server -->
[`apps/tutorial/server/src/index.ts`](../apps/tutorial/server/src/index.ts)

```ts
import { createBungohanServer } from "@bungohan/core"
import { DEFAULT_PORT, ROOM_TYPE } from "@bungohan/tutorial-shared"
import { ArenaRoom } from "./ArenaRoom"

const port = Number(process.env["PORT"] ?? DEFAULT_PORT)

const server = createBungohanServer({ transport: { config: { port } } })
server.defineRoomType(ROOM_TYPE, ArenaRoom, { maxClients: 16 })

server.onJoin((client, room) => {
  console.log(`${client.sessionId} joined ${room.roomType} ${room.id}`)
})
server.onError((error, context) => {
  console.error(`error in ${context.source}:`, error)
})

// start() returns a Result instead of throwing.
const started = await server.start()
if (started.isErr()) {
  console.error("could not start:", started.error.message)
  process.exit(1)
}
console.log(`Gem Grab server on ws://localhost:${port}`)
// Ctrl+C (SIGINT) or SIGTERM stops it gracefully.
```
<!-- /snippet -->

`defineRoomType` registers the room under a name that clients join by,
with per-type options (`maxClients` here). It also checks the room's
state classes and contract once, at startup, and throws if something is
malformed, such as a missing `schemaName`. That is deliberate: better to
crash on boot than to desync every client later.

`start()` returns a `Result` rather than throwing, like every framework
operation that can fail. Run it with `bun src/index.ts` (or the `dev`
script, which restarts on changes).

## 5. A browser client

The client joins a room, sends the player's input, and draws the state.
First, what every join passes:

<!-- snippet: apps/tutorial/client/src/arena.ts#join -->
[`apps/tutorial/client/src/arena.ts`](../apps/tutorial/client/src/arena.ts)

```ts
import type { IBungohanClient, IRoom } from "@bungohan/client-js"
import { ArenaState, arenaContract, ROOM_TYPE } from "@bungohan/tutorial-shared"

/**
 * What every join passes: the state class (to build the local replica)
 * and the contract (to type and encode messages and options).
 */
export const arenaJoin = { state: ArenaState, contract: arenaContract }

/** The room type TypeScript infers from `arenaJoin`. */
export type ArenaRoom = IRoom<ArenaState, typeof arenaContract>

/** Create options (used only if this join creates the room), then ours. */
export function arenaOptions(name: string) {
  return { create: { gems: 5 }, join: { name } }
}

export function joinArena(client: IBungohanClient, name: string) {
  return client.joinOrCreate(ROOM_TYPE, arenaOptions(name), arenaJoin)
}
```
<!-- /snippet -->

`arenaJoin` hands the client the state class and the contract as values.
From the state class it builds its local copy of the state (the
*replica*); from the contract it encodes messages and options. The room
it returns is fully typed (`ArenaRoom` is what TypeScript infers), so
`room.state.players` is a map of `Player` and `room.send("move", …)` is
checked.

`joinOrCreate` joins an available arena or creates one. Because the
contract declares both kinds of options, it takes `{ create, join }`, and
`create` is only read if a room is actually created.

The keyboard, which sends a `move` only when the direction changes:

<!-- snippet: apps/tutorial/client/src/input.ts#input -->
[`apps/tutorial/client/src/input.ts`](../apps/tutorial/client/src/input.ts)

```ts
export interface Direction {
  dx: number
  dy: number
}

const KEYS: Record<string, Direction> = {
  ArrowUp: { dx: 0, dy: -1 },
  ArrowDown: { dx: 0, dy: 1 },
  ArrowLeft: { dx: -1, dy: 0 },
  ArrowRight: { dx: 1, dy: 0 },
  w: { dx: 0, dy: -1 },
  s: { dx: 0, dy: 1 },
  a: { dx: -1, dy: 0 },
  d: { dx: 1, dy: 0 },
}

/** The direction a set of held keys points in (each axis -1, 0 or 1). */
export function directionOf(held: Iterable<string>): Direction {
  let dx = 0
  let dy = 0
  for (const key of held) {
    dx += KEYS[key]?.dx ?? 0
    dy += KEYS[key]?.dy ?? 0
  }
  return { dx: Math.sign(dx), dy: Math.sign(dy) }
}

/**
 * Calls `onChange` whenever the held keys point somewhere new, and only
 * then: sending on every keydown repeat would waste bandwidth.
 */
export function watchKeys(onChange: (direction: Direction) => void) {
  const held = new Set<string>()
  let last: Direction = { dx: 0, dy: 0 }
  const update = () => {
    const next = directionOf(held)
    if (next.dx === last.dx && next.dy === last.dy) return
    last = next
    onChange(next)
  }
  const down = (event: KeyboardEvent) => {
    held.add(event.key)
    update()
  }
  const up = (event: KeyboardEvent) => {
    held.delete(event.key)
    update()
  }
  window.addEventListener("keydown", down)
  window.addEventListener("keyup", up)
  return () => {
    window.removeEventListener("keydown", down)
    window.removeEventListener("keyup", up)
  }
}
```
<!-- /snippet -->

And the page itself:

<!-- snippet: apps/tutorial/client/src/main.ts#vanilla -->
[`apps/tutorial/client/src/main.ts`](../apps/tutorial/client/src/main.ts)

```ts
import { createBungohanClient } from "@bungohan/client-js"
import { joinArena } from "./arena"
import { drawArena } from "./draw"
import { watchKeys } from "./input"
import { playerName, SERVER_URL } from "./url"

const canvas = document.querySelector("canvas")
const status = document.querySelector("#status")
const ctx = canvas?.getContext("2d")
if (!ctx || !status) throw new Error("index.html is missing its elements")

const client = createBungohanClient({ url: SERVER_URL })
// Closing the tab is leaving; otherwise the server would hold the seat
// for a reconnection that never comes.
window.addEventListener("pagehide", () => void client.disconnect())

async function main(ctx: CanvasRenderingContext2D, status: Element) {
  // Resolves once the first state snapshot is in: room.state is filled.
  const joined = await joinArena(client, playerName())
  if (joined.isErr()) {
    status.textContent = `Could not join: ${joined.error.message}`
    return
  }
  const room = joined.value
  status.textContent = `Joined room ${room.id}`

  const stopKeys = watchKeys((direction) => room.send("move", direction))

  room.onMessage("gemCollected", ({ sessionId, score }) => {
    const who = room.state.players.get(sessionId)?.name.get() ?? sessionId
    status.textContent = `${who} has ${score} gems`
  })

  room.onLeave((code) => {
    stopKeys()
    status.textContent = `Left the room (code ${code})`
  })

  // Read room.state every frame, not a saved reference: a reconnection
  // replaces the replica with a fresh object.
  const frame = () => {
    drawArena(ctx, room.state, room.sessionId)
    if (room.status !== "left") requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
}

void main(ctx, status)
```
<!-- /snippet -->

- The join resolves once the room's first snapshot has arrived, so
  `room.state` is already filled in when you get the room.
- The drawing code ([`draw.ts`](../apps/tutorial/client/src/draw.ts))
  reads `room.state` each animation frame. The replica is updated in place
  as patches arrive, so there is nothing to copy.
- Always go through `room.state`, never keep a reference to it. After a
  reconnection the client builds a fresh replica from a new snapshot.
- `room.onMessage` is typed from the contract's `server` side. Handlers
  registered right after the join still receive messages the room sent
  during `onJoin`.

The page is plain HTML ([`index.html`](../apps/tutorial/client/index.html))
with a `<canvas>`, served by Bun's bundler (`bun ./index.html`). Any
bundler works.

## 6. The same client in React

`@bungohan/client-js/react` provides a context and hooks. The client is
created once, outside React, and provided to the tree:

<!-- snippet: apps/tutorial/client/src/react/main.tsx#provider -->
[`apps/tutorial/client/src/react/main.tsx`](../apps/tutorial/client/src/react/main.tsx)

```tsx
import { createBungohanClient } from "@bungohan/client-js"
import { BungohanProvider } from "@bungohan/client-js/react"
import { createRoot } from "react-dom/client"
import { playerName, SERVER_URL } from "../url"
import { App } from "./App"

// One client for the whole app, created outside React so a re-render
// never opens a second connection.
const client = createBungohanClient({ url: SERVER_URL })
window.addEventListener("pagehide", () => void client.disconnect())

const root = document.getElementById("root")
if (root === null) throw new Error("react.html has no #root element")

createRoot(root).render(
  <BungohanProvider client={client}>
    <App name={playerName()} />
  </BungohanProvider>,
)
```
<!-- /snippet -->

`useRoom` joins when the component mounts and leaves when it unmounts:

<!-- snippet: apps/tutorial/client/src/react/App.tsx#app -->
[`apps/tutorial/client/src/react/App.tsx`](../apps/tutorial/client/src/react/App.tsx)

```tsx
import {
  useRoom,
  useRoomMessage,
  useRoomState,
} from "@bungohan/client-js/react"
import { ARENA, ROOM_TYPE } from "@bungohan/tutorial-shared"
import { useEffect, useRef, useState } from "react"
import { type ArenaRoom, arenaJoin, arenaOptions } from "../arena"
import { drawArena } from "../draw"
import { watchKeys } from "../input"

export function App({ name }: { name: string }) {
  // Joins on mount, leaves on unmount. Options are read once, when the
  // join starts.
  const arena = useRoom(
    ROOM_TYPE,
    arenaOptions(name),
    "joinOrCreate",
    arenaJoin,
  )

  if (arena.status === "connecting") return <p>Connecting…</p>
  if (arena.room === undefined) {
    const why =
      arena.status === "left"
        ? `The server ended the room (code ${arena.leaveCode}).`
        : arena.error?.message
    return <p>Not in the arena: {why}</p>
  }
  return <Game room={arena.room} />
}
```
<!-- /snippet -->

The game component reads state with `useRoomState` and messages with
`useRoomMessage`:

<!-- snippet: apps/tutorial/client/src/react/App.tsx#game -->
[`apps/tutorial/client/src/react/App.tsx`](../apps/tutorial/client/src/react/App.tsx)

```tsx
interface Score {
  id: string
  name: string
  score: number
}

/** Same rows in the same order: nothing on the scoreboard changed. */
function sameScores(a: Score[], b: Score[]): boolean {
  return (
    a.length === b.length &&
    a.every((row, i) => row.id === b[i]?.id && row.score === b[i]?.score)
  )
}

function Game({ room }: { room: ArenaRoom }) {
  // Re-renders only when a name or score changes, not on every move.
  const scores = useRoomState(
    room,
    (state) =>
      [...state.players]
        .map(([id, p]) => ({ id, name: p.name.get(), score: p.score.get() }))
        .sort((a, b) => b.score - a.score),
    sameScores,
  )
  const [news, setNews] = useState("Collect the gems!")
  useRoomMessage(room, "gemCollected", ({ sessionId, score }) => {
    const who = room.state.players.get(sessionId)?.name.get() ?? sessionId
    setNews(`${who} has ${score} gems`)
  })

  useEffect(
    () => watchKeys((direction) => room.send("move", direction)),
    [room],
  )

  return (
    <div>
      <ArenaCanvas room={room} />
      <p>{news}</p>
      <ol>
        {scores?.map((row) => (
          <li key={row.id}>
            {row.name}: {row.score}
          </li>
        ))}
      </ol>
    </div>
  )
}

/**
 * The canvas draws from the replica every animation frame, outside
 * React's render cycle: positions change far too often to re-render for.
 */
function ArenaCanvas({ room }: { room: ArenaRoom }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const ctx = canvas.current?.getContext("2d")
    if (!ctx) return undefined
    let frame = requestAnimationFrame(function draw() {
      drawArena(ctx, room.state, room.sessionId)
      frame = requestAnimationFrame(draw)
    })
    return () => cancelAnimationFrame(frame)
  }, [room])
  return <canvas ref={canvas} width={ARENA.WIDTH} height={ARENA.HEIGHT} />
}
```
<!-- /snippet -->

- **`useRoomState` with a selector** re-renders only when the selected
  value changes, not on every patch. Select plain values, not the
  wrapper objects, whose identity never changes. The scoreboard selects a
  list of rows, which the default comparison can't see into, so it passes
  its own (`sameScores`) as the third argument.
- **Positions don't go through React at all.** They change 20 times a
  second, so the canvas reads the replica in its own animation loop.
- **`useRoomMessage`** always calls the latest callback, so it doesn't
  need memoizing.

This entry point doesn't use `<StrictMode>`. In development, StrictMode
mounts every component twice, so `useRoom` joins twice and gives the
first seat back at once. With `"joinOrCreate"` that's harmless, apart
from a player who appears and vanishes on the others' screens. With
`"create"` it creates two rooms. The
[client guide](guides/client.md#react-and-strictmode) has the details and
a workaround.

## 7. A test

`@bungohan/testing` runs a real server and real clients in one process,
over an in-memory transport and on a clock that only moves when the test
says so. There are no ports, no sleeps and no flakiness.

<!-- snippet: apps/tutorial/server/src/ArenaRoom.test.ts#setup -->
[`apps/tutorial/server/src/ArenaRoom.test.ts`](../apps/tutorial/server/src/ArenaRoom.test.ts)

```ts
import { afterEach, beforeEach, expect, test } from "bun:test"
import type { BungohanClient } from "@bungohan/client-js"
import { createTestHarness, type TestHarness } from "@bungohan/testing"
import {
  ARENA,
  ArenaState,
  arenaContract,
  ROOM_TYPE,
} from "@bungohan/tutorial-shared"
import { ArenaRoom } from "./ArenaRoom"

const arena = { state: ArenaState, contract: arenaContract }

let h: TestHarness

beforeEach(async () => {
  // A real server and real clients, in-process, on a manual clock.
  h = await createTestHarness({
    rooms: { [ROOM_TYPE]: ArenaRoom },
    client: { pingInterval: 0 },
  })
})

afterEach(async () => {
  await h.stop()
})

async function join(name: string, client?: BungohanClient) {
  const c = client ?? (await h.connect())
  const options = { create: { gems: 3 }, join: { name } }
  return (await c.joinOrCreate(ROOM_TYPE, options, arena)).unwrap()
}
```
<!-- /snippet -->

`createTestHarness({ rooms })` defines the room types. `h.connect()`
returns a real `BungohanClient` wired to the in-memory server, and a join
resolves as soon as its first snapshot is in, like in production.

<!-- snippet: apps/tutorial/server/src/ArenaRoom.test.ts#see-each-other -->
[`apps/tutorial/server/src/ArenaRoom.test.ts`](../apps/tutorial/server/src/ArenaRoom.test.ts)

```ts
test("two players join the same arena and see each other", async () => {
  const alice = await join("Alice")
  const bob = await join("Bob")
  await h.tick(50) // one sync period (20 Hz) brings Alice's replica up to date

  expect(bob.id).toBe(alice.id)
  const names = [...alice.state.players.values()].map((p) => p.name.get())
  expect(names.sort()).toEqual(["Alice", "Bob"])
  expect(alice.state.gems.size).toBe(3)
})
```
<!-- /snippet -->

`await h.tick(50)` delivers what's pending and advances the clock 50 ms:
three simulation steps and one sync, exactly as the real server would run
them.

A test can drive the game through the client, the way a player would:

<!-- snippet: apps/tutorial/server/src/ArenaRoom.test.ts#collect -->
[`apps/tutorial/server/src/ArenaRoom.test.ts`](../apps/tutorial/server/src/ArenaRoom.test.ts)

```ts
test("walking onto a gem scores it and spawns another", async () => {
  const room = await join("Alice")
  const scores: number[] = []
  room.onMessage("gemCollected", ({ score }) => scores.push(score))

  // Steer toward the nearest gem using only what the client can see.
  for (let i = 0; i < 200 && scores.length === 0; i++) {
    const me = room.state.players.get(room.sessionId)
    const gem = [...room.state.gems.values()][0]
    if (me === undefined || gem === undefined) throw new Error("no state")
    const toward = (d: number) => (Math.abs(d) < 5 ? 0 : Math.sign(d))
    room.send("move", {
      dx: toward(gem.x.get() - me.x.get()),
      dy: toward(gem.y.get() - me.y.get()),
    })
    await h.tick(50)
  }

  expect(scores[0]).toBe(1)
  expect(room.state.players.get(room.sessionId)?.score.get()).toBeGreaterThan(0)
  expect(room.state.gems.size).toBe(3)
})
```
<!-- /snippet -->

It can also simulate the network misbehaving:

<!-- snippet: apps/tutorial/server/src/ArenaRoom.test.ts#disconnect -->
[`apps/tutorial/server/src/ArenaRoom.test.ts`](../apps/tutorial/server/src/ArenaRoom.test.ts)

```ts
test("a dropped player stops walking while their seat is held", async () => {
  const aliceClient = await h.connect({ reconnection: { enabled: false } })
  const alice = await join("Alice", aliceClient)
  const bob = await join("Bob")
  const seen = bob.state.players.get(alice.sessionId)
  if (seen === undefined) throw new Error("Bob can't see Alice")

  alice.send("move", { dx: seen.x.get() < ARENA.WIDTH / 2 ? 1 : -1, dy: 0 })
  await h.tick(100)
  await h.dropConnection(aliceClient)
  await h.tick(50)
  const x = seen.x.get()
  await h.tick(1000)

  expect(bob.state.players.has(alice.sessionId)).toBe(true) // seat held
  expect(seen.x.get()).toBe(x) // but not moving
})
```
<!-- /snippet -->

`h.dropConnection(client)` cuts the connection from the network side, as
a lost Wi-Fi link would. Run the tests with `bun test`. The
[testing guide](guides/testing.md) covers the harness in full.

## Where next

- [State and schemas](guides/state.md): every field type, collections,
  nested objects, per-client visibility.
- [Rooms and their lifecycle](guides/rooms.md): authentication,
  reconnection, persistence.
- [Matchmaking](guides/matchmaking.md): lobbies, reservations, room
  listings.
- [Gotchas](gotchas.md), before you ship.
- [`apps/example-shooter`](../apps/example-shooter/) is a much bigger
  game (lobby, room codes, a round timer, combat) built the same way.
