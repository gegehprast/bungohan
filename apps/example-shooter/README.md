# Bungohan Shooter (example)

A top-down multiplayer shooter: the end-to-end reference app for Bungohan, and
the canary for developer-experience regressions. When the framework API
changes, update this app's call sites.

- **Players:** 1–8 per room, from a lobby with a room browser and room codes
- **Goal:** shoot enemies and other players, collect loot; highest score
  when time runs out (or first to the win score) wins

## Running it

From the repository root:

```sh
bun install
bun --filter @bungohan/example-shooter-server dev   # ws://localhost:6060
bun --filter @bungohan/example-shooter-client dev   # http://localhost:5173
```

Open the client in two tabs to play against yourself. The server port comes
from `PORT`, and the client's server URL from `VITE_SERVER_URL` (default: port
6060 on the page's host). Ctrl+C stops the server gracefully.

Tests (a real server and client-js clients on the in-process harness) run with
the rest of the repo's: `bun test apps/example-shooter`.

## Controls

- **WASD** or **arrow keys:** move
- **Mouse:** aim
- **Left click (hold):** shoot

## Layout

```
shared/   the message contracts (§4.1) and state schemas; server and client
          both import them directly, no build step
server/   Bun + @bungohan/core
  src/app.ts       room types and server callbacks (shared with the tests)
  src/rooms/       LobbyRoom, ShooterRoom (+ rooms.test.ts)
  src/systems/     movement, spawning, combat, loot
client/   Vite + React + Tailwind, on @bungohan/client-js/react
```

## What it exercises

- **Typed contracts both ways.** `shooterContract` and `lobbyContract` in
  `shared/src/contract.ts` type the server's `onMessage`/`send`/`broadcast`
  and the client's `send`/`onMessage`/`useRoomMessage`. The client passes
  `{ state, contract }` at join, so the payloads are packed positionally and
  a stale client fails with `CONTRACT_MISMATCH`.
- **Bandwidth-minded state.** Positions are fixed-point (`createFixedPoint(1)`,
  0.1 px), integers use `createInt` with the narrowest kind (`f.uint8`
  health), entities are keyed by small integers rather than string ids,
  server-only data (velocities, cooldowns) lives in plain fields that are never
  synced, the clock only syncs whole seconds, and the lobby updates its room
  list in place so an idle lobby sends nothing.
- **Room hooks.** Each room type sets its own tick rates in `onCreate`,
  and `onDisconnect` drops a dropped player's last input while their seat
  is held for reconnection.
- **Server callbacks.** `server.onJoin`/`onLeave` log and prompt every lobby
  to relist the shooter rooms at once.
- **Room metadata for cross-room reads.** A room's state is private to it, so
  each shooter room publishes its listing in `metadata`, and the lobby reads
  it through `matchMaker.query()` (with a metadata filter for room codes).
- **React hooks.** `useRoom` holds the lobby for the session;
  `useRoomState` with selectors keeps the HUD from re-rendering on every
  position update; the canvas reads the replica directly each frame.
