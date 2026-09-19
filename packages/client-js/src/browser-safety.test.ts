/**
 * CLAUDE.md rule 5: client-js must run in a browser. Each entry point is
 * bundled with the real CLI, `bun build --target=browser --metafile`, and
 * every import in the resulting module graph is audited. A build's success
 * proves nothing on its own: for the browser target Bun silently replaces
 * `node:fs` with an empty stub and polyfills `path`. So the test fails if
 * anything reachable imports a `bun:` or `node:` module (or a bare Node
 * builtin such as `fs`), or `@bungohan/core`. The packages client-js
 * brings in (state, types, serializer, result) are checked the same way,
 * as entry points of their own.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { builtinModules } from "node:module"
import { tmpdir } from "node:os"
import { isAbsolute, join } from "node:path"

const packages = join(import.meta.dir, "..", "..")
const repo = join(packages, "..")
const core = `${join(packages, "core")}/`
const nodeBuiltins = new Set(builtinModules)

interface Entry {
  readonly name: string
  readonly path: string
  /** Left to the host app, never bundled (peer dependencies). */
  readonly external?: string[]
}

const entries: Entry[] = [
  { name: "@bungohan/client-js", path: "client-js/src/index.ts" },
  {
    name: "@bungohan/client-js/react",
    path: "client-js/src/react/index.ts",
    external: ["react"],
  },
  { name: "@bungohan/state", path: "state/src/index.ts" },
  { name: "@bungohan/types", path: "types/src/index.ts" },
  { name: "@bungohan/serializer", path: "serializer/src/index.ts" },
  { name: "@bungohan/result", path: "result/src/index.ts" },
]

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

interface MetaImport {
  readonly path: string
  readonly original?: string
}

interface Metafile {
  readonly inputs: Record<string, { readonly imports: MetaImport[] }>
}

interface Audit {
  readonly exitCode: number
  readonly stderr: string
  /** Every import specifier in the graph, as written in the source. */
  readonly imports: Set<string>
  readonly violations: string[]
  readonly output: string
}

let scratch = ""
let builds = 0

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "bungohan-browser-safety-"))
})

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true })
})

async function audit(entry: Entry): Promise<Audit> {
  const n = builds++
  const outfile = join(scratch, `out-${n}.js`)
  const metafile = join(scratch, `meta-${n}.json`)
  const proc = Bun.spawn(
    [
      process.execPath,
      "build",
      isAbsolute(entry.path) ? entry.path : join(packages, entry.path),
      "--target=browser",
      `--outfile=${outfile}`,
      `--metafile=${metafile}`,
      ...(entry.external ?? []).map((name) => `--external=${name}`),
    ],
    { cwd: repo, stdout: "pipe", stderr: "pipe" },
  )
  const [exitCode, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
  ])
  const imports = new Set<string>()
  const violations: string[] = []
  if (exitCode !== 0) {
    return { exitCode, stderr, imports, violations, output: "" }
  }
  const meta: Metafile = await Bun.file(metafile).json()
  for (const [input, { imports: edges }] of Object.entries(meta.inputs)) {
    // Polyfilled builtins show up as inputs of their own ("node:path").
    const why = forbidden(input)
    if (why !== undefined) violations.push(`${input} (${why}) bundled`)
    for (const edge of edges) {
      const specifier = edge.original ?? edge.path
      imports.add(specifier)
      const reason =
        forbidden(specifier) ??
        (edge.path.startsWith(core) ? "server package" : undefined)
      if (reason !== undefined) {
        violations.push(`${specifier} (${reason}) imported by ${input}`)
      }
    }
  }
  const output = await Bun.file(outfile).text()
  return { exitCode, stderr, imports, violations, output }
}

/** The gate every entry must pass. */
function browserSafe(result: Audit): boolean {
  return (
    result.exitCode === 0 &&
    result.stderr === "" &&
    result.violations.length === 0 &&
    !result.output.includes("@bungohan/core")
  )
}

const main: Entry = { name: "main", path: "client-js/src/index.ts" }

describe("browser safety (bun build --target=browser)", () => {
  for (const entry of entries) {
    test(`${entry.name}: no bun:/node:/core imports`, async () => {
      const result = await audit(entry)
      expect(result.stderr).toBe("")
      expect(result.exitCode).toBe(0)
      expect(result.violations).toEqual([])
      expect(browserSafe(result)).toBe(true)
    })
  }

  test("the main entry doesn't import React", async () => {
    const { imports } = await audit(main)
    const react = [...imports].filter((path) =>
      /^react(?:$|\/|-dom)/.test(path),
    )
    expect(react).toEqual([])
  })

  test("the audit sees the whole import graph", async () => {
    const { imports } = await audit(main)
    for (const expected of [
      "@bungohan/state",
      "@bungohan/serializer",
      "@bungohan/types",
      "@bungohan/result",
      "@msgpack/msgpack",
      "nanoid",
    ]) {
      expect(imports).toContain(expected)
    }
  })

  test("the audit catches what the bundler silently stubs or polyfills", async () => {
    const path = join(scratch, "bad.ts")
    await Bun.write(
      path,
      [
        'import { readFileSync } from "node:fs"',
        'import { join } from "path"',
        "export const f = [readFileSync, join]",
      ].join("\n"),
    )
    const result = await audit({ name: "bad", path })
    const { exitCode, violations } = result
    expect(exitCode).toBe(0) // Bun itself is happy with it...
    expect(browserSafe(result)).toBe(false) // ...the gate is not
    expect(violations.map((v) => v.split(" imported by")[0]).sort()).toEqual(
      [
        "node:fs (Node builtin)",
        "node:path (Node builtin) bundled",
        "path (Node builtin)",
      ].sort(),
    )
  })

  test("the audit catches @bungohan/core", async () => {
    // Inside a package that depends on core, so the import resolves.
    const path = join(packages, "testing", "src", ".browser-safety-probe.ts")
    await Bun.write(
      path,
      'import { SystemClock } from "@bungohan/core"\nexport const c = SystemClock\n',
    )
    try {
      const result = await audit({ name: "core", path })
      expect(browserSafe(result)).toBe(false)
      // Core reaches Bun APIs (the store's RedisClient), which a browser
      // build refuses outright; had it bundled, the audit would flag it.
      expect(
        result.exitCode !== 0 ||
          result.violations.some((v) => v.startsWith("@bungohan/core")),
      ).toBe(true)
    } finally {
      await rm(path, { force: true })
    }
  })

  test("forbidden()", () => {
    expect(forbidden("node:fs")).toBe("Node builtin")
    expect(forbidden("fs/promises")).toBe("Node builtin")
    expect(forbidden("bun:sqlite")).toBe("Bun API")
    expect(forbidden("@bungohan/core")).toBe("server package")
    expect(forbidden("@bungohan/state")).toBeUndefined()
  })
})
