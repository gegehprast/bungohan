/**
 * Enforces spec §6.10: a game's shared module (state classes + contract)
 * depends only on @bungohan/schema, never on core or client-js. Otherwise
 * the browser pulls in server code, or the server depends on the client.
 */
import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { Glob } from "bun"

const ROOT = join(import.meta.dir, "..")
const ALLOWED = new Set(["@bungohan/schema"])

/** Every @bungohan/* package a source file imports. */
function bungohanImports(source: string): string[] {
  const found = new Set<string>()
  for (const match of source.matchAll(/from\s+"(@bungohan\/[^"/]+)/g)) {
    const name = match[1]
    if (name !== undefined) found.add(name)
  }
  return [...found]
}

async function sharedPackages(): Promise<string[]> {
  const dirs: string[] = []
  for await (const path of new Glob("apps/*/shared/package.json").scan(ROOT)) {
    dirs.push(join(ROOT, path, ".."))
  }
  return dirs
}

describe("shared modules depend only on @bungohan/schema", () => {
  test("their package.json lists no other @bungohan package", async () => {
    const dirs = await sharedPackages()
    expect(dirs.length).toBeGreaterThan(0)
    for (const dir of dirs) {
      const manifest = await Bun.file(join(dir, "package.json")).json()
      const deps = Object.keys({ ...manifest.dependencies })
      const bad = deps.filter(
        (name) => name.startsWith("@bungohan/") && !ALLOWED.has(name),
      )
      expect({ dir, bad }).toEqual({ dir, bad: [] })
    }
  })

  test("their source imports no other @bungohan package", async () => {
    const files = [join(ROOT, "docs/examples/src/getting-started/shared.ts")]
    for (const dir of await sharedPackages()) {
      for await (const path of new Glob("src/**/*.ts").scan(dir)) {
        if (!path.endsWith(".test.ts")) files.push(join(dir, path))
      }
    }
    for (const file of files) {
      const bad = bungohanImports(await Bun.file(file).text()).filter(
        (name) => !ALLOWED.has(name),
      )
      expect({ file, bad }).toEqual({ file, bad: [] })
    }
  })
})
