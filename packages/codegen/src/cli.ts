#!/usr/bin/env bun
/**
 * bunx @bungohan/codegen --contract <module> --state <module>
 *   --lang <csharp|gdscript|json> --out <dir>
 *   [--namespace <C# namespace>] [--addon <res:// path of the Godot addon>]
 *
 * Imports the modules, walks their runtime descriptors and writes the
 * bindings (spec §4.2). Exits 1 with a message on bad arguments or bad
 * declarations.
 */
import { mkdir } from "node:fs/promises"
import { dirname, join, relative, resolve } from "node:path"
import { parseArgs } from "node:util"
import { generate, type Language } from "./generate"
import { CodegenError, loadModel } from "./model"

const USAGE = `usage: bunx @bungohan/codegen [--contract <module>] [--state <module>]
         --lang <csharp|gdscript|json> --out <dir>
         [--namespace <C# namespace>] [--addon <res:// path of the Godot addon>]`

const LANGUAGES: readonly Language[] = ["csharp", "gdscript", "json"]

function isLanguage(value: string): value is Language {
  return (LANGUAGES as readonly string[]).includes(value)
}

/** `<package name>/<path in the package>`: the same on every machine. */
async function describe(path: string): Promise<string> {
  let dir = dirname(path)
  for (;;) {
    const manifest = Bun.file(join(dir, "package.json"))
    if (await manifest.exists()) {
      const json: unknown = await manifest.json()
      const name =
        typeof json === "object" && json !== null && "name" in json
          ? String(json.name)
          : ""
      return `${name}/${relative(dir, path)}`
    }
    const parent = dirname(dir)
    if (parent === dir) return relative(process.cwd(), path)
    dir = parent
  }
}

export async function main(argv: readonly string[]): Promise<number> {
  let values: Record<string, string | boolean | undefined>
  try {
    values = parseArgs({
      args: [...argv],
      options: {
        contract: { type: "string" },
        state: { type: "string" },
        lang: { type: "string" },
        out: { type: "string" },
        namespace: { type: "string" },
        addon: { type: "string" },
        help: { type: "boolean" },
      },
      strict: true,
    }).values
  } catch (error) {
    console.error(`${String(error)}\n${USAGE}`)
    return 1
  }
  const { contract, state, lang, out, namespace, addon } = values
  if (values.help === true) {
    console.log(USAGE)
    return 0
  }
  if (
    typeof lang !== "string" ||
    !isLanguage(lang) ||
    typeof out !== "string"
  ) {
    console.error(USAGE)
    return 1
  }
  if (typeof contract !== "string" && typeof state !== "string") {
    console.error(`give --contract, --state or both\n${USAGE}`)
    return 1
  }
  const contractPath =
    typeof contract === "string" ? resolve(contract) : undefined
  const statePath = typeof state === "string" ? resolve(state) : undefined

  try {
    const model = await loadModel({ contract: contractPath, state: statePath })
    const sources = [...new Set([contractPath, statePath])].filter(
      (p): p is string => p !== undefined,
    )
    const files = generate(model, {
      lang,
      namespace: typeof namespace === "string" ? namespace : undefined,
      addon: typeof addon === "string" ? addon : undefined,
      source: (await Promise.all(sources.map(describe))).join(" and "),
    })
    const root = resolve(out)
    for (const [name, content] of files) {
      const path = join(root, name)
      await mkdir(dirname(path), { recursive: true })
      await Bun.write(path, content)
    }
    console.log(
      `@bungohan/codegen: wrote ${files.size} ${lang} file(s) to ${out}`,
    )
    return 0
  } catch (error) {
    if (error instanceof CodegenError) {
      console.error(`@bungohan/codegen: ${error.message}`)
      return 1
    }
    throw error
  }
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)))
