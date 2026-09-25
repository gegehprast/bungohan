## Install

```sh
bun add @bungohan/core@alpha @bungohan/schema@alpha      # server
bun add @bungohan/client-js@alpha @bungohan/schema@alpha # client
```

No breaking changes from `0.1.0-alpha.3`.

## @bungohan/core

- **`client.joinedBy`** says how a seat was taken: `"reservation"`,
  `"join"` (an existing room, by id or through matchmaking), `"create"`
  (the join created the room) or `"server"` (`room.join(client)`, as for a
  bot). The server sets it before `onAuth` runs, and nothing a client
  sends can change it. So a room that should admit only players its lobby
  placed returns `client.joinedBy === "reservation"` from its `onAuth`
  hooks, and a leaked room id no longer gets anyone in. A reconnection
  keeps the seat, and with it the value. The type is exported as
  `JoinedBy`.

## Fixes

- **A refused join no longer disposes an empty room.** A room created
  with `matchMaker.createRoom` that nobody had joined yet was disposed by
  any failed join into it, such as one its `onAuth` refused. So anyone who
  learned the room's id could destroy it. Now a failed join empties the
  room only if that join created it, or used the reservation that was
  keeping it.

## Docs

- Matchmaking: admitting only players with a reservation, and why a
  failed join leaves a room alone.
- Rooms: `client.joinedBy` next to `onAuth`.

**Full changelog:** https://github.com/gegehprast/bungohan/compare/v0.1.0-alpha.3...v0.1.0-alpha.4
