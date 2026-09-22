/**
 * Proves the published packages work when installed from tarballs, outside
 * this monorepo.
 *
 *     bun run check:pack
 *
 * It builds, packs, and then installs *only* the tarballs into a fresh
 * project in the system temp directory — outside the repo, so nothing can
 * resolve through a workspace symlink and quietly pass on the source. The
 * fixture under `scripts/pack-fixture/` is an ordinary little game: a shared
 * module importing only `@bungohan/schema`, a Bun server on
 * `@bungohan/core`, a browser client on `@bungohan/client-js` and its React
 * subpath, and a `@bungohan/testing` suite.
 *
 * What it asserts, in order:
 *
 *  1. the tarballs' manifests: no `workspace:`/`catalog:` survived, entry
 *     points and `files` point at what's actually inside, license and
 *     repository metadata are there;
 *  2. the fixture's lockfile resolves exactly one `@bungohan/state`
 *     (spec §6.10: two copies mean two `Schema` classes);
 *  3. the published `.d.ts` typecheck under TypeScript 7 and under the
 *     latest 5.x, as declarations (`skipLibCheck` off) and under `node16`
 *     resolution as well as `bundler`;
 *  4. the JSDoc survived declaration emit, for a few members whose docs a
 *     user reads on hover;
 *  5. the harness runs a test;
 *  6. the server starts and a client joins it over a real socket and gets
 *     the state back;
 *  7. the browser entry bundles with `bun build --target=browser` and with
 *     Vite, pulling in no server code (the browser-safety audit, re-run
 *     against installed packages and the built output).
 *
 * Needs the network for the fixture's own devDependencies (Vite, React,
 * TypeScript 5). `bun run verify --no-pack` skips it, as SKIPPED.
 */

import { cp, mkdtemp, rm } from "node:fs/promises"
import { builtinModules } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Glob } from "bun"
import { startRegistry } from "./mini-registry"
import { PUBLISHED, ROOT, version } from "./packages"

const FIXTURE = join(ROOT, "scripts", "pack-fixture")
/** The latest TypeScript 5.x, installed alongside 7 under an alias. */
const TS5 = "^5.9.3"

interface Check {
  readonly name: string
  readonly run: () => Promise<string[]>
}

interface Run {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
  readonly output: string
}

async function sh(
  cmd: string[],
  options: { cwd: string; env?: Record<string, string> } = { cwd: ROOT },
): Promise<Run> {
  const proc = Bun.spawn(cmd, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, stdout, stderr, output: `${stdout}${stderr}` }
}

/** Fails with the command's own output, which is what says what broke. */
function must(run: Run, what: string): string[] {
  if (run.code === 0) return []
  return [`${what} (exit ${run.code})\n${run.output.trimEnd()}`]
}

// ── the tarballs ───────────────────────────────────────────────────────────

interface Tarball {
  readonly name: string
  readonly path: string
  readonly manifest: Record<string, unknown>
  readonly entries: string[]
}

async function readTarball(name: string, path: string): Promise<Tarball> {
  const list = await sh(["tar", "-tzf", path], { cwd: ROOT })
  const manifest = await sh(["tar", "-xzOf", path, "package/package.json"], {
    cwd: ROOT,
  })
  return {
    name,
    path,
    manifest: JSON.parse(manifest.stdout),
    entries: list.stdout.trim().split("\n"),
  }
}

/** Every `workspace:`/`catalog:` range left in a manifest, as JSON text. */
function unresolvedProtocols(manifest: Record<string, unknown>): string[] {
  const found: string[] = []
  for (const field of ["dependencies", "peerDependencies", "devDependencies"]) {
    const deps = manifest[field] as Record<string, string> | undefined
    for (const [dep, range] of Object.entries(deps ?? {})) {
      if (/^(workspace|catalog):/.test(range)) {
        found.push(`${field}.${dep} = "${range}"`)
      }
    }
  }
  return found
}

function checkManifest(tarball: Tarball): string[] {
  const m = tarball.manifest
  const problems: string[] = []
  const say = (why: string) =>
    problems.push(`@bungohan/${tarball.name}: ${why}`)

  for (const range of unresolvedProtocols(m)) {
    say(`${range} reached the published manifest`)
  }
  const files = new Set(tarball.entries)
  const pointers: [string, unknown][] = [
    ["main", m["main"]],
    ["types", m["types"]],
  ]
  const exports = m["exports"] as Record<string, unknown>
  for (const [key, value] of Object.entries(exports ?? {})) {
    if (typeof value === "string") pointers.push([`exports["${key}"]`, value])
    else {
      for (const [condition, target] of Object.entries(
        value as Record<string, unknown>,
      )) {
        pointers.push([`exports["${key}"].${condition}`, target])
      }
    }
  }
  for (const [field, target] of pointers) {
    if (typeof target !== "string") {
      say(`${field} is not a path`)
      continue
    }
    if (target.includes("/src/")) say(`${field} still points at source`)
    const entry = `package/${target.replace(/^\.\//, "")}`
    if (!files.has(entry)) say(`${field} → ${target}, not in the tarball`)
  }
  const listed = m["files"] as string[] | undefined
  if (listed === undefined) say("no files field")
  else {
    const extra = listed.filter(
      (f) => !["dist", "README.md", "LICENSE"].includes(f),
    )
    if (extra.length > 0) say(`files lists ${extra.join(", ")}`)
  }
  const stray = tarball.entries.filter(
    (e) =>
      !e.startsWith("package/dist/") &&
      ![
        "package/package.json",
        "package/README.md",
        "package/LICENSE",
      ].includes(e),
  )
  if (stray.length > 0) say(`packed ${stray.join(", ")}`)
  if (m["license"] !== "MIT") say("no MIT license field")
  if (m["sideEffects"] !== false) say("sideEffects is not false")
  const repo = m["repository"] as { directory?: string } | undefined
  if (repo?.directory !== `packages/${tarball.name}`) {
    say("repository.directory is missing or wrong")
  }
  if (typeof m["homepage"] !== "string") say("no homepage")
  if (!Array.isArray(m["keywords"]) || m["keywords"].length === 0) {
    say("no keywords")
  }
  if (m["private"] === true) say("marked private")
  return problems
}

/** README links must not stay relative: npm's viewer can't follow them. */
async function checkReadme(tarball: Tarball): Promise<string[]> {
  const run = await sh(["tar", "-xzOf", tarball.path, "package/README.md"], {
    cwd: ROOT,
  })
  const relative = [...run.stdout.matchAll(/\]\((\.[^)\s]+)\)/g)].map(
    (m) => m[1],
  )
  return relative.map(
    (link) =>
      `@bungohan/${tarball.name}: README link ${link} is still relative`,
  )
}

// ── the browser audit, against installed packages ──────────────────────────

const nodeBuiltins = new Set(builtinModules)

/** Why an import specifier is not browser-safe, or undefined if it is. */
function forbidden(specifier: string): string | undefined {
  if (specifier.startsWith("bun:") || specifier === "bun") return "Bun API"
  if (specifier.startsWith("node:")) return "Node builtin"
  const bare = specifier.split("/")[0] ?? specifier
  if (nodeBuiltins.has(bare)) return "Node builtin"
  if (specifier === "@bungohan/core" || specifier.startsWith("@bungohan/core/"))
    return "server package"
  return undefined
}

interface Metafile {
  readonly inputs: Record<
    string,
    { readonly imports: { path: string; original?: string }[] }
  >
}

/**
 * Server-only identifiers that must not appear in a browser bundle. They are
 * identifiers, not package names: `@bungohan/core` is named in a couple of
 * module-header comments that a non-minifying bundler keeps, so matching it
 * as text says nothing. What the module graph contains is checked separately,
 * through the bundlers' own metadata.
 */
const SERVER_MARKERS = [
  "createBungohanServer",
  "BungohanServer",
  "RoomManager",
  "MatchMaker",
  "RedisStore",
  "RedisBackplane",
  "Bun.serve",
  "bun:test",
]

function serverMarkers(bundle: string): string[] {
  return SERVER_MARKERS.filter((marker) => bundle.includes(marker))
}

// ── the run ────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const released = await version()
  console.log(`checking the ${released} tarballs from a fresh project\n`)

  const build = await sh(["bun", "run", "build"], { cwd: ROOT })
  if (build.code !== 0) {
    console.error(build.output)
    return 1
  }
  const pack = await sh(["bun", "run", "pack"], { cwd: ROOT })
  if (pack.code !== 0) {
    console.error(pack.output)
    return 1
  }

  const tarballs: Tarball[] = []
  for (const name of PUBLISHED) {
    const path = join(ROOT, ".pack", `bungohan-${name}-${released}.tgz`)
    if (!(await Bun.file(path).exists())) {
      console.error(`no tarball for @bungohan/${name} at ${path}`)
      return 1
    }
    tarballs.push(await readTarball(name, path))
  }

  // Outside the repo: a project inside it would resolve through the
  // workspace and pass on source that is not in any tarball.
  const app = await mkdtemp(join(tmpdir(), "bungohan-pack-"))
  const registry = await startRegistry(
    tarballs.map((t) => ({
      name: `@bungohan/${t.name}`,
      version: released,
      path: t.path,
    })),
  )
  try {
    return await runChecks(app, released, tarballs, registry.url)
  } finally {
    await registry.stop()
    await rm(app, { recursive: true, force: true })
  }
}

async function scaffold(
  app: string,
  released: string,
  tarballs: Tarball[],
  registry: string,
): Promise<void> {
  const files = [
    "src",
    "tsconfig.json",
    "tsconfig.dts.json",
    "tsconfig.node16.json",
    "vite.config.ts",
    "index.html",
  ]
  for (const file of files) {
    await cp(join(FIXTURE, file), join(app, file), { recursive: true })
  }
  const dependencies: Record<string, string> = {}
  for (const tarball of tarballs) {
    // The exact version, resolved through a registry like any other install.
    dependencies[`@bungohan/${tarball.name}`] = released
  }
  await Bun.write(
    join(app, "package.json"),
    `${JSON.stringify(
      {
        name: "bungohan-pack-check",
        version: "0.0.0",
        private: true,
        type: "module",
        dependencies: {
          ...dependencies,
          react: "^19.2.0",
          "react-dom": "^19.2.0",
        },
        devDependencies: {
          "@types/bun": "latest",
          "@types/react": "^19.2.0",
          "@types/react-dom": "^19.2.0",
          "@vitejs/plugin-react": "^6.1.1",
          typescript: "^7.0.2",
          // The version most users are still on, under an alias so both
          // compilers are installed at once.
          typescript5: `npm:typescript@${TS5}`,
          vite: "^8.3.0",
        },
      },
      null,
      2,
    )}\n`,
  )
  // Only the @bungohan scope comes from the local registry; everything else
  // (React, Vite, both TypeScripts) comes from npm as usual.
  await Bun.write(
    join(app, "bunfig.toml"),
    `[install.scopes]\nbungohan = { url = "${registry}/" }\n`,
  )
}

async function runChecks(
  app: string,
  released: string,
  tarballs: Tarball[],
  registry: string,
): Promise<number> {
  await scaffold(app, released, tarballs, registry)

  const install = await sh(["bun", "install"], { cwd: app })
  if (install.code !== 0) {
    console.error(`bun install failed in the fixture:\n${install.output}`)
    return 1
  }

  const modules = join(app, "node_modules")
  const ts7 = join(modules, ".bin", "tsc")
  const ts5 = join(modules, "typescript5", "bin", "tsc")
  const dist = (pkg: string, file: string) =>
    join(modules, "@bungohan", pkg, "dist", file)

  const checks: Check[] = [
    {
      name: "tarball manifests",
      run: async () => tarballs.flatMap(checkManifest),
    },
    {
      name: "README links are absolute",
      run: async () => (await Promise.all(tarballs.map(checkReadme))).flat(),
    },
    {
      name: "installed manifests carry no protocol",
      run: async () => {
        const problems: string[] = []
        for await (const path of new Glob("@bungohan/*/package.json").scan(
          modules,
        )) {
          const manifest = await Bun.file(join(modules, path)).json()
          for (const range of unresolvedProtocols(manifest)) {
            problems.push(`${path}: ${range}`)
          }
        }
        return problems
      },
    },
    {
      name: "one @bungohan/state, in the lockfile and on disk",
      run: async () => {
        const problems: string[] = []
        // A second copy is keyed by its parent ("@bungohan/core/@bungohan/
        // state"), so the optional prefix is what makes this catch one.
        const lock = await Bun.file(join(app, "bun.lock")).text()
        const keys = [
          ...lock.matchAll(/"(?:[^"]+\/)?(@bungohan\/state)"\s*:\s*\[/g),
        ]
        if (keys.length !== 1) {
          problems.push(
            `the lockfile resolves ${keys.length} @bungohan/state entries`,
          )
        }
        // Independent of the lockfile's format: what actually got installed.
        const installed: string[] = []
        for await (const path of new Glob(
          "**/@bungohan/state/package.json",
        ).scan({ cwd: modules, onlyFiles: true })) {
          installed.push(path)
        }
        if (installed.length !== 1) {
          problems.push(`node_modules holds ${installed.join(", ")}`)
        }
        if (problems.length > 0) {
          problems.push(
            "two copies mean two Schema classes, splitting instanceof and " +
              "the schema registry (spec §6.10)",
          )
        }
        return problems
      },
    },
    {
      name: "tsc 7: the app",
      run: async () =>
        must(await sh([ts7, "-p", "tsconfig.json"], { cwd: app }), "tsc 7"),
    },
    {
      name: "tsc 7: the .d.ts, skipLibCheck off",
      run: async () =>
        must(await sh([ts7, "-p", "tsconfig.dts.json"], { cwd: app }), "tsc 7"),
    },
    {
      name: "tsc 7: node16 resolution",
      run: async () =>
        must(
          await sh([ts7, "-p", "tsconfig.node16.json"], { cwd: app }),
          "tsc 7",
        ),
    },
    {
      name: `tsc ${TS5}: the app`,
      run: async () =>
        must(await sh([ts5, "-p", "tsconfig.json"], { cwd: app }), "tsc 5"),
    },
    {
      name: `tsc ${TS5}: the .d.ts, skipLibCheck off`,
      run: async () =>
        must(await sh([ts5, "-p", "tsconfig.dts.json"], { cwd: app }), "tsc 5"),
    },
    {
      name: `tsc ${TS5}: node16 resolution`,
      run: async () =>
        must(
          await sh([ts5, "-p", "tsconfig.node16.json"], { cwd: app }),
          "tsc 5",
        ),
    },
    {
      // Hovering isn't testable; the doc being in the shipped .d.ts is.
      name: "JSDoc survived declaration emit",
      run: async () => {
        const wanted: [string, string, string, string][] = [
          [
            "client-js",
            "client.d.ts",
            "connect(): Promise<Result<void, ClientError>>;",
            "Opens the connection",
          ],
          [
            "client-js",
            "room.d.ts",
            "send<K extends keyof RecvMap<C>",
            "Sends a contract message",
          ],
          [
            "core",
            "room.d.ts",
            "protected onJoin(_client: Client",
            "A client joined",
          ],
          [
            "core",
            "server.d.ts",
            "start(): Promise<Result<void, BungohanError>>;",
            "Starts the cluster node",
          ],
          [
            "state",
            "factories.d.ts",
            "export declare function createInt<",
            "saturated at the",
          ],
          [
            "testing",
            "harness.d.ts",
            "tick(ms: number): Promise<void>;",
            "advances the clock",
          ],
        ]
        const problems: string[] = []
        for (const [pkg, file, member, phrase] of wanted) {
          const source = await Bun.file(dist(pkg, file)).text()
          const at = source.indexOf(member)
          if (at < 0) {
            problems.push(`${pkg}/dist/${file}: no ${member}`)
            continue
          }
          const before = source.slice(Math.max(0, at - 1600), at)
          const doc = before.lastIndexOf("/**")
          const end = before.lastIndexOf("*/")
          if (doc < 0 || end < doc) {
            problems.push(`${pkg}/dist/${file}: ${member} lost its JSDoc`)
            continue
          }
          if (phrase !== "" && !before.slice(doc).includes(phrase)) {
            problems.push(
              `${pkg}/dist/${file}: ${member}'s doc doesn't say "${phrase}"`,
            )
          }
        }
        return problems
      },
    },
    {
      name: "@bungohan/testing runs a test",
      run: async () =>
        must(
          await sh(["bun", "test", "src/harness.test.ts"], { cwd: app }),
          "bun test",
        ),
    },
    {
      name: "bun add @bungohan/core @bungohan/schema",
      run: () =>
        documentedInstall(
          registry,
          released,
          ["@bungohan/core", "@bungohan/schema"],
          [
            'import { Room } from "@bungohan/core"',
            'import { createInt, f, Schema } from "@bungohan/schema"',
            'class S extends Schema { static schemaName = "S"',
            "  n = createInt(f.uint8) }",
            'console.log(new S() instanceof Schema && typeof Room === "function" ? "ok" : "no")',
          ].join("\n"),
        ),
    },
    {
      name: "bun add @bungohan/client-js @bungohan/schema",
      run: () =>
        documentedInstall(
          registry,
          released,
          ["@bungohan/client-js", "@bungohan/schema"],
          [
            'import { createBungohanClient } from "@bungohan/client-js"',
            'import { Schema } from "@bungohan/schema"',
            'console.log(typeof createBungohanClient === "function" && typeof Schema === "function" ? "ok" : "no")',
          ].join("\n"),
        ),
    },
    { name: "a client joins the server", run: () => joinCheck(app) },
    { name: "bun build --target=browser", run: () => bunBundle(app) },
    { name: "vite build", run: () => viteBundle(app) },
  ]

  let failed = 0
  for (const check of checks) {
    const start = performance.now()
    const problems = await check.run()
    const ms = ((performance.now() - start) / 1000).toFixed(1)
    const status = problems.length === 0 ? "PASS" : "FAIL"
    console.log(`${status.padEnd(5)} ${check.name} (${ms}s)`)
    for (const problem of problems) console.log(`      ${problem}`)
    if (problems.length > 0) failed++
  }
  console.log(
    failed === 0
      ? `\nall ${checks.length} pack checks passed`
      : `\n${failed} of ${checks.length} pack checks FAILED`,
  )
  return failed === 0 ? 0 : 1
}

/**
 * The install the docs actually tell people to run — `@bungohan/state` is
 * named in neither line, it arrives only as a peer. An exact-version peer is
 * where that could go wrong, so it is checked rather than assumed.
 */
async function documentedInstall(
  registry: string,
  released: string,
  packages: string[],
  probe: string,
): Promise<string[]> {
  const dir = await mkdtemp(join(tmpdir(), "bungohan-install-"))
  try {
    await Bun.write(
      join(dir, "package.json"),
      `${JSON.stringify({
        name: "bungohan-install-probe",
        version: "0.0.0",
        private: true,
        type: "module",
        dependencies: Object.fromEntries(
          packages.map((name) => [name, released]),
        ),
      })}\n`,
    )
    await Bun.write(
      join(dir, "bunfig.toml"),
      `[install.scopes]\nbungohan = { url = "${registry}/" }\n`,
    )
    const install = await sh(["bun", "install"], { cwd: dir })
    if (install.code !== 0) {
      return must(install, `bun add ${packages.join(" ")}`)
    }
    const problems: string[] = []
    const copies: string[] = []
    for await (const path of new Glob("**/@bungohan/state/package.json").scan({
      cwd: join(dir, "node_modules"),
    })) {
      copies.push(path)
    }
    if (copies.length !== 1) {
      problems.push(
        `${packages.join(" + ")} pulled in ${copies.length} @bungohan/state ` +
          "(it is a peer dependency, named in neither install line)",
      )
    }
    await Bun.write(join(dir, "probe.ts"), probe)
    const run = await sh(["bun", "probe.ts"], { cwd: dir })
    if (run.code !== 0) problems.push(...must(run, "the probe"))
    else if (run.stdout.trim() !== "ok") {
      problems.push(`the probe printed ${JSON.stringify(run.stdout.trim())}`)
    }
    return problems
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** Starts the fixture's server and runs a real client against it. */
async function joinCheck(app: string): Promise<string[]> {
  const port = 6100 + Math.floor(Math.random() * 300)
  const server = Bun.spawn(["bun", "src/server.ts"], {
    cwd: app,
    env: { ...process.env, PORT: String(port) },
    stdout: "pipe",
    stderr: "pipe",
  })
  try {
    const listening = await Promise.race([
      (async () => {
        for (let i = 0; i < 100; i++) {
          try {
            await fetch(`http://127.0.0.1:${port}/`)
            return true
          } catch {
            await Bun.sleep(100)
          }
        }
        return false
      })(),
      server.exited.then(() => false),
    ])
    if (!listening) {
      const err = await new Response(server.stderr).text()
      return [`the server never listened on ${port}\n${err.trimEnd()}`]
    }
    const run = await sh(["bun", "src/e2e.ts"], {
      cwd: app,
      env: { SERVER_URL: `ws://127.0.0.1:${port}` },
    })
    if (run.code !== 0) return must(run, "the client")
    const result = JSON.parse(run.stdout.trim().split("\n").at(-1) ?? "{}")
    const problems: string[] = []
    if (result.count !== 3) problems.push(`count came back ${result.count}`)
    if (result.total !== 3) problems.push(`tally came back ${result.total}`)
    if (result.score !== 3) problems.push(`score came back ${result.score}`)
    if (result.players !== 1) problems.push(`${result.players} players synced`)
    if (result.name !== "player-1") problems.push(`name is ${result.name}`)
    return problems
  } finally {
    server.kill()
    await server.exited
  }
}

/**
 * The browser-safety audit (CLAUDE.md rule 5) against installed packages.
 *
 * It bundles through a wrapper that keeps the entry's whole namespace alive:
 * the packages declare `sideEffects: false`, so an entry nothing consumes is
 * dead code, and a module the bundler drops is a module the audit never sees.
 */
async function bunBundle(app: string): Promise<string[]> {
  const out = join(app, "bun-out")
  const metafile = join(app, "bun-meta.json")
  await Bun.write(
    join(app, "src", "audit-entry.ts"),
    'import * as everything from "./browser"\n' +
      ";(globalThis as Record<string, unknown>)['__audit'] = everything\n",
  )
  const run = await sh(
    [
      process.execPath,
      "build",
      "src/audit-entry.ts",
      "--target=browser",
      `--outdir=${out}`,
      `--metafile=${metafile}`,
      "--external=react",
      "--external=react/jsx-runtime",
    ],
    { cwd: app },
  )
  if (run.code !== 0) return must(run, "bun build")
  if (run.stderr !== "") return [`bun build warned:\n${run.stderr.trimEnd()}`]

  const problems: string[] = []
  const meta: Metafile = await Bun.file(metafile).json()
  for (const [input, { imports }] of Object.entries(meta.inputs)) {
    const why = forbidden(input)
    if (why !== undefined) problems.push(`${input} (${why}) bundled`)
    for (const edge of imports) {
      const specifier = edge.original ?? edge.path
      const reason = forbidden(specifier)
      if (reason !== undefined) {
        problems.push(`${specifier} (${reason}) imported by ${input}`)
      }
    }
  }
  const bundle = await Bun.file(join(out, "audit-entry.js")).text()
  for (const marker of serverMarkers(bundle)) {
    problems.push(`the bundle contains ${marker}`)
  }
  if (!bundle.includes("CounterState")) {
    problems.push("the bundle doesn't contain the shared module")
  }
  return problems
}

/**
 * The same entry through Vite, which resolves `exports` its own way. Vite
 * has no metafile, so the module graph is read from the source maps it
 * emits: `sources` lists every module that went into the bundle.
 */
async function viteBundle(app: string): Promise<string[]> {
  const run = await sh([join(app, "node_modules", ".bin", "vite"), "build"], {
    cwd: app,
  })
  if (run.code !== 0) return must(run, "vite build")
  const problems: string[] = []
  let bundled = 0
  for await (const file of new Glob("**/*.js").scan(join(app, "dist"))) {
    const source = await Bun.file(join(app, "dist", file)).text()
    bundled++
    for (const marker of serverMarkers(source)) {
      problems.push(`dist/${file} contains ${marker}`)
    }
  }
  if (bundled === 0) problems.push("vite produced no JavaScript")

  let mapped = 0
  for await (const file of new Glob("**/*.js.map").scan(join(app, "dist"))) {
    const map = await Bun.file(join(app, "dist", file)).json()
    for (const source of (map.sources ?? []) as string[]) {
      mapped++
      const normalized = source.replace(/^.*node_modules\//, "")
      const why = forbidden(normalized)
      if (why !== undefined) problems.push(`dist/${file}: ${source} (${why})`)
    }
  }
  if (mapped === 0) {
    problems.push("no source maps, so the module graph wasn't audited")
  }
  return problems
}

process.exit(await main())
