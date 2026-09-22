# @bungohan/core

The server of [Bungohan](../../docs/README.md), an authoritative multiplayer
game server framework for [Bun](https://bun.com). You write rooms that hold
a game's state and rules; clients join them, send typed messages, and
receive the state as compact binary patches.

```sh
bun add @bungohan/core@alpha @bungohan/schema@alpha
```

Requires Bun 1.3.3 or newer. Published at `0.1.0-alpha.1` on the
`alpha` tag; the API can still change between alpha releases.

<!-- snippet: docs/examples/src/getting-started/server.ts#server -->
[`docs/examples/src/getting-started/server.ts`](../../docs/examples/src/getting-started/server.ts)

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

The state and contract that room uses live in a module the client
imports too: see [Getting started](../../docs/getting-started.md).

## Documentation

- [Getting started](../../docs/getting-started.md) and the
  [tutorial](../../docs/tutorial.md)
- [State and schemas](../../docs/guides/state.md),
  [messages](../../docs/guides/messages.md),
  [rooms](../../docs/guides/rooms.md),
  [matchmaking](../../docs/guides/matchmaking.md)
- [Testing](../../docs/guides/testing.md),
  [production](../../docs/guides/production.md),
  [cluster mode](../../docs/guides/scaling.md)
- [Gotchas](../../docs/gotchas.md) and the
  [option reference](../../docs/reference.md)

The browser client is [`@bungohan/client-js`](../client-js/README.md).
