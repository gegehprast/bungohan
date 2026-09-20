/**
 * Golden-file tests: the CLI's output for test/fixture must equal
 * test/golden byte for byte, and the example shooter's committed bindings
 * must equal a fresh generation. `UPDATE_GOLDEN=1 bun test` rewrites the
 * goldens (review the diff).
 */
import { describe, expect, test } from "bun:test"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { defineContract, defineMessage, f } from "@bungohan/types"
import { main } from "./cli"
import { buildModel, CodegenError, generate, type Language } from "./index"

const ROOT = new URL("../../../", import.meta.url).pathname
const FIXTURE = join(ROOT, "packages/codegen/test/fixture")
const GOLDEN = join(ROOT, "packages/codegen/test/golden")
const SHARED = join(ROOT, "apps/example-shooter/shared/src/index.ts")
const INTEROP = join(ROOT, "packages/testing/src/interop/shared.ts")
const LANGUAGES: readonly Language[] = ["csharp", "gdscript", "json"]

/** Every file under `dir`: relative path → content. */
async function readTree(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  let entries: string[]
  try {
    entries = await readdir(dir, { recursive: true })
  } catch {
    return out
  }
  for (const entry of entries.sort()) {
    const file = Bun.file(join(dir, entry))
    if ((await file.exists()) && !entry.endsWith("/")) {
      const stat = await file.stat()
      if (stat.isFile()) out.set(entry.split("\\").join("/"), await file.text())
    }
  }
  return out
}

/** Runs the CLI into a fresh temporary directory and reads what it wrote. */
async function runCli(args: string[]): Promise<Map<string, string>> {
  const out = await mkdtemp(join(tmpdir(), "bungohan-codegen-"))
  try {
    const log = console.log
    console.log = () => {}
    const code = await main([...args, "--out", out]).finally(() => {
      console.log = log
    })
    expect(code).toBe(0)
    return await readTree(out)
  } finally {
    await rm(out, { recursive: true, force: true })
  }
}

function fixtureArgs(lang: Language): string[] {
  return [
    "--contract",
    join(FIXTURE, "contract.ts"),
    "--state",
    join(FIXTURE, "state.ts"),
    "--lang",
    lang,
    "--namespace",
    "Bungohan.Codegen.Golden",
  ]
}

describe("golden files", () => {
  for (const lang of LANGUAGES) {
    test(`${lang} output matches test/golden/${lang}`, async () => {
      const generated = await runCli(fixtureArgs(lang))
      const dir = join(GOLDEN, lang)
      if (process.env["UPDATE_GOLDEN"] === "1") {
        await rm(dir, { recursive: true, force: true })
        for (const [name, content] of generated) {
          await Bun.write(join(dir, name), content)
        }
      }
      const golden = await readTree(dir)
      expect([...generated.keys()]).toEqual([...golden.keys()])
      for (const [name, content] of generated) {
        expect({ file: name, content }).toEqual({
          file: name,
          content: golden.get(name) ?? "",
        })
      }
    })
  }

  test("output is deterministic", async () => {
    for (const lang of LANGUAGES) {
      const first = await runCli(fixtureArgs(lang))
      const second = await runCli(fixtureArgs(lang))
      expect(second).toEqual(first)
    }
  })
})

describe("committed bindings", () => {
  const targets: [Language, string, string, string, string[]][] = [
    [
      "csharp",
      SHARED,
      "clients/csharp/Bungohan.Bindings/Shooter",
      "codegen:example",
      ["--namespace", "Bungohan.Example.Shooter"],
    ],
    [
      "gdscript",
      SHARED,
      "clients/godot/example/shooter",
      "codegen:example",
      [],
    ],
    ["json", SHARED, "clients/fixtures", "codegen:example", []],
    [
      "csharp",
      INTEROP,
      "clients/csharp/Bungohan.Bindings/Interop",
      "codegen:interop",
      ["--namespace", "Bungohan.Interop"],
    ],
    ["gdscript", INTEROP, "clients/godot/tests/interop", "codegen:interop", []],
  ]
  for (const [lang, module, dir, script, extra] of targets) {
    test(`${dir} is up to date (bun run ${script})`, async () => {
      const generated = await runCli([
        "--contract",
        module,
        "--state",
        module,
        "--lang",
        lang,
        ...extra,
      ])
      const committed = await readTree(join(ROOT, dir))
      for (const [name, content] of generated) {
        expect({
          file: relative(ROOT, join(ROOT, dir, name)),
          content,
        }).toEqual({
          file: relative(ROOT, join(ROOT, dir, name)),
          content: committed.get(name) ?? "",
        })
      }
    })
  }
})

describe("model", () => {
  test("the contract hash is baked in, numeric ids never are", async () => {
    const files = await runCli(fixtureArgs("csharp"))
    const contracts = files.get("Contracts.cs") ?? ""
    const { contractHash } = await import("@bungohan/types")
    const { fixtureContract } = await import("../test/fixture/contract")
    expect(contracts).toContain(`Hash = "${contractHash(fixtureContract)}"`)
    expect(contracts).not.toMatch(/\bId\b|MessageId|messageId/)
  })

  test("two different messages with one name are refused", () => {
    const a = defineMessage("hit", { damage: f.uint8 })
    const b = defineMessage("hit", { damage: f.uint16 })
    const contract = defineContract({ client: { hit: a }, server: { hit: b } })
    expect(() => buildModel({ contract }, [])).toThrow(CodegenError)
  })

  test("a malformed declaration is refused with its path", () => {
    const bad = defineMessage("bad", { n: f.fixed(12 as 2) })
    const contract = defineContract({ client: { bad }, server: {} })
    expect(() => buildModel({ contract }, [])).toThrow(/bad/)
  })

  test("messages and classes come out sorted, whatever the input order", () => {
    const b = defineMessage("b", {})
    const a = defineMessage("a", { x: f.int8 })
    const one = buildModel(
      { c: defineContract({ client: { b, a }, server: {} }) },
      [],
    )
    expect(one.messages.map((m) => m.name)).toEqual(["a", "b"])
    const json = generate(one, { lang: "json" }).get("bungohan.json") ?? ""
    expect(JSON.parse(json).contracts[0].client).toEqual(["b", "a"])
  })
})

describe("cli", () => {
  test("bad arguments exit 1 with the usage", async () => {
    const error = console.error
    const lines: unknown[] = []
    console.error = (...args: unknown[]) => lines.push(args)
    try {
      expect(await main(["--lang", "rust", "--out", "x"])).toBe(1)
      expect(await main(["--lang", "json", "--out", "x"])).toBe(1)
      expect(await main(["--bogus"])).toBe(1)
    } finally {
      console.error = error
    }
    expect(String(lines[0])).toContain("usage:")
  })
})
