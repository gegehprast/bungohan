/**
 * Every package ships a LICENSE, and every copy is the root one.
 *
 * `files` lets a package include only what's inside it, so each needs its own
 * copy rather than one at the repo root. Hard copies drift — a copyright year
 * or a holder changed in one place and not the other — so they are checked
 * byte for byte here rather than at pack time, where a mistake would already
 * be in a tarball.
 */
import { expect, test } from "bun:test"
import { join } from "node:path"
import { Glob } from "bun"

const ROOT = join(import.meta.dir, "..")

test("every package's LICENSE is the root LICENSE", async () => {
  const expected = await Bun.file(join(ROOT, "LICENSE")).text()
  expect(expected).toContain("MIT License")

  const dirs: string[] = []
  for await (const path of new Glob("packages/*/package.json").scan(ROOT)) {
    dirs.push(join(ROOT, path, ".."))
  }
  expect(dirs.length).toBeGreaterThan(0)

  const wrong: string[] = []
  for (const dir of dirs.sort()) {
    const file = Bun.file(join(dir, "LICENSE"))
    const where = dir.slice(ROOT.length + 1)
    if (!(await file.exists())) wrong.push(`${where}: no LICENSE`)
    else if ((await file.text()) !== expected) {
      wrong.push(`${where}: LICENSE differs from the root one`)
    }
  }
  expect(wrong).toEqual([])
})

test("each package lists LICENSE in files, so it is packed", async () => {
  const missing: string[] = []
  for await (const path of new Glob("packages/*/package.json").scan(ROOT)) {
    const manifest = await Bun.file(join(ROOT, path)).json()
    if (manifest.private === true) continue
    if (!(manifest.files ?? []).includes("LICENSE")) missing.push(path)
  }
  expect(missing).toEqual([])
})
