# @bungohan/testing

The test harness of [Bungohan](../../docs/README.md). It runs a real server
and real clients in one process, over a loopback transport and a manual
clock, so a multiplayer test is deterministic: you advance time yourself and
nothing depends on a timer firing.

```sh
bun add -d @bungohan/testing
```

Requires Bun 1.3.3 or newer.

You build one with `createTestHarness({ rooms })`, connect clients with
`harness.connect()`, and move the world forward with `await harness.tick(16)`
instead of sleeping.

`createTestHarness` gives you real `@bungohan/client-js` clients;
`createServerHarness` gives you a lower-level driver that speaks the wire
protocol directly, for testing the bytes. See the
[testing guide](../../docs/guides/testing.md).
