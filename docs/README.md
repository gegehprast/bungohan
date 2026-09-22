# Bungohan documentation

Bungohan is an authoritative multiplayer game server framework for Bun,
with a browser client and React hooks. You write rooms that hold state
and game logic, and clients stay in sync with typed messages and compact
state patches.

## Start here

1. **[Getting started](getting-started.md):** what Bungohan is, when it
   fits, and a server and client talking in three files.
2. **[Tutorial](tutorial.md):** build a small complete game, from its
   state to a React client and a test.

## Guides

| Guide | Covers |
|---|---|
| [State and schemas](guides/state.md) | field factories, number types, collections, nested objects and the ownership rule, per-client filtering |
| [Messages and contracts](guides/messages.md) | typed and raw messages, why there's no runtime validation, handler ordering |
| [Join and create options](guides/options.md) | typed options on both ends, server-built options |
| [Rooms and their lifecycle](guides/rooms.md) | hooks, auth, reconnection, pausing, presence, persistence |
| [Matchmaking](guides/matchmaking.md) | join modes, metadata and queries, reservations |
| [client-js and the React hooks](guides/client.md) | the client, listening to state, reconnection, React and StrictMode |
| [Testing](guides/testing.md) | the in-process harness, the manual clock, simulating the network |
| [Going to production](guides/production.md) | tick rates, limits and close code 1013, metrics, HTTP endpoints, graceful shutdown |
| [Scaling with cluster mode](guides/scaling.md) | several processes over Redis |

## Also

- **[Gotchas](gotchas.md):** the rules people actually hit, each with its
  fix.
- **[Reference](reference.md):** `ServerOptions`, `LimitOptions`,
  `DefineRoomOptions` and `ClientOptions`, with their defaults.
- **Examples:** the tutorial game in [`apps/tutorial`](../apps/tutorial/),
  and a bigger game in [`apps/example-shooter`](../apps/example-shooter/).

## Packages

| Package | Where | For |
|---|---|---|
| `@bungohan/core` | server | `createBungohanServer`, `Room`, the matchmaker |
| `@bungohan/client-js` | browser | the client; React hooks at `@bungohan/client-js/react` |
| `@bungohan/state` | shared | `Schema` and the field factories |
| `@bungohan/types` | shared | `defineMessage`, `defineContract`, `f` |
| `@bungohan/testing` | tests | the harness and the manual clock |
| `@bungohan/store`, `@bungohan/transport`, `@bungohan/serializer`, `@bungohan/backplane` | server | stores, the `ConnectionContext` type, wire encodings, cluster backplanes |

## About these docs

Every TypeScript block here is copied from a file in the repository that
is typechecked and tested: the tutorial app, or
[`docs/examples/`](examples/). A test fails if a block drifts from its
source, and `bun run docs:sync` refreshes them all. To change an example,
edit the source file, not the Markdown.
