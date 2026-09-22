import { type BungohanServer, createBungohanServer } from "@bungohan/core"
import { ArenaRoom } from "@bungohan/tutorial-server/ArenaRoom"

// #region cluster
/** One process of a cluster. Run as many as you like behind a load balancer. */
export function createClusterServer(env: {
  port: number
  redisUrl: string
  processId?: string
  namespace?: string
}): BungohanServer {
  const server = createBungohanServer({
    transport: { config: { port: env.port } },
    cluster: {
      enabled: true,
      processId: env.processId, // default: random
      namespace: env.namespace, // default "bungohan": clusters sharing a Redis differ here
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
// #endregion cluster
