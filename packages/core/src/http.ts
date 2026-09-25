import { err, ok, type Result } from "@bungohan/result"
import type { Server } from "bun"
import type { RoomMetrics, ServerMetrics } from "./metrics"

/** What the HTTP server knows about a request beyond the `Request`. */
export interface HttpRequestInfo {
  /**
   * The peer's address as the socket sees it (`"unknown"` if Bun can't
   * tell), as `ConnectionContext.ip` is for a WebSocket. Behind a proxy
   * it is the proxy's: read `X-Forwarded-For` only from a proxy you trust.
   */
  ip: string
}

/**
 * A handler for requests the built-in endpoints don't answer
 * (`ServerOptions.http.fetch`). Return `undefined` to fall through to the
 * built-in answer: a CORS preflight, or a 404. `info.ip` is the caller's
 * address, for per-client rate limits.
 */
export type HttpFallback = (
  request: Request,
  info: HttpRequestInfo,
) => Response | undefined | Promise<Response | undefined>

/** A built-in endpoint: `GET /health`, `/ready`, `/metrics` or `/rooms`. */
export type HttpEndpoint = "health" | "ready" | "metrics" | "rooms"

/** What `ServerOptions.http.authorize` is told about a request. */
export interface HttpAuthorizeInfo extends HttpRequestInfo {
  /** The built-in endpoint the request is for. */
  endpoint: HttpEndpoint
}

/**
 * Decides whether a request may read a built-in endpoint
 * (`ServerOptions.http.authorize`). `false` answers 403; a throw answers
 * 500 and goes to `server.onError`.
 */
export type HttpAuthorize = (
  request: Request,
  info: HttpAuthorizeInfo,
) => boolean | Promise<boolean>

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
  /** Gates the built-in endpoints; `undefined` lets every request in. */
  authorize: HttpAuthorize | undefined
}

/** What the HTTP endpoints read from the game server. */
export interface HttpSource {
  health(): HealthResponse
  /** Whether to answer `GET /ready` with 200 (or 503), and the body. */
  ready(): { ready: boolean; body: ReadyResponse }
  /** `undefined` when metrics are disabled (the endpoint answers 404). */
  metrics(): MetricsResponse | undefined
  rooms(): RoomsResponseEntry[]
  /** `fetch` or `authorize` threw or rejected (it answers 500). */
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
        fetch: (request, server) =>
          this._handle(request, {
            ip: server.requestIP(request)?.address ?? "unknown",
          }),
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

  private async _handle(
    request: Request,
    info: HttpRequestInfo,
  ): Promise<Response> {
    const endpoint = this._endpoint(request)
    if (endpoint !== undefined) {
      const authorize = this._options.authorize
      if (authorize !== undefined) {
        try {
          if (!(await authorize(request, { ...info, endpoint }))) {
            return this._json({ error: "forbidden" }, 403)
          }
        } catch (error) {
          this._source.reportError(error)
          return this._json({ error: "internal error" }, 500)
        }
      }
      return this._answer(endpoint)
    }
    const fallback = this._options.fetch
    if (fallback !== undefined) {
      try {
        const response = await fallback(request, info)
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

  /** The enabled built-in endpoint a request is for, or undefined. */
  private _endpoint(request: Request): HttpEndpoint | undefined {
    if (request.method !== "GET") return undefined
    const path = new URL(request.url).pathname
    const o = this._options
    if (path === "/health" && o.enableHealthCheck) return "health"
    if (path === "/ready" && o.enableReadiness) return "ready"
    if (path === "/metrics" && o.enableMetrics) return "metrics"
    if (path === "/rooms" && o.enableRoomsList) return "rooms"
    return undefined
  }

  private _answer(endpoint: HttpEndpoint): Response {
    switch (endpoint) {
      case "health":
        return this._json(this._source.health())
      case "ready": {
        const { ready, body } = this._source.ready()
        return this._json(body, ready ? 200 : 503)
      }
      case "metrics": {
        const metrics = this._source.metrics()
        return metrics === undefined
          ? this._json({ error: "metrics are disabled" }, 404)
          : this._json(metrics)
      }
      case "rooms":
        return this._json(this._source.rooms())
    }
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
