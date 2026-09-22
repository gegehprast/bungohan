# Testing

`@bungohan/testing` runs a real server and real clients in one `bun test`
process. Nothing about the protocol is faked: frames are encoded, "sent"
through an in-memory transport and decoded, exactly as over a WebSocket.
What's replaced is the network and time. There are no ports, and a
**manual clock** only moves when the test moves it, so tests are fast and
deterministic.

```sh
bun add -d @bungohan/testing
```

## The harness

The tutorial's test shows the usual setup:

<!-- snippet: apps/tutorial/server/src/ArenaRoom.test.ts#setup -->
[`apps/tutorial/server/src/ArenaRoom.test.ts`](../../apps/tutorial/server/src/ArenaRoom.test.ts)

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

`createTestHarness` takes:

- `rooms`: room types by name, `{ arena: ArenaRoom }`, or with options,
  `{ lobby: [LobbyRoom, { autoDispose: false }] }`. Or `define: (server) =>
  …` to run your own setup function, the same one your entry point uses.
- `server`: any `ServerOptions` except the transport and clock.
- `client`: defaults for every `h.connect()`. `pingInterval: 0` keeps
  pings out of byte counts, and `logger: { warn() {}, error() {} }`
  silences expected warnings.

`await h.connect(options?)` returns a real, connected `BungohanClient`.
A join resolves by itself, like in production: the harness runs the
server's clock forward until the join's snapshot arrives (up to one sync
period). `await h.stop()` closes everything. Call it in `afterEach`.

## Moving time

<!-- snippet: docs/examples/src/testing.test.ts#time -->
[`docs/examples/src/testing.test.ts`](../examples/src/testing.test.ts)

```ts
test("time only moves when the test moves it", async () => {
  h = await createTestHarness({ rooms: { arena: ArenaRoom } })
  const view = (
    await (await h.connect()).joinOrCreate("arena", options("Ada"), arena)
  ).unwrap()
  const me = view.state.players.get(view.sessionId)
  const x = me?.x.get() ?? 0

  view.send("move", { dx: x < 400 ? 1 : -1, dy: 0 })
  await h.flush() // delivers frames and runs due timers; no time passes
  expect(me?.x.get()).toBe(x)

  await h.tick(250) // delivers, advances 250 ms of loops, delivers again
  expect(Math.abs((me?.x.get() ?? 0) - x)).toBeCloseTo(50, -1)
})
```
<!-- /snippet -->

| Call | What happens |
|---|---|
| `await h.flush()` | delivers every queued frame, both ways, and runs timers already due. Time doesn't move. |
| `await h.tick(ms)` | delivers, advances the clock by `ms` (running every simulation step, sync and timer due in that time, in order), and delivers again. |
| `await h.flushSync()` | ticks by one sync period, so every room reaches a sync boundary. |

So after `send`, `await h.tick(50)` is "the next patch has arrived":
the message is handled, the loops run, and the resulting patch is
applied on every client. Timers set through the room's `this.clock` run
on the same clock, and so do the client's reconnection backoff and pings.

## Reaching into the server

<!-- snippet: docs/examples/src/testing.test.ts#server-side -->
[`docs/examples/src/testing.test.ts`](../examples/src/testing.test.ts)

```ts
test("reading the room on the server", async () => {
  h = await createTestHarness({ rooms: { arena: ArenaRoom } })
  const client = await h.connect()
  const view = (
    await client.joinOrCreate("arena", options("Ada"), arena)
  ).unwrap()

  // The room's real state on the server, typed by the room class.
  const state = h.stateOf(ArenaRoom, view)
  state.players.get(view.sessionId)?.score.set(7)

  await h.flushSync() // runs every room to its next sync boundary
  expect(view.state.players.get(view.sessionId)?.score.get()).toBe(7)
})
```
<!-- /snippet -->

`h.stateOf(RoomClass, room)` returns a room's real, server-side state,
typed by the room class. `room` is a client's room or a room id. `state`
stays `protected` in your room class: tests don't need it public.
`h.server` is the real `BungohanServer`, and
`h.server.getMatchMaker().getRoom(id)` returns the room instance itself.

## The network

<!-- snippet: docs/examples/src/testing.test.ts#network -->
[`docs/examples/src/testing.test.ts`](../examples/src/testing.test.ts)

```ts
test("drops, outages and byte counts", async () => {
  h = await createTestHarness({
    rooms: { arena: ArenaRoom },
    client: { pingInterval: 0, logger: { warn() {}, error() {} } },
  })
  const client = await h.connect()
  const view = (
    await client.joinOrCreate("arena", options("Ada"), arena)
  ).unwrap()

  h.offline = true // new connections fail, like an unreachable server
  await h.dropConnection(client) // drop this one from the network side
  await h.tick(1000) // the first retry fails: still offline
  expect(view.status).toBe("reconnecting")

  h.offline = false
  await h.tick(2000) // the next retry (backoff doubled) gets through
  await h.tick(50)
  expect(view.status).toBe("joined")

  h.resetStats()
  await h.tick(1000) // nobody moves: an idle room sends nothing
  expect(h.bytesSent()).toBe(0)
})
```
<!-- /snippet -->

- `h.dropConnection(client, code = 1006)` drops a client's connection
  from the network side, so its client reconnects as it would for real.
- `h.offline = true` makes new connections fail, as if the server were
  unreachable.
- `h.bytesSent()` / `h.bytesReceived()` count what the server sent and
  received, and `h.resetStats()` zeroes them. That makes bandwidth
  something a test can assert, including that an idle room sends
  nothing.

### A client that stops reading

`h.transport.stall(clientId)` stops delivering to one client, as for a
backgrounded tab or a stalled link. The server keeps queueing for it
until its [backpressure limits](production.md#limits) kick in:

<!-- snippet: docs/examples/src/testing.test.ts#stall -->
[`docs/examples/src/testing.test.ts`](../examples/src/testing.test.ts)

```ts
test("a client that stops reading is paused, then re-synced", async () => {
  h = await createTestHarness({
    rooms: { arena: ArenaRoom },
    client: { pingInterval: 0 },
    // Small thresholds, so a test reaches them quickly.
    server: {
      limits: { backpressure: { pauseBytes: 300, resumeBytes: 100 } },
    },
  })
  const mover = (
    await (await h.connect()).joinOrCreate("arena", options("Mover"), arena)
  ).unwrap()
  const slowClient = await h.connect()
  const slow = (
    await slowClient.joinOrCreate("arena", options("Slow"), arena)
  ).unwrap()

  const replica = slow.state
  // Stop delivering to `slow`: the server's queue for it grows.
  h.transport.stall(h.socketOf(slowClient).clientId)
  for (let i = 0; i < 60; i++) {
    mover.send("move", { dx: i % 20 < 10 ? 1 : -1, dy: 1 })
    await h.tick(50)
  }
  const server = h.stateOf(ArenaRoom, slow)
  const truth = server.players.get(mover.sessionId)?.y.get()
  expect(slow.state.players.get(mover.sessionId)?.y.get()).not.toBe(truth)

  // Reading again: the backlog drains, then a fresh snapshot catches up.
  h.transport.unstall(h.socketOf(slowClient).clientId)
  mover.send("move", { dx: 0, dy: 0 })
  await h.tick(200)
  const now = server.players.get(mover.sessionId)?.y.get()
  expect(slow.state.players.get(mover.sessionId)?.y.get()).toBe(now)
  // Re-synced by a snapshot, which always builds a new replica.
  expect(slow.state).not.toBe(replica)
})
```
<!-- /snippet -->

`h.socketOf(client).clientId` gives the transport's id for a client.

## `ManualClock` on its own

The clock works without a harness, for testing your own timer logic:

<!-- snippet: docs/examples/src/testing.test.ts#clock -->
[`docs/examples/src/testing.test.ts`](../examples/src/testing.test.ts)

```ts
test("a ManualClock on its own", async () => {
  const clock = new ManualClock()
  const fired: number[] = []
  clock.setTimeout(() => fired.push(clock.now()), 100)
  clock.setInterval(() => fired.push(clock.now()), 40)

  await clock.advance(100) // fires each due timer in order, at its due time
  expect(fired).toEqual([40, 80, 100])
})
```
<!-- /snippet -->

`advance` fires each timer at its due time, in order, and lets promise
continuations settle after each one. An exception from a timer callback
rejects `advance`, so a failed `expect` inside one fails the test.

## Several processes

`createClusterHarness({ size, rooms })` runs several servers in one
process, sharing one clock and an in-memory backplane.
[Scaling](scaling.md) has an example.

## Next

- [Going to production](production.md)
