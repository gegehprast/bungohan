import {
  type BungohanServer,
  createBungohanServer,
  type ProcessInfo,
  type ProcessSelector,
} from "@bungohan/core"
import { ArenaRoom } from "@bungohan/tutorial-server/ArenaRoom"

// #region cluster
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
// #endregion cluster

// #region region-selector
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
// #endregion region-selector

// #region region-placement
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
// #endregion region-placement

// #region rolling-deploy
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
// #endregion rolling-deploy

// #region events
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
// #endregion events
