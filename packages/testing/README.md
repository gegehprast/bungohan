# @bungohan/testing

The test harness of [Bungohan](../../docs/README.md). It runs a real server
and real clients in one process, over a loopback transport and a manual
clock, so a multiplayer test is deterministic: you advance time yourself and
nothing depends on a timer firing.

```sh
bun add -d @bungohan/testing
```

Requires Bun 1.3.3 or newer.

A test builds one with `createTestHarness({ rooms })`, connects clients
with `harness.connect()`, and moves the world forward with
`await harness.tick(ms)` instead of sleeping:

<!-- snippet: docs/examples/src/testing.test.ts#quick-start -->
[`docs/examples/src/testing.test.ts`](../../docs/examples/src/testing.test.ts)

```ts
test("one player's move reaches the other", async () => {
  const harness = await createTestHarness({ rooms: { arena: ArenaRoom } })
  const join = async (name: string) => {
    const client = await harness.connect()
    const joined = await client.joinOrCreate(
      "arena",
      { create: { gems: 3 }, join: { name } },
      { state: ArenaState, contract: arenaContract },
    )
    return joined.unwrap()
  }
  const ada = await join("Ada")
  const bob = await join("Bob")
  const before = bob.state.players.get(ada.sessionId)?.x.get()

  ada.send("move", { dx: 1, dy: 0 })
  await harness.tick(250) // 250 ms of game time, and no real waiting

  const seenByBob = bob.state.players.get(ada.sessionId)?.x.get()
  const onServer = harness.stateOf(ArenaRoom, ada).players.get(ada.sessionId)
  expect(seenByBob).not.toBe(before)
  // Positions are fixed-point on the wire: clients get them rounded.
  expect(seenByBob).toBeCloseTo(onServer?.x.get() ?? 0, 1)
  await harness.stop()
})
```
<!-- /snippet -->

`createTestHarness` gives you real `@bungohan/client-js` clients;
`createServerHarness` gives you a lower-level driver that speaks the wire
protocol directly, for testing the bytes.

## Documentation

- [Testing](../../docs/guides/testing.md): moving time, `flushSync()`
  versus `tick(ms)`, real I/O in join hooks, testing filters with
  `snapshotFor`, the network and the manual clock
- [Rooms](../../docs/guides/rooms.md), including how to give a room its
  dependencies so a test can pass fakes
- [Getting started](../../docs/getting-started.md) and the
  [tutorial](../../docs/tutorial.md), which ends with a test
- [Gotchas](../../docs/gotchas.md)

The server is [`@bungohan/core`](../core/README.md), the client
[`@bungohan/client-js`](../client-js/README.md).
