import { err, ok, type Result } from "@bungohan/result"
import type { Server } from "bun"

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
  /** Serve `GET /rooms`. */
  enableRoomsList: boolean
}

/** What the HTTP endpoints read from the game server. */
export interface HttpSource {
  health(): unknown
  /** `undefined` when metrics are disabled (the endpoint answers 404). */
  metrics(): unknown
  rooms(): unknown
}

/**
 * The optional built-in HTTP server: `GET /health`, `GET /metrics` and
 * `GET /rooms` as JSON, each individually switchable. Runs on its own
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

  private _handle(request: Request): Response {
    if (request.method === "OPTIONS" && this._options.cors) {
      return new Response(null, { status: 204, headers: this._headers() })
    }
    if (request.method !== "GET") return this._json({ error: "not found" }, 404)
    const path = new URL(request.url).pathname
    const o = this._options
    if (path === "/health" && o.enableHealthCheck) {
      return this._json(this._source.health())
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
    return this._json({ error: "not found" }, 404)
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
