# Scaling with cluster mode

One Bun process runs many rooms. When one process isn't enough, run
several, connected through Redis (or Valkey), and put a load balancer in
front. That's **cluster mode**.

## What it does

- **A room lives on exactly one process.** Its state, its loops and its
  hooks run there. Nothing about a room's code changes.
- **A client can connect to any process.** If its room lives elsewhere,
  the process holding its socket relays the frames unchanged. The client
  can't tell the difference: same messages, same bytes.
- **Matchmaking spans the cluster.** `joinOrCreate` looks on the local
  process first, then asks the others, and creates a room locally only
  when nobody has one available. `joinById`, `query`, `reserve` and
  reconnection all find rooms wherever they are.
- **Processes find each other** through heartbeats on the backplane.

## Setting it up

<!-- snippet: docs/examples/src/scaling.ts#cluster -->
[`docs/examples/src/scaling.ts`](../examples/src/scaling.ts)

```ts
/** One process of a cluster. Run as many as you like behind a load balancer. */
export function createClusterServer(env: {
  port: number
  redisUrl: string
  processId?: string
  namespace?: string
  region?: string
}): BungohanServer {
  const server = createBungohanServer({
    transport: { config: { port: env.port } },
    cluster: {
      enabled: true,
      processId: env.processId, // default: random
      namespace: env.namespace, // default "bungohan": clusters sharing a Redis differ here
      metadata: { region: env.region ?? "eu-west" }, // what selectors see
      backplane: { config: { url: env.redisUrl } }, // Redis pub/sub
    },
    // Optional: a shared store for loadState/saveState.
    store: { config: { url: env.redisUrl } },
    gracefulShutdown: { handleSignals: false },
  })
  // Every process defines the room types it may host.
  server.defineRoomType("arena", ArenaRoom, { maxClients: 16 })
  return server
}
```
<!-- /snippet -->

- `cluster.enabled` requires a backplane: `backplane.config.url` for
  Redis, or `backplane.provider` for your own `IBackplane`. Without one,
  `start()` fails with `INVALID_OPTIONS`.
- `processId` names this process (random by default).
- `metadata` describes it to the rest of the cluster (see
  [placing rooms by region](#placing-rooms-by-region)).
- `namespace` prefixes every channel (default `"bungohan"`), so unrelated
  clusters, or staging and production, can share one Redis.
- The store is separate and optional. Give every process the same one if
  rooms use `saveState`/`loadState`.
- Timings (`heartbeatInterval` 2 s, `peerTimeout` 6 s,
  `requestTimeout` 5 s, `gatherTimeout` 200 ms) are in the
  [reference](../reference.md#serveroptions).
- A lookup across the cluster (a `query`, the search before a room is
  created, `getAllProcesses()`) asks every process and returns once each
  live one has answered, at once in a cluster of one. `gatherTimeout` is
  only how long it waits for a process that stays silent (one that died
  and isn't yet past `peerTimeout`, say). In its first
  `heartbeatInterval`, a process may not know every peer yet, so its
  lookups wait the whole `gatherTimeout`.

A process needs to define only the room types it should host. A join for
a type it doesn't define is routed to a process that has a room of that
type.

`createRoom`, `joinOrCreate` and `reserve` take a **process selector** to
choose where a new room goes. It's a function from the list of processes
(with their room and client counts, and their `metadata`) to one of them,
for example the least loaded. `matchMaker.getAllProcesses()` returns the
same list. A selector is never offered a
[draining](#draining-a-process) process.

## Placing rooms by region

Each process can describe itself with `cluster.metadata`, a small object
such as `{ region: "eu-west" }`. Every process's selectors see it as
`ProcessInfo.metadata`. `server.setProcessMetadata()` replaces it at
runtime, and the change reaches the other processes at once.

Metadata travels in every heartbeat (every 2 s), so it's capped at 1,024
bytes once encoded. A larger `cluster.metadata` throws when the server is
created; a larger `setProcessMetadata()` returns an `INVALID_OPTIONS`
error and changes nothing. It's typed `Record<string, unknown>`, so check
a field before relying on it:

<!-- snippet: docs/examples/src/scaling.ts#region-selector -->
[`docs/examples/src/scaling.ts`](../examples/src/scaling.ts)

```ts
/** The region a process says it runs in. Metadata is untyped: check it. */
function regionOf(process: ProcessInfo): string | undefined {
  const region = process.metadata["region"]
  return typeof region === "string" ? region : undefined
}

/**
 * The least loaded process in `region`, or the least loaded anywhere if
 * none is there. Draining processes are never offered, and the list is
 * never empty.
 */
export function inRegion(region: string): ProcessSelector {
  return (processes) => {
    const near = processes.filter((p) => regionOf(p) === region)
    const pool = near.length > 0 ? near : processes
    return pool.reduce((a, b) => (b.roomCount < a.roomCount ? b : a))
  }
}
```
<!-- /snippet -->

**A selector sees processes, not the player.** It runs when a room is
created and gets the process list, nothing about who asked. So region
placement works when **your server code** places the room with the
player's region in hand, for example a lobby endpoint:

<!-- snippet: docs/examples/src/scaling.ts#region-placement -->
[`docs/examples/src/scaling.ts`](../examples/src/scaling.ts)

```ts
/**
 * A lobby endpoint: a new match in the player's region. Players then join
 * it by id (`client.joinById`), which goes wherever the room is.
 */
export async function createMatch(
  server: BungohanServer,
  playerRegion: string,
): Promise<string | undefined> {
  const created = await server
    .getMatchMaker()
    .createRoom("arena", { gems: 3 }, inRegion(playerRegion))
  return created.isOk() ? created.value.id : undefined
}
```
<!-- /snippet -->

It doesn't happen by itself for a client's own `joinOrCreate`: that
creates the room on the process the client is connected to. Two more
things to know:

- A selector only decides where a **new** room goes. `joinOrCreate` and
  `reserve` take any available room first, wherever it runs, and call the
  selector only if they have to create one. To keep players in their
  region, create rooms as above and send players to them by id, or put
  the region in each room's `metadata` and find rooms with
  `matchMaker.query({ type, metadata: { region } })`.
- To keep clients on nearby processes in the first place, route them
  with your load balancer or DNS (one endpoint per region).

## Draining a process

To replace a process without cutting games short, **drain** it first.
`server.drain()` stops the process taking on new work, while every game
it already runs carries on:

- **No new rooms are created on it.** Selectors aren't offered it, and
  `createRoom` called on it places the room on another process. A
  client's `joinOrCreate` that reaches it and needs a new room gets one
  on another process, created exactly as it would have been here (the
  static `onAuth`, `onCreate`, then `onJoin`). The client doesn't notice.
- **Matchmaking steers away from it.** `joinOrCreate`, `joinRoom` and
  `reserve` no longer pick its rooms, so random matchmaking stops feeding
  it. `matchMaker.query()` leaves them out too, so a lobby that lists
  rooms and sends players to one by id stops sending them there. Without
  that, the drain would only end at its timeout.
- **Tools can still see every room.** `query({ type, includeDraining:
  true })` lists them all, and each listing's `draining` field says which
  are on a draining process. Use it for an admin view, or to resolve an
  invite such as a room code, since invites still work.
- **Explicit paths keep working.** `joinById` (an invite), reconnection,
  and reservations made before the drain all still reach its rooms, so
  draining never breaks a game in progress or a player's reconnect.
- **`GET /ready` answers 503** (see
  [production](production.md#health-and-readiness)), so a load balancer
  stops sending it new connections.

`drain()` resolves once the process holds no rooms, or when its
`timeout` passes first. So a deploy script can wait, then stop:

<!-- snippet: docs/examples/src/scaling.ts#rolling-deploy -->
[`docs/examples/src/scaling.ts`](../examples/src/scaling.ts)

```ts
/** Your deploy tooling calls this on the process being replaced. */
export async function retire(server: BungohanServer): Promise<string> {
  // No new rooms here from now on, and GET /ready answers 503, so the load
  // balancer sends new connections elsewhere. Running games carry on.
  const drained = await server.drain({ timeout: 15 * 60_000 })
  const summary = drained.isOk()
    ? `${drained.value.outcome}, ${drained.value.rooms} rooms left`
    : drained.error.code
  await server.stop() // rooms still running get LEAVE(4001 SERVER_SHUTDOWN)
  return summary
}
```
<!-- /snippet -->

The result's `outcome` is `"drained"`, `"timeout"` (the process keeps
draining; `stop()` then ends what's left) or `"cancelled"`.
`server.cancelDrain()` undoes a drain, and `isDraining()` says whether
one is on. `ProcessInfo.draining` shows it to the rest of the cluster.
A room type with `autoDispose: false` never empties by itself, so always
pass a timeout.

**When nothing can take a new room**, because every process is draining
(or the only one, outside cluster mode), the join or `createRoom` fails
with `SERVER_SHUTTING_DOWN`, the same error a stopping server gives.
The client can retry, and should reach a process that is up by then.

**A rolling deploy**, one process at a time:

1. Start the new process. Once it's up, `/ready` answers 200 and the load
   balancer adds it.
2. Drain an old one. `/ready` turns 503 and the load balancer takes it
   out of rotation; new rooms go to the other processes.
3. When `drain()` resolves, `stop()` it (or send SIGTERM with
   `gracefulShutdown.drainTimeout`, which does both, see
   [production](production.md#graceful-shutdown)).

Races are handled: a process that starts draining just as another one
forwards it a new room refuses it, and the room is created on the next
process instead.

## One room per pool

When no room is available anywhere, a `joinOrCreate` (from a client or
the server) or a `reserve` creates one. Calls that start on several
processes at once still create one room between them: before creating,
a process takes the pool's creation lock, and a call that has to wait
for it then finds the room the holder made.

- A pool is a room type, or a type plus a `where` or a
  [key](matchmaking.md#pools-and-keys).
- Each pool's lock is kept by one process, picked from the live
  processes by hashing the pool's name, so no extra service is needed.
  It costs one backplane round trip, and only when a room has to be
  created.
- A holder whose process dies loses the lock at once. If the process
  keeping the lock dies, its locks go with it, and waiters ask the
  process that keeps the pool now. A lock held for longer than six
  `requestTimeout`s (30 s by default) is taken back.
- A process that can't get the lock in that time creates the room
  anyway, and logs why.

## Events for every process

An event from outside (a webhook, an admin action) reaches one process.
To tell all of them, publish it over the backplane the cluster already
uses:

<!-- snippet: docs/examples/src/scaling.ts#events -->
[`docs/examples/src/scaling.ts`](../examples/src/scaling.ts)

```ts
/** Every process keeps the list of open events up to date. */
export function trackEvents(server: BungohanServer): Set<string> {
  const open = new Set<string>()
  server.subscribe("events", (message) => {
    // Untyped, like anything off the wire: check it.
    if (typeof message === "object" && message !== null && "open" in message) {
      if (typeof message.open === "string") open.add(message.open)
    }
  })
  return open
}

/** A webhook reached one process: tell all of them, this one included. */
export function onEventOpened(server: BungohanServer, eventId: string) {
  return server.publish("events", { open: eventId })
}
```
<!-- /snippet -->

- `server.publish(channel, message)` reaches every process's
  `server.subscribe(channel, handler)`, the publisher's own included.
  The handler also gets the publishing process's id. Without cluster
  mode it reaches this process only, so the same code runs on one
  process.
- Messages are encoded with the server's serializer (MessagePack): send
  plain data, and check what you receive.
- Delivery is best effort, as with any pub/sub: a process that is down
  misses the message, and nothing is stored or retried. Messages from
  one process arrive in the order it sent them. For data that must not
  be lost, use your database and send the event as a hint to re-read it.
- Channels are yours: they can't collide with the framework's own
  traffic, and the cluster's `namespace` keeps clusters that share one
  Redis apart.

## Testing a cluster

`createClusterHarness` runs several servers in one test process on one
manual clock, over an in-memory backplane:

<!-- snippet: docs/examples/src/scaling.test.ts#harness -->
[`docs/examples/src/scaling.test.ts`](../examples/src/scaling.test.ts)

```ts
test("clients on different processes meet in one room", async () => {
  const cluster = await createClusterHarness({
    size: 2,
    rooms: { arena: ArenaRoom },
  })
  const a = await cluster.connect(0) // socket on process 0
  const b = await cluster.connect(1) // socket on process 1
  const ada = (
    await cluster.run(a.joinOrCreate("arena", options("Ada"), arena))
  ).unwrap()
  const bo = (
    await cluster.run(b.joinOrCreate("arena", options("Bo"), arena))
  ).unwrap()
  await cluster.tick(50)

  expect(bo.id).toBe(ada.id) // one room, on process 0
  expect(bo.state.players.size).toBe(2)
  await cluster.stop()
})
```
<!-- /snippet -->

`cluster.run(promise)` drives the cluster until the work settles (a
cross-process call waits for replies, which are timers on the shared
clock). `cluster.kill(index)` makes a process vanish, to test failures.

## When a process dies

- Clients with seats in its rooms get `LEAVE` with `ROOM_DISPOSED`
  (4002). Their connection and their other rooms are unaffected. A
  graceful `stop()` is better: its rooms dispose first, and clients get
  `SERVER_SHUTDOWN` (4001).
- Held seats and reservations in its rooms are gone with it.
- A matchmaking call waiting on it fails with `CONNECTION_LOST` or
  `TIMEOUT`, never hangs.
- If the process holding a client's *socket* dies, the room's process
  sees that client drop, and holds its seat for reconnection as usual.
  The client can reconnect to any process.

## Limitations

- A client whose socket is on another process than its room can't be
  *paused* by backpressure, because the room's process can't see its
  queue. The socket's process still enforces the hard limit, so such a
  client is shed (1013) rather than paused.
- `ClientMetrics.avgLatency` isn't recorded for such a client, either.
- Untyped options that the *server* builds and passes to
  `createRoom`/`reserve` for another process cross the backplane as
  MessagePack. A `Map` or `Set` arrives as a plain object, and `-0` as `0`.
  Typed options (declared in the contract) don't have this problem.
- The [creation lock](#one-room-per-pool) is exact while every process
  agrees on who is alive. In the moments when they don't (a process
  just joined, or was just dropped), two processes can still each
  create a room for one pool.
- A custom `ServerOptions.serializer` must carry binary data unchanged.
  `start()` checks it and refuses to start a cluster otherwise.
