## Install

```sh
bun add @bungohan/core@alpha @bungohan/schema@alpha      # server
bun add @bungohan/client-js@alpha @bungohan/schema@alpha # client
```

`latest` now points at this release too, so a plain `bun add @bungohan/core`
installs it.

## Breaking changes from `0.1.0-alpha.2`

All are small. Most apps need no change.

- **`onAuth` returning `true`** now sets `client.auth` to a copy of the
  connection's auth (see `authenticate` below) instead of `{}`. Without
  `authenticate` that is still `{}`.
- **`snapshotFor(state, client)`** with an object needs `sessionId` as well
  as `id`. A plain `sessionId` string works as before.
- **New union members:** `ErrorSource` gains `"authenticate"` and
  `"serial"`, and `ErrorCode` gains `"ROOM_EXISTS"`. An exhaustive `switch`
  over either needs the new cases.

## @bungohan/core

### Authentication

- **`ServerOptions.authenticate(context)`** checks a connection's
  credentials once, when it opens. Every join on the connection waits for
  it, so a one-time login ticket is spent once however many rooms the
  player joins. A refused connection gets `AUTH_FAILED` on every join. Its
  result is `connection.auth`, and rooms whose `onAuth` returns `true` (the
  default) copy it to `client.auth`. In cluster mode it runs once, on the
  process holding the socket.
- **Warning at `defineRoomType`** when a room overrides the instance
  `onAuth` but not the static one. That leaves the join that creates the
  room unchecked.

### Matchmaking

- **`where` pools.** Server-side `joinOrCreate`, `reserve`, `createRoom`
  and `joinRoom` take `{ where: { … } }` where they took a process
  selector. They pick only rooms whose metadata matches, and a room they
  create starts with that metadata. One room type can now serve pools you
  configure at run time.
- **Keyed rooms.** `{ key }` names at most one room of a type, across the
  cluster: a room that stands for a record in your database, say.
  `joinOrCreate` finds it or creates it. `reserve` takes a seat in it, even
  if it's private; a full one is `ROOM_FULL`, never a second room.
  `createRoom` with a key that's taken fails with `ROOM_EXISTS`. The key is
  readable as `room.key` and shows in `query` listings.
- **`matchMaker.reserveById(roomId, joinOptions)`** holds a seat in a room
  you chose (with `query`, say) instead of sending the client an id and
  racing other players for the last seat.
- **One room per pool across the cluster.** Concurrent find-or-create calls
  on different processes used to be able to create a room each. They now
  take a cluster-wide creation lock over the existing backplane, for
  clients' `joinOrCreate` too. The remaining limit: in the moment after a
  process starts or dies, while processes disagree about who is alive, two
  can still each create one.
- **Live metadata in `query`** is documented and tested: a change to
  `this.metadata` is visible to the next query, on any process.

### Rooms and server

- **Serial handlers.** `onMessage(type, handler, { serial: true })` and
  `this.serial(task)` share one queue per room: each task starts after the
  previous one finished, across an `await`. Timers can join the queue. A
  throw is reported and the queue carries on, and tasks that haven't
  started are dropped when the room is disposed.
- **Application pub/sub.** `server.publish(channel, message)` and
  `server.subscribe(channel, handler)` fan an event out to every process in
  the cluster, the sender included. Without cluster mode they deliver to
  the local process only. Delivery is best effort, like the backplane's.

## @bungohan/client-js

- **Token provider.** `token` can be a function, called before every
  connection, including each automatic reconnection. Each connection can
  then carry a fresh one-time ticket, instead of a fixed token that's
  already spent by the time the client reconnects.

## @bungohan/schema (and @bungohan/state)

- **`createServerOnly(field)`**: a field that `saveState` stores and
  `loadState` restores, but that no client ever receives.
- **Filters get `client.sessionId`**, as the rest of the server does. `id`
  stays, with the same value.

## @bungohan/testing

- **`cluster.run(join)` respects `joinRealWait`.** A join whose hooks await
  real I/O no longer fails with `TIMEOUT` when it's driven through
  `cluster.run`.
- **No wasted real time in a cluster.** A join that looks for a room across
  processes no longer spends a full `joinRealWait` of real time waiting on
  the cluster's own collection window.

## Docs

- Rooms: authenticating a connection once, and when `onAuth` runs (every
  join, not reconnections).
- Client: one-time tokens.
- Matchmaking: pools and keys, `reserveById`, live metadata.
- Messages: serial handlers.
- Scaling: one room per pool, events for every process.
- State: server-only fields.
- Testing: real I/O in join hooks across processes.
- The version named in the READMEs is now updated by the release bump, so
  the npm pages show the right one.

**Full changelog:** https://github.com/gegehprast/bungohan/compare/v0.1.0-alpha.2...v0.1.0-alpha.3
