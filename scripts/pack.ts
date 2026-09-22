/**
 * Packs every published package into a tarball that is exactly what gets
 * published — `bun publish` is then handed the tarball, never a directory.
 *
 *     bun run pack            # → .pack/*.tgz
 *
 * Why a script rather than `bun publish` from each package directory:
 *
 *  - The manifests in `packages/*` point `main`/`exports` at `./src/*.ts`,
 *    because the monorepo runs on raw TypeScript and must keep doing so with
 *    no build step. The published entry points live in `publishConfig`, the
 *    standard npm place for exactly this. **Neither `bun pm pack` nor
 *    `npm pack` applies `publishConfig`** — a tarball packed by either still
 *    claims `"main": "./src/index.ts"`, a file it doesn't contain — so this
 *    script applies it, and `check:pack` asserts the result in the tarball.
 *  - `workspace:*` and `catalog:` are resolved here, to exact versions, so
 *    no protocol can reach a published `package.json` whatever tool is used.
 *  - README links are relative so they work on GitHub and in an editor;
 *    npm's viewer resolves them against the repo root, which `../../docs/…`
 *    escapes, so they're rewritten to absolute GitHub URLs when packing.
 *
 * Each package is staged in `.pack/<name>/` holding just the files `files`
 * allows — dist, README, LICENSE — so what is packed can't be more than what
 * is listed.
 */

import { cp, mkdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { Glob } from "bun"
import { PUBLISHED, packageDir, REPO_URL, ROOT } from "./packages"

const STAGE = join(ROOT, ".pack")

type Deps = Record<string, string>

interface Manifest {
  name: string
  version: string
  dependencies?: Deps
  peerDependencies?: Deps
  devDependencies?: Deps
  publishConfig?: Record<string, unknown>
  scripts?: Record<string, string>
  [key: string]: unknown
}

/** The versions behind `catalog:`, from the root workspace. */
async function catalog(): Promise<Deps> {
  const root = await Bun.file(join(ROOT, "package.json")).json()
  return (root.workspaces?.catalog ?? {}) as Deps
}

/** The exact version each workspace package will publish under. */
async function workspaceVersions(): Promise<Deps> {
  const versions: Deps = {}
  for (const name of PUBLISHED) {
    const pkg = await Bun.file(join(packageDir(name), "package.json")).json()
    versions[pkg.name] = pkg.version
  }
  return versions
}

/** Resolves `workspace:*` and `catalog:` away; throws if one can't be. */
function resolveDeps(
  deps: Deps | undefined,
  where: string,
  versions: Deps,
  cat: Deps,
): Deps | undefined {
  if (deps === undefined) return undefined
  const out: Deps = {}
  for (const [name, range] of Object.entries(deps)) {
    if (range.startsWith("workspace:")) {
      const version = versions[name]
      if (version === undefined) {
        throw new Error(
          `${where} depends on ${name} with ${range}, but ${name} is not ` +
            "published — it can't be resolved to a version",
        )
      }
      out[name] = version
    } else if (range.startsWith("catalog:")) {
      const version = cat[name]
      if (version === undefined) {
        throw new Error(`${where}: no catalog entry for ${name}`)
      }
      out[name] = version
    } else {
      out[name] = range
    }
  }
  return out
}

/** The manifest as published: entry points applied, protocols resolved. */
export function publishManifest(
  source: Manifest,
  versions: Deps,
  cat: Deps,
): Manifest {
  const { publishConfig = {}, ...rest } = source
  const { access, main, module, types, exports } = publishConfig as Record<
    string,
    unknown
  >
  const manifest: Manifest = {
    ...rest,
    // Spread in place: `main`, `types` and `exports` already have a slot in
    // `rest`, so overwriting them keeps the manifest's key order readable.
    ...(main !== undefined && { main }),
    ...(module !== undefined && { module }),
    ...(types !== undefined && { types }),
    ...(exports !== undefined && { exports }),
    ...(access !== undefined && { publishConfig: { access } }),
  }
  const where = source.name
  manifest.dependencies = resolveDeps(source.dependencies, where, versions, cat)
  manifest.peerDependencies = resolveDeps(
    source.peerDependencies,
    where,
    versions,
    cat,
  )
  // Nothing installing this package needs them, and a `prepare` script in a
  // tarball runs on install.
  delete manifest.devDependencies
  delete manifest.scripts
  for (const key of ["dependencies", "peerDependencies"] as const) {
    if (manifest[key] === undefined) delete manifest[key]
  }
  return manifest
}

const LINK = /(\]\()(\.[^)\s]+)(\))/g

/** Rewrites README links that point outside the package to GitHub URLs. */
export function absoluteLinks(markdown: string, dir: string): string {
  return markdown.replace(LINK, (whole, open, target: string, close) => {
    const [path, anchor] = target.split("#")
    if (path === undefined || path === "") return whole
    const resolved = new URL(path, `file:///${dir}/`).pathname.slice(1)
    const suffix = anchor === undefined ? "" : `#${anchor}`
    return `${open}${REPO_URL}/blob/main/${resolved}${suffix}${close}`
  })
}

async function stage(name: string): Promise<string> {
  const dir = packageDir(name)
  const out = join(STAGE, name)
  await rm(out, { recursive: true, force: true })
  await mkdir(out, { recursive: true })

  const source: Manifest = await Bun.file(join(dir, "package.json")).json()
  const manifest = publishManifest(
    source,
    await workspaceVersions(),
    await catalog(),
  )
  await Bun.write(
    join(out, "package.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  )

  if ((await Bun.file(join(dir, "dist", "index.js")).exists()) === false) {
    throw new Error(`${name} has no dist/index.js — run \`bun run build\``)
  }
  await cp(join(dir, "dist"), join(out, "dist"), { recursive: true })
  await Bun.write(
    join(out, "README.md"),
    absoluteLinks(
      await Bun.file(join(dir, "README.md")).text(),
      `packages/${name}`,
    ),
  )
  // Each package carries its own copy (kept identical to the root one by
  // scripts/license.test.ts), so the license is visible where the package is,
  // on GitHub as well as on npm.
  await cp(join(dir, "LICENSE"), join(out, "LICENSE"))
  return out
}

/** Packs the staged package; returns the tarball's absolute path. */
async function pack(name: string, dir: string): Promise<string> {
  const proc = Bun.spawn(["bun", "pm", "pack", "--destination", STAGE], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0) throw new Error(`pack failed for ${name}:\n${out}${err}`)
  for await (const file of new Glob("*.tgz").scan(STAGE)) {
    if (file.startsWith(`bungohan-${name}-`)) return join(STAGE, file)
  }
  throw new Error(`pack produced no tarball for ${name}:\n${out}${err}`)
}

if (import.meta.main) {
  await rm(STAGE, { recursive: true, force: true })
  await mkdir(STAGE, { recursive: true })
  const tarballs: string[] = []
  for (const name of PUBLISHED) {
    tarballs.push(await pack(name, await stage(name)))
  }
  for (const path of tarballs) {
    const size = (Bun.file(path).size / 1024).toFixed(0)
    console.log(`${size.padStart(5)} KB  ${path.slice(ROOT.length + 1)}`)
  }
  console.log(`\n${tarballs.length} tarballs in .pack/`)
}
