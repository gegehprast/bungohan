# Getting started

Bungohan is a framework for multiplayer game servers on [Bun](https://bun.com).
You write **rooms**: small TypeScript classes that hold a game's state and
rules. Players connect with the browser client, send their inputs as typed
messages, and receive the room's state as compact binary patches, several
times a second.

## Is it the right fit?

Bungohan is **authoritative**: the server runs the game, and clients only
send inputs and display what the server tells them. That is the model
you want whenever players compete or share a world:

- **Cheating is contained.** A client can send nonsense, but it can't
  set its own score or teleport, because only the server changes state.
- **There is one truth.** Every client converges on the server's state,
  so two players never disagree about who picked up the item.
- **Late joiners and reconnects are free.** A newcomer gets the current
  state in one snapshot. Nobody has to replay history.

It fits real-time games with a few to a few hundred players per room:
arena and .io games, co-op games, party games, card and board games with
live state, lobbies and chat. You get:

- **State that syncs itself.** Change a field on the server, and every
  client's copy changes. Only the change is sent, usually in a handful of
  bytes.
- **Typed messages both ways.** Message names and payloads are checked at
  compile time on the server and the client, from one shared declaration.
- **Rooms, matchmaking and reconnection** built in, plus a test harness
  that runs server and clients in one process on a fake clock.

It is a poor fit for peer-to-peer or lockstep netcode, for servers that
must run on Node.js rather than Bun, and for one huge seamless world: a
room lives on one process, so a world that can't be split into rooms
isn't a Bungohan world.

## The four pieces

| Piece | Where it runs | What it is |
|---|---|---|
| **State** | shared | A class extending `Schema`, whose fields are created with factories like `createNumber()`. The server owns the real one; each client holds a read-only copy. |
| **Contract** | shared | The messages each side may send, declared once with `defineMessage`. |
| **Room** | server | A class extending `Room`: lifecycle hooks, message handlers and a game loop. |
| **Client** | browser | `@bungohan/client-js` joins rooms, sends messages and keeps the local copy of the state up to date. |

State and contract live in a module both sides import, so the server and
the client can never disagree about their shapes.

## Install

> The packages aren't on npm yet; these are the names they will be
> published under.

The server needs Bun 1.3.3 or newer.

```sh
bun add @bungohan/core @bungohan/schema      # server
bun add @bungohan/client-js @bungohan/schema # client
```

The server imports from `@bungohan/core` and the client from
`@bungohan/client-js`. The module both of them share, holding the state and
the contract, imports from `@bungohan/schema`: the definitions alone, safe to
ship to a browser. So the server never depends on the client package, and
the browser never pulls in server code.

## A server and a client in three files

A counter that every client can increment. First, the shared module: the
state and the contract.

<!-- snippet: docs/examples/src/getting-started/shared.ts#shared -->
[`docs/examples/src/getting-started/shared.ts`](examples/src/getting-started/shared.ts)

```ts
import {
  createInt,
  defineContract,
  defineMessage,
  f,
  Schema,
} from "@bungohan/schema"

/** The state every client sees, kept in sync by the server. */
export class CounterState extends Schema {
  public static override readonly schemaName = "CounterState"
  public count = createInt(f.uint32)
}

/** The messages each side may send, and their payloads. */
export const counterContract = defineContract({
  client: { increment: defineMessage("increment", { by: f.uint8 }) },
  server: {},
})
```
<!-- /snippet -->

`createInt(f.uint32)` is a synchronized integer field. `schemaName` names
the class on the wire, so a client can build its copy of the state.
`defineMessage("increment", { by: f.uint8 })` declares a message and the
exact type of each field.

The server defines a room type, handles the message by changing the
state, and starts listening:

<!-- snippet: docs/examples/src/getting-started/server.ts#server -->
[`docs/examples/src/getting-started/server.ts`](examples/src/getting-started/server.ts)

```ts
import { createBungohanServer, Room } from "@bungohan/core"
import { CounterState, counterContract } from "./shared"

class CounterRoom extends Room<CounterState, typeof counterContract> {
  public static override contract = counterContract
  protected override state = new CounterState()

  protected override async onCreate(): Promise<void> {
    this.onMessage("increment", (_client, { by }) => {
      this.state.count.set(this.state.count.get() + by)
    })
  }
}

const port = Number(process.env["PORT"] ?? 6060)
const server = createBungohanServer({ transport: { config: { port } } })
server.defineRoomType("counter", CounterRoom)

const started = await server.start()
if (started.isErr()) throw started.error
console.log(`listening on ws://localhost:${port}`)
```
<!-- /snippet -->

The room never sends the count to anyone. Changing `this.state` is
enough: the server sends each client the change at its next sync tick
(20 times a second by default).

The client joins a room of that type (creating it if none exists), listens
for changes, and sends three increments:

<!-- snippet: docs/examples/src/getting-started/client.ts#client -->
[`docs/examples/src/getting-started/client.ts`](examples/src/getting-started/client.ts)

```ts
import { createBungohanClient } from "@bungohan/client-js"
import { CounterState, counterContract } from "./shared"

const url = process.env["SERVER_URL"] ?? "ws://localhost:6060"
const client = createBungohanClient({ url })

const joined = await client.joinOrCreate("counter", undefined, {
  state: CounterState,
  contract: counterContract,
})
if (joined.isErr()) throw joined.error
const room = joined.value

room.state.count.onChange((count) => {
  console.log(`count is now ${count}`)
  if (count >= 3) void client.disconnect()
})

for (let i = 0; i < 3; i++) room.send("increment", { by: 1 })
```
<!-- /snippet -->

Run the server in one terminal and the client in another:

```sh
bun server.ts
bun client.ts
```

The client prints `count is now 3` (maybe preceded by smaller counts) and
exits. Run it again and it counts from zero: when the last client left,
the room disposed itself, and this join created a new one. Run two
clients at once and they share a room, and a count.

This client runs under Bun to keep the first step short. The same
`@bungohan/client-js` code runs in a browser, which is where the
[tutorial](tutorial.md) goes next. Every join and send returns a `Result`
instead of throwing, which is why the code checks `isErr()` rather than
using `try`.

The three files above are
[`docs/examples/src/getting-started/`](examples/src/getting-started/), and
a test runs them exactly like this, as two processes over a real socket.

## Next

- **[Tutorial](tutorial.md):** build a small complete game, from state
  to a React client and a test.
- **[Guides](README.md#guides):** one topic per page.
- **[Gotchas](gotchas.md):** the rules people actually trip over.
