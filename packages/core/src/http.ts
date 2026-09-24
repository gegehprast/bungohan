import { err, ok, type Result } from "@bungohan/result"
import type { Server } from "bun"
import type { RoomMetrics, ServerMetrics } from "./metrics"

/**
 * A handler for requests the built-in endpoints don't answer
 * (`ServerOptions.http.fetch`). Return `undefined` to fall through to the
 * built-in answer: a CORS preflight, or a 404.
 */
export type HttpFallback = (
  request: Request,
) => Response | undefined | Promise<Response | undefined>

/** `GET /health`'s body. */
export interface HealthResponse {
  /** `"shutting_down"` from the start of a graceful stop. */
  status: "ok" | "shutting_down"
  /** This process's id. */
  processId: string
  /** Seconds since `start()`. */
  uptime: number
  /** Rooms on this process, private ones included. */
  rooms: number
  /** Connections open now. */
  connections: number
  /** Whether the process is draining (`server.drain()`). */
  draining: boolean
}

/** `GET /ready`'s body: status 200 when `"ready"`, 503 otherwise. */
export interface ReadyResponse {
  /** `"draining"` after `server.drain()`, `"shutting_down"` once stopping. */
  status: "ready" | "draining" | "shutting_down"
  /** This process's id. */
  processId: string
  /** Rooms on this process, private ones included. */
  rooms: number
}

/**
 * One room in `GET /metrics`. A private room is counted without its
 * `roomId`: anyone who knew the id could join it.
 */
export type RoomMetricsEntry = Omit<RoomMetrics, "roomId"> & {
  /** The room's id; absent for a private room. */
  roomId?: string
}

/** `GET /metrics`'s body (404 while metrics are off). */
export interface MetricsResponse {
  /** Process-wide numbers, as `server.getServerMetrics()` returns them. */
  server: ServerMetrics
  /** Every room on this process, private ones without their id. */
  rooms: RoomMetricsEntry[]
}

/** One entry of `GET /rooms`, which lists ready public rooms only. */
export interface RoomsResponseEntry {
  /** The room's id, for `joinById`. */
  id: string
  /** Its room type. */
  type: string
  /** Seats taken (joining, joined and held). */
  clients: number
  /** Its `maxClients`. */
  maxClients: number
  /** Always `"public"`: private rooms aren't listed. */
  visibility: "public"
  /** A locked room refuses new joins. */
  locked: boolean
  /** The room's `metadata`. */
  metadata: Record<string, unknown>
}

/**
 * {@link HttpServer}'s settings, all required (the server fills them from
 * `ServerOptions.http` and its defaults).
 */
export interface HttpServerOptions {
  /** The port to listen on; `0` picks a free one. */
  port: number
  /** The interface to bind, e.g. `"0.0.0.0"`. */
  hostname: string
  /** Answer with `Access-Control-Allow-Origin: *` (and to preflights). */
  cors: boolean
  /** Serve `GET /metrics` (404 while metrics are off). */
  enableMetrics: boolean
  /** Serve `GET /health`. */
  enableHealthCheck: boolean
  /** Serve `GET /ready`. */
  enableReadiness: boolean
  /** Serve `GET /rooms`. */
  enableRoomsList: boolean
  /** Answers what the built-in endpoints don't; `undefined` for none. */
  fetch: HttpFallback | undefined
}

/** What the HTTP endpoints read from the game server. */
export interface HttpSource {
  health(): HealthResponse
  /** Whether to answer `GET /ready` with 200 (or 503), and the body. */
  ready(): { ready: boolean; body: ReadyResponse }
  /** `undefined` when metrics are disabled (the endpoint answers 404). */
  metrics(): MetricsResponse | undefined
  rooms(): RoomsResponseEntry[]
  /** The `fetch` fallback threw or rejected (it answers 500). */
  reportError(error: unknown): void
}

/**
 * The optional built-in HTTP server: `GET /health` (liveness: 200 while
 * the process runs), `GET /ready` (readiness: 503 while it drains or
 * stops), `GET /metrics` and `GET /rooms` as JSON, each individually
 * switchable. Runs on its own
 * port, separate from the WebSocket transport. The game server creates it
 * when `ServerOptions.http.enabled` is set (see
 * docs/guides/production.md#http-endpoints); `server.getHttpServer()`
 * returns it.
 */
export class HttpServer {
  private readonly _options: HttpServerOptions
  private readonly _source: HttpSource
  private _server: Server<undefined> | undefined

  public constructor(options: HttpServerOptions, source: HttpSource) {
    this._options = options
    this._source = source
  }

  /** Starts listening. Starting twice is `ok`; a busy port is an `err`. */
  public start(): Result<void, Error> {
    if (this._server !== undefined) return ok(undefined)
    try {
      this._server = Bun.serve({
        port: this._options.port,
        hostname: this._options.hostname,
        fetch: (request) => this._handle(request),
      })
      return ok(undefined)
    } catch (error) {
      return err(error instanceof Error ? error : new Error(String(error)))
    }
  }

  /** Stops listening and drops open requests. */
  public async stop(): Promise<void> {
    const server = this._server
    this._server = undefined
    await server?.stop(true)
  }

  /** The bound port (useful with port 0), or undefined when stopped. */
  public getPort(): number | undefined {
    return this._server?.port
  }

  private async _handle(request: Request): Promise<Response> {
    const builtIn = this._builtIn(request)
    if (builtIn !== undefined) return builtIn
    const fallback = this._options.fetch
    if (fallback !== undefined) {
      try {
        const response = await fallback(request)
        if (response !== undefined) return response
      } catch (error) {
        this._source.reportError(error)
        return this._json({ error: "internal error" }, 500)
      }
    }
    if (request.method === "OPTIONS" && this._options.cors) {
      return new Response(null, { status: 204, headers: this._headers() })
    }
    return this._json({ error: "not found" }, 404)
  }

  /** The answer of an enabled built-in endpoint, or undefined. */
  private _builtIn(request: Request): Response | undefined {
    if (request.method !== "GET") return undefined
    const path = new URL(request.url).pathname
    const o = this._options
    if (path === "/health" && o.enableHealthCheck) {
      return this._json(this._source.health())
    }
    if (path === "/ready" && o.enableReadiness) {
      const { ready, body } = this._source.ready()
      return this._json(body, ready ? 200 : 503)
    }
    if (path === "/metrics" && o.enableMetrics) {
      const metrics = this._source.metrics()
      return metrics === undefined
        ? this._json({ error: "metrics are disabled" }, 404)
        : this._json(metrics)
    }
    if (path === "/rooms" && o.enableRoomsList) {
      return this._json(this._source.rooms())
    }
    return undefined
  }

  private _headers(): Record<string, string> {
    return this._options.cors
      ? {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, OPTIONS",
          "access-control-allow-headers": "content-type",
        }
      : {}
  }

  private _json(body: unknown, status = 200): Response {
    return Response.json(body, { status, headers: this._headers() })
  }
}
