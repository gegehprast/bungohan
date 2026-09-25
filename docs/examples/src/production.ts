import {
  type BungohanServer,
  createBungohanServer,
  type HttpAuthorizeInfo,
  type HttpRequestInfo,
  type MetricsResponse,
} from "@bungohan/core"
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
      enabled: true, // /health, /ready, /metrics, /rooms on their own port
      port: env.httpPort,
      fetch: (request) => adminRoutes(server, request), // and your own
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
// #endregion server

// #region metrics
export function report(server: BungohanServer): string {
  const metrics = server.getServerMetrics() // Result: METRICS_DISABLED if off
  if (metrics.isErr()) return metrics.error.code
  const m = metrics.value
  return `${m.activeConnections} connected, ${m.activeRooms} rooms, ${m.totalShed} shed`
}
// #endregion metrics

// #region http-routes
/** An admin API on the HTTP port, next to /health and /metrics. */
export async function adminRoutes(
  server: BungohanServer,
  request: Request,
): Promise<Response | undefined> {
  const { pathname } = new URL(request.url)
  if (!pathname.startsWith("/admin/")) return undefined // the built-in 404
  // Nothing checks who is asking: that part is yours.
  const token = process.env["ADMIN_TOKEN"]
  const auth = request.headers.get("authorization")
  if (token === undefined || auth !== `Bearer ${token}`) {
    return new Response("forbidden", { status: 403 })
  }
  if (request.method === "POST" && pathname === "/admin/arenas") {
    const room = await server.getMatchMaker().createRoom(ArenaRoom, { gems: 5 })
    return room.isOk()
      ? Response.json({ roomId: room.value.id }, { status: 201 })
      : Response.json({ error: room.error.code }, { status: 503 })
  }
  return undefined
}
// #endregion http-routes

// #region metrics-response
/** Another process reading this one's /metrics, typed. */
export async function busiestRoom(base: string): Promise<string | undefined> {
  const body: MetricsResponse = await (await fetch(`${base}/metrics`)).json()
  const [top] = [...body.rooms].sort((a, b) => b.clientCount - a.clientCount)
  return top?.roomId // absent for a private room
}
// #endregion metrics-response

// #region http-authorize
/**
 * For `http.authorize`: load balancer probes get through, but room
 * listings and load figures need the operations token.
 */
export function opsOnly(request: Request, info: HttpAuthorizeInfo): boolean {
  if (info.endpoint === "health" || info.endpoint === "ready") return true
  const token = process.env["OPS_TOKEN"]
  const auth = request.headers.get("authorization")
  return token !== undefined && auth === `Bearer ${token}`
}
// #endregion http-authorize

// #region http-ip
const signups = new Map<string, { since: number; count: number }>()

/** A public route, limited to 10 calls a minute per caller address. */
export function signupRoute(
  request: Request,
  info: HttpRequestInfo,
): Response | undefined {
  if (new URL(request.url).pathname !== "/signup") return undefined
  // The socket's peer. Behind a proxy that's the proxy: read
  // X-Forwarded-For instead, set by a proxy you trust.
  const now = Date.now()
  const seen = signups.get(info.ip)
  const current =
    seen !== undefined && now - seen.since < 60_000
      ? seen
      : { since: now, count: 0 }
  current.count++
  signups.set(info.ip, current)
  if (current.count > 10) return new Response("slow down", { status: 429 })
  return Response.json({ signedUp: true })
}
// #endregion http-ip
