## Install

```sh
bun add @bungohan/core@alpha @bungohan/schema@alpha      # server
bun add @bungohan/client-js@alpha @bungohan/schema@alpha # client
```

No breaking changes from `0.1.0-alpha.4`. Three behaviors change; see
below.

## Behavior changes

- **`where` pools include private rooms.** A server-side `joinOrCreate`,
  `reserve` or `joinRoom` with `where` now also picks private rooms that
  match. Private hides a room from clients' matchmaking, not from the
  server's. Without `where`, matchmaking takes public rooms only, as
  before.
- **A room without `onTick` runs no simulation loop.** A turn-based room
  driven by messages and timers no longer wakes up 60 times a second for
  nothing. Its `RoomMetrics` simulation counters stay at zero.
- **Cluster lookups end early.** A `query`, `getAllProcesses()` or the
  search before a room is created now returns once every live process has
  answered, at once in a cluster of one. `gatherTimeout` is now only how
  long a lookup waits for a process that stays silent. In a process's
  first `heartbeatInterval` after it starts, lookups still wait the whole
  window, because it may not know every peer yet.

## @bungohan/core

- **`this.syncNow()`** sends the state changes made so far right away,
  instead of at the next sync tick. Call it at the end of a message
  handler that changed the state, so a turn-based room doesn't make
  clients wait up to a sync period. It's a normal sync: `onBeforeSync`
  runs, and nothing is sent if nothing changed.
- **`setSimulationTickRate(0)`** stops the simulation loop (`onTick` stops
  running) until a positive rate starts it again.
- **HTTP `authorize` hook.** `http.authorize(request, { ip, endpoint })`
  runs before each built-in endpoint (`/health`, `/ready`, `/metrics`,
  `/rooms`) answers. Return `false` to answer 403. Use it to gate
  `/metrics` and `/rooms` once `http.fetch` serves public routes on the
  same port. New types: `HttpAuthorize`, `HttpAuthorizeInfo`,
  `HttpEndpoint`, `HttpRequestInfo`.
- **The caller's address in `http.fetch`**: your routes get
  `fetch(request, { ip })`. Behind a proxy it's the proxy's address.
  Existing one-argument handlers keep working.

## Fixes

- **A `reserve` with `where` on a private room type** failed with
  `ROOM_FULL` and left behind the room it had just created. A room created
  for a reservation now always takes its seat.

## Docs

- Rooms: turn-based rooms (no `onTick`, `syncNow`).
- Production: gating the built-in endpoints, and the caller's address in
  your routes.
- Matchmaking: private rooms in `where` pools.
- Scaling: how long cluster lookups wait.

**Full changelog:** https://github.com/gegehprast/bungohan/compare/v0.1.0-alpha.4...v0.1.0-alpha.5
