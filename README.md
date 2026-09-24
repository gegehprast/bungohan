# Bungohan

An authoritative multiplayer game server framework for [Bun](https://bun.com),
with a browser client for JavaScript and TypeScript.

You write rooms that hold a game's state and its rules. Clients join them, send
typed messages, and receive the state as compact binary patches — a position
update costs about 5 bytes on the wire.

<!-- snippet: docs/examples/src/getting-started/server.ts#server -->
[`docs/examples/src/getting-started/server.ts`](docs/examples/src/getting-started/server.ts)

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

- **Typed end to end.** Messages, state and join options are declared once and
  checked at compile time on both the server and the client, with no runtime
  validation in the hot path.
- **Small on the wire.** A schema-aware binary codec sends only what changed,
  and nothing at all on an idle tick.
- **Built to run in production.** Reconnection, per-connection limits, metrics,
  graceful shutdown, and draining for zero-downtime deploys.
- **Scales across processes.** Cluster mode routes players to rooms on other
  processes over Redis, invisibly to clients.

## Getting started

Read the [documentation](docs/README.md). The
[getting started guide](docs/getting-started.md) has a server and a client
talking in three files, and the [tutorial](docs/tutorial.md) builds a small game
from scratch.

Bungohan is at `0.1.0-alpha.4`, published on the `alpha` tag. The API can
still change between alpha releases.

```sh
bun add @bungohan/core@alpha @bungohan/schema@alpha      # server
bun add @bungohan/client-js@alpha @bungohan/schema@alpha # client
```

## This repository

```
packages/     the framework (see docs/README.md)
apps/         example games: the tutorial's, and a small shooter
docs/         the documentation, with runnable examples
clients/      C# and Godot clients (protocol cores, currently paused)
conformance/  language-neutral vectors for the wire protocol
```

`PROTOCOL.md` specifies the wire format for anyone implementing a client in
another language. `CLAUDE.md` holds the conventions for working in this repo,
and `REBUILD_SPEC.md` records the design decisions behind it.

Requires Bun 1.3.3 or newer. MIT licensed.
