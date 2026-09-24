## Install

```sh
bun add @bungohan/core@alpha @bungohan/schema@alpha      # server
bun add @bungohan/client-js@alpha @bungohan/schema@alpha # client
```

No breaking changes from `0.1.0-alpha.1`.

## @bungohan/core

- **Custom HTTP routes.** The new `http.fetch` option handles requests on the
  HTTP port that the built-in endpoints (`/health`, `/ready`, `/metrics`,
  `/rooms`) don't match. If it throws, the server answers 500 and reports
  the error with `source: "http"`.
- **Typed endpoint bodies.** New exports `HealthResponse`, `ReadyResponse`,
  `MetricsResponse`, `RoomMetricsEntry` and `RoomsResponseEntry` describe
  exactly what the built-in endpoints return.
- **More exports.** `AuthResult`, `LimitOptions` and the Result helpers
  (`ok`, `err`, `Ok`, `Err`, `Result`, `tryCatch`, `tryCatchAsync`) are now
  exported from core, as they already were from client-js.

## @bungohan/testing

- **Join hooks that do real I/O.** Set `joinRealWait` to give a join that the
  server is still processing that much real time before the manual clock
  moves on. Before, a join hook that awaited a real database or HTTP call
  could fail with a false `TIMEOUT` or never get its reply. The harness now
  warns when it gives up on a join the server is still processing.
- **Per-client `autoJoin`.** `harness.connect({ autoJoin: false })` holds
  back one client's join while the other clients join normally.
- **`snapshotFor(state, client)`** returns what one client would decode,
  so you can unit-test `createFiltered` filters without a room.

## Docs

- Rooms: what persistence keeps across a restart, and passing a room its
  dependencies through a class factory.
- Testing: `flushSync()` vs `tick(ms)`, real I/O in join hooks, testing
  filters, replicas of dropped clients, raw-frame listeners.
- Production: typed endpoint bodies and custom routes.
- State: `createNumber` is exact for integers up to 2^53, and when a filter
  can be an arrow function.
- Messages and options: how strings are sanitized (NUL and lone surrogates
  become U+FFFD), the shape of `joinOrCreate`'s arguments,
  `InferJoinOptions` / `InferCreateOptions`.
- A quick start in the `@bungohan/testing` README.

**Full changelog:** https://github.com/gegehprast/bungohan/compare/v0.1.0-alpha.1...v0.1.0-alpha.2
