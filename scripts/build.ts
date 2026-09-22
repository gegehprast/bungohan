/**
 * Builds every published package into its `dist/`: ESM JavaScript, `.d.ts`
 * declarations that keep the JSDoc, and source maps with the TypeScript
 * inlined (`inlineSources`, since `src/` is not shipped).
 *
 *     bun run build
 *
 * The monorepo itself never needs this. Packages resolve to their raw
 * TypeScript through the workspace symlinks and `"main": "./src/index.ts"`,
 * so tests, the apps and the docs examples all run from source. `dist/` is
 * gitignored and exists only to be packed.
 *
 * Two things happen after `tsc`:
 *
 *  1. Relative import specifiers get an explicit `.js`. TypeScript emits
 *     `from "./room"` unchanged, which only a bundler can resolve; `.js`
 *     makes the output valid under every module resolution, Node's included.
 *     `.d.ts` files get the same treatment, where `"./room.js"` correctly
 *     resolves to `room.d.ts`.
 *  2. The emitted graph is checked for stray `.ts` specifiers and for any
 *     relative target that does not exist.
 */

import { existsSync } from "node:fs"
import { rm } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { Glob } from "bun"
import { PUBLISHED, packageDir, ROOT } from "./packages"

const tsc = `${ROOT}/node_modules/.bin/tsc`

/** Every `from "…"` / `import("…")` specifier, with its source offsets. */
const SPECIFIER =
  /(\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s*)(["'])([^"']+)\2/gm

function rewriteSpecifiers(source: string): string {
  return source.replace(SPECIFIER, (whole, lead, quote, spec: string) => {
    if (!spec.startsWith(".")) return whole
    if (/\.(js|mjs|cjs|json|css)$/.test(spec)) return whole
    return `${lead}${quote}${spec}.js${quote}`
  })
}

/** Why a built file is not self-consistent, or nothing if it is. */
function problems(file: string, source: string): string[] {
  const found: string[] = []
  for (const match of source.matchAll(SPECIFIER)) {
    const spec = match[3]
    if (spec === undefined || !spec.startsWith(".")) continue
    if (spec.endsWith(".ts")) {
      found.push(`${file}: emitted a TypeScript specifier ${spec}`)
      continue
    }
    const base = resolve(dirname(file), spec).replace(/\.js$/, "")
    const target = file.endsWith(".d.ts") ? `${base}.d.ts` : `${base}.js`
    if (!existsSync(target)) found.push(`${file}: ${spec} resolves nowhere`)
  }
  return found
}

async function build(name: string): Promise<void> {
  const dir = packageDir(name)
  await rm(join(dir, "dist"), { recursive: true, force: true })
  const proc = Bun.spawn([tsc, "-p", join(dir, "tsconfig.build.json")], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0) {
    console.error(`${out}${err}`)
    throw new Error(`tsc failed for @bungohan/${name} (exit ${code})`)
  }

  const built: string[] = []
  for await (const rel of new Glob("**/*.{js,d.ts}").scan(join(dir, "dist"))) {
    built.push(join(dir, "dist", rel))
  }
  for (const file of built) {
    const source = await Bun.file(file).text()
    const rewritten = rewriteSpecifiers(source)
    if (rewritten !== source) await Bun.write(file, rewritten)
  }
  const bad = (
    await Promise.all(
      built.map(async (file) => problems(file, await Bun.file(file).text())),
    )
  ).flat()
  if (bad.length > 0) {
    throw new Error(`@bungohan/${name}:\n  ${bad.join("\n  ")}`)
  }
  console.log(`built  @bungohan/${name} (${built.length} files)`)
}

for (const name of PUBLISHED) await build(name)
console.log(`\n${PUBLISHED.length} packages built`)
