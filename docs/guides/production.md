# Going to production

A tour of the server settings that matter once real players arrive. The
full list, with every default, is in the [reference](../reference.md).

<!-- snippet: docs/examples/src/production.ts#server -->
[`docs/examples/src/production.ts`](../examples/src/production.ts)

```ts
export function createGameServer(env: {
  port: number
  httpPort: number
  handleSignals?: boolean
}): BungohanServer {
  const server = createBungohanServer({
    transport: {
      config: {
        port: env.port, // default 6060
        maxPayloadLength: 64 * 1024, // largest frame a client may send
        idleTimeout: 60, // seconds of silence before Bun closes a socket
      },
    },
    simulation: { tickRate: 30 }, // onTick 30×/s (default 60)
    sync: { tickRate: 15 }, // patches 15×/s (default 20)
    limits: {
      // Tighter than the defaults: this game sends one small input at a time.
      messages: { perSecond: 60, burst: 60 },
      joins: { perMinute: 20 },
    },
    metrics: { enabled: true }, // off (and free) by default
    http: {
      enabled: true, // /health, /ready, /metrics, /rooms on their own port
      port: env.httpPort,
    },
    gracefulShutdown: {
      drainTimeout: 5 * 60_000, // on SIGTERM, let games finish (up to 5 min)
      timeout: 10_000, // then exit(1) if stopping takes longer
      handleSignals: env.handleSignals ?? true, // SIGTERM / SIGINT
      onShutdown: async () => console.log("bye"),
    },
  })
  server.defineRoomType("arena", ArenaRoom, { maxClients: 16 })

  server.onError((error, context) => {
    // Hooks and handlers that throw end up here, never crash the room.
    console.error(`[${context.source}] ${context.room?.roomType ?? ""}`, error)
  })
  return server
}
```
<!-- /snippet -->

## Tick rates

Two loops drive every room. The **simulation** (`simulation.tickRate`,
default 60/s) calls `onTick` with a fixed step. The **sync**
(`sync.tickRate`, default 20/s) sends each client what changed since the
last sync. They are independent: a faster sync makes movement smoother
and costs more bandwidth, and a slower simulation saves CPU. A room can
set its own rates from `onCreate` (`setSimulationTickRate`,
`setStateSyncTickRate`).

If the server falls behind, a wake runs at most
`simulation.maxCatchUpSteps` (default 5) steps and drops the rest of the
backlog, so one slow tick can't snowball into ever-longer catch-ups.

## Limits

Every connection is limited by default, with headroom a normal game never
reaches. `limits: false` turns them off. In each group, a `0` means "no
limit" for that number.

| Limit | Default | When passed |
|---|---|---|
| `messages.perSecond` / `burst` | 200/s, plus a burst of 400 | the connection is closed with **1013** |
| `messages.bytesPerSecond` | 1 MiB/s | closed with 1013 |
| `joins.perMinute` | 60 | that join fails with `RATE_LIMITED`; the connection stays open |
| `backpressure.pauseBytes` / `resumeBytes` | 256 KiB / 64 KiB | the client stops receiving patches, then is re-synced |
| `backpressure.maxPausedMs` | 15 s | closed with 1013 |
| `backpressure.disconnectBytes` | 4 MiB | closed with 1013 at once |

Inbound limits are checked before a frame is even decoded, so a flood
costs the server very little.

**Why a slow client is paused, not skipped.** State patches are deltas,
each building on the one before. Skipping one would leave that client
wrong for good. So when a client stops reading (a backgrounded tab, a
congested link) and its queue passes `pauseBytes`, the server stops
generating patches for it. Once the queue drains to `resumeBytes`, the
client gets a fresh snapshot and carries on. If it doesn't drain in
`maxPausedMs`, or the queue ever passes `disconnectBytes`, the server
cuts the connection. The two thresholds are hysteresis: a single value
would re-snapshot a flapping client on every tick.

**Close code 1013** ("try again later") means the server shed the
connection for a limit, not for anything malformed. client-js treats it
like any dropped connection and reconnects with its usual backoff. The
close reason says which limit.

Your own game rules are separate from these: validate every message
(see [messages](messages.md#compile-time-only-and-why-thats-safe)).

## Metrics

`metrics: { enabled: true }` turns on counters. They're off by default,
and cost nothing when off.

<!-- snippet: docs/examples/src/production.ts#metrics -->
[`docs/examples/src/production.ts`](../examples/src/production.ts)

```ts
export function report(server: BungohanServer): string {
  const metrics = server.getServerMetrics() // Result: METRICS_DISABLED if off
  if (metrics.isErr()) return metrics.error.code
  const m = metrics.value
  return `${m.activeConnections} connected, ${m.activeRooms} rooms, ${m.totalShed} shed`
}
```
<!-- /snippet -->

- `server.getServerMetrics()`: connections, rooms, messages and bytes
  in and out, errors, `totalShed` (connections closed with 1013), memory.
- `server.getAllRoomMetrics()`: per room, tick and sync durations,
  `avgStateDeltaBytes` and `avgStateSnapshotBytes`,
  `droppedSimulationMs` (time lost to the catch-up cap), and `syncPauses`
  (how often a client that stopped reading was paused, see
  [limits](#limits)).
- `server.getAllClientMetrics()`: per seat, frames and bytes each way,
  and `avgLatency` from the clients' pings.

Each returns a `Result`, with `METRICS_DISABLED` when metrics are off.

## HTTP endpoints

`http: { enabled: true }` starts a separate HTTP server (port 8080 by
default) with:

| Endpoint | Returns |
|---|---|
| `GET /health` | always 200 while the process runs: `{ status, processId, uptime, rooms, connections, draining }`; `status` is `"shutting_down"` during a graceful stop |
| `GET /ready` | 200 `{ status: "ready", processId, rooms }` while the process takes new work; **503** with `status` `"draining"` or `"shutting_down"` otherwise |
| `GET /metrics` | `{ server, rooms }` from the getters above (404 when metrics are off); private rooms are counted without their `roomId` |
| `GET /rooms` | every ready **public** room: id, type, clients, maxClients, visibility, locked, metadata |

Each can be switched off (`enableHealthCheck`, `enableReadiness`,
`enableMetrics`, `enableRoomsList`), and CORS headers are on unless
`cors: false`. Private rooms never appear with their ids: a private room
can be joined by id, so its id is what keeps it private.

## Health and readiness

The two endpoints answer different questions, so give each its own
probe:

- **`/health` is liveness**: "is the process alive?". It stays 200 while
  the process runs, draining included. Restart the process only when it
  fails.
- **`/ready` is readiness**: "should it get new connections?". It turns
  503 as soon as the process [drains](scaling.md#draining-a-process) or
  starts stopping, and back to 200 on `cancelDrain()`. Take the process
  out of your load balancer's rotation when it fails, and don't restart
  it: its games are still running.

`server.isReady()` gives the same answer in code. In Kubernetes:

```yaml
livenessProbe:
  httpGet: { path: /health, port: 8080 }
readinessProbe:
  httpGet: { path: /ready, port: 8080 }
  periodSeconds: 2
```

A draining process still accepts connections that reach it anyway,
because a player reconnecting to a held seat may need to (outside cluster
mode that seat can only be on this process). Readiness is what keeps new
players away.

## Graceful shutdown

`server.start()` installs SIGTERM and SIGINT handlers (unless
`gracefulShutdown.handleSignals` is false). On a signal, or when you call
`server.stop()`:

1. new joins fail with `SERVER_SHUTTING_DOWN`,
2. every room is disposed: its clients get `LEAVE` with code
   `SERVER_SHUTDOWN` (4001), then `onLeave(client, false)` and
   `onDispose` run, so this is where to save state,
3. connections close with 1001, and the HTTP server stops.

After a signal, `onShutdown` runs and the process exits with 0, or with 1
if stopping took longer than `gracefulShutdown.timeout` (default 30 s).

**Drain first.** By default a signal ends every game at once. With
`gracefulShutdown.drainTimeout` (milliseconds, off by default), a signal
first [drains](scaling.md#draining-a-process) the process: no new rooms,
`/ready` turns 503, and games already running carry on. Once the last
room ends, or `drainTimeout` passes, it stops as above. A second signal
skips the rest of the drain. This fits orchestrators that send SIGTERM
and then wait, such as Kubernetes: set its
`terminationGracePeriodSeconds` above `drainTimeout` plus `timeout`.
Without cluster mode there is nowhere else for new rooms to go, so while
draining, joins that need a new room fail with `SERVER_SHUTTING_DOWN`,
and your load balancer should already be sending players to the new
instance.

Clients see the 1001 as a dropped connection and reconnect, which is what
you want across a restart or deploy. Seats aren't held across a restart,
though: a single process loses its rooms when it stops, so a
reconnecting client finds nothing to resume and is told it left
(`DISCONNECTED`). Surviving that is what persistence (`saveState`) and
[cluster mode](scaling.md) are for.

## Checklist

- Serve over `wss://`, with TLS terminated by your proxy or load
  balancer. The server speaks plain WebSocket on `transport.config.port`.
- Verify tokens in `onAuth`: the framework doesn't.
- Validate game rules in every message handler: the types are
  guaranteed, the values aren't.
- Deploy client and server together. A stale client gets
  `CONTRACT_MISMATCH` on its next join: ask the player to reload.
- Use `server.onError` to send hook and handler errors to your logging.
- Point your load balancer's health check at `/ready`, not `/health`,
  and drain a process before replacing it.
