import { type BungohanServer, createBungohanServer } from "@bungohan/core"
import { ArenaRoom } from "@bungohan/tutorial-server/ArenaRoom"

// #region server
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
      enabled: true, // /health, /metrics, /rooms on their own port
      port: env.httpPort,
      enableRoomsList: false, // /rooms lists private rooms too
    },
    gracefulShutdown: {
      timeout: 10_000, // exit(1) if stopping takes longer
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
// #endregion server

// #region metrics
export function report(server: BungohanServer): string {
  const metrics = server.getServerMetrics() // Result: METRICS_DISABLED if off
  if (metrics.isErr()) return metrics.error.code
  const m = metrics.value
  return `${m.activeConnections} connected, ${m.activeRooms} rooms, ${m.totalShed} shed`
}
// #endregion metrics
