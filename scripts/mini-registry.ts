/**
 * A read-only npm registry over the packed tarballs, for `check:pack`.
 *
 * The fixture can't install the tarballs as `file:` paths: a tarball's own
 * `@bungohan/*` dependencies are version ranges, and a resolver answers those
 * from a registry, not from whatever files happen to be lying around. Forcing
 * them with `overrides` would guarantee one `@bungohan/state` by construction
 * and prove nothing (spec §6.10). So the fixture points the `@bungohan` scope
 * at this server and installs the real way: ranges in, dedupe, a lockfile.
 *
 * It serves exactly two things — a packument per package and its tarball —
 * which is all `bun install` asks of a registry for a fixed version.
 */
import { createHash } from "node:crypto"
import { basename } from "node:path"

export interface Served {
  /** e.g. `@bungohan/core`. */
  readonly name: string
  readonly version: string
  readonly path: string
}

export interface Registry {
  readonly url: string
  stop(): Promise<void>
}

interface Entry {
  readonly manifest: Record<string, unknown>
  readonly bytes: Uint8Array<ArrayBuffer>
}

async function entry(served: Served, url: string): Promise<Entry> {
  const file = Bun.file(served.path)
  const bytes = new Uint8Array(await file.arrayBuffer())
  const proc = Bun.spawnSync([
    "tar",
    "-xzOf",
    served.path,
    "package/package.json",
  ])
  const manifest = JSON.parse(new TextDecoder().decode(proc.stdout))
  const sha1 = createHash("sha1").update(bytes).digest("hex")
  const sha512 = createHash("sha512").update(bytes).digest("base64")
  manifest.dist = {
    tarball: `${url}/${served.name}/-/${basename(served.path)}`,
    shasum: sha1,
    integrity: `sha512-${sha512}`,
  }
  return { manifest, bytes }
}

/** Starts the registry; every package is served at its own version only. */
export async function startRegistry(packages: Served[]): Promise<Registry> {
  const server = Bun.serve({
    port: 0,
    fetch: () => new Response("not found", { status: 404 }),
  })
  const url = `http://127.0.0.1:${server.port}`

  const entries = new Map<string, Entry>()
  const tarballs = new Map<string, Uint8Array<ArrayBuffer>>()
  for (const served of packages) {
    const built = await entry(served, url)
    entries.set(served.name, built)
    tarballs.set(basename(served.path), built.bytes)
  }

  server.reload({
    fetch(request: Request): Response {
      const path = decodeURIComponent(new URL(request.url).pathname)
      const tarball = /\/-\/([^/]+\.tgz)$/.exec(path)?.[1]
      if (tarball !== undefined) {
        const bytes = tarballs.get(tarball)
        if (bytes === undefined)
          return new Response("no tarball", { status: 404 })
        return new Response(bytes, {
          headers: { "content-type": "application/octet-stream" },
        })
      }
      const entry = entries.get(path.replace(/^\//, ""))
      if (entry === undefined)
        return new Response("no package", { status: 404 })
      const version = entry.manifest["version"] as string
      return Response.json({
        name: entry.manifest["name"],
        "dist-tags": { latest: version },
        versions: { [version]: entry.manifest },
      })
    },
  })

  return {
    url,
    async stop(): Promise<void> {
      await server.stop(true)
    },
  }
}
