/**
 * Keeps the code in the docs honest: every TypeScript/JavaScript block in
 * `docs/` and the package READMEs is copied from a real file that `tsc`
 * checks and `bun test` runs, never written by hand in the Markdown.
 *
 *     bun run docs:sync                  # rewrite every snippet from its source
 *     bun scripts/docs-snippets.ts       # check only (what the test runs)
 *
 * A snippet is a block between two markers. The tool owns everything
 * between them (a link to the source file, then the fenced code):
 *
 *     <!-- snippet: apps/tutorial/shared/src/state.ts#player -->
 *     <!-- /snippet -->
 *
 * The part after `#` names a region of the source, delimited by
 * `// #region player` and `// #endregion player` lines; without `#` the
 * whole file is used. Region markers nested inside a region are dropped,
 * the code is dedented, and blank lines at either end are trimmed.
 *
 * The check fails when a snippet is out of date, names a missing file or
 * region, when a ts/tsx/js block appears outside a snippet, or when a
 * relative link (or its `#anchor` into another doc) points nowhere.
 */
import { dirname, join, relative, resolve } from "node:path"

const ROOT = resolve(import.meta.dir, "..")

/** Markdown files whose code blocks are checked. */
export async function docFiles(root = ROOT): Promise<string[]> {
  const files: string[] = []
  const glob = new Bun.Glob("docs/**/*.md")
  for await (const path of glob.scan({ cwd: root })) {
    if (path.includes("node_modules")) continue
    files.push(path)
  }
  for await (const path of new Bun.Glob("packages/*/README.md").scan(root)) {
    files.push(path)
  }
  return files.sort()
}

/** Languages that must come from a snippet, never be typed in Markdown. */
const CHECKED_LANGUAGES = new Set([
  "ts",
  "tsx",
  "typescript",
  "js",
  "jsx",
  "javascript",
  "mjs",
])

const OPEN = /^<!-- snippet: (\S+?) -->$/
const CLOSE = "<!-- /snippet -->"
const FENCE = /^(`{3,})(.*)$/

function regionMarker(line: string): { end: boolean; name: string } | null {
  const match =
    /^\s*(?:\/\/|\{\/\*)\s*#(region|endregion)\s+(\S+?)(?:\s*\*\/\})?\s*$/.exec(
      line,
    )
  if (match === null) return null
  return { end: match[1] === "endregion", name: match[2] ?? "" }
}

function dedent(lines: string[]): string[] {
  let indent = Number.POSITIVE_INFINITY
  for (const line of lines) {
    if (line.trim() === "") continue
    indent = Math.min(indent, line.length - line.trimStart().length)
  }
  if (!Number.isFinite(indent)) return lines
  return lines.map((line) => (line.trim() === "" ? "" : line.slice(indent)))
}

function trimBlank(lines: string[]): string[] {
  let start = 0
  let end = lines.length
  while (start < end && lines[start]?.trim() === "") start++
  while (end > start && lines[end - 1]?.trim() === "") end--
  return lines.slice(start, end)
}

/**
 * The code of `region` in `source` (or all of it when `region` is
 * undefined), ready to paste: nested markers dropped, dedented, trimmed.
 */
export function extractRegion(
  source: string,
  region: string | undefined,
): { code: string } | { error: string } {
  const lines = source.replace(/\r\n/g, "\n").split("\n")
  let body: string[]
  if (region === undefined) {
    body = lines
  } else {
    const starts: number[] = []
    const ends: number[] = []
    lines.forEach((line, i) => {
      const marker = regionMarker(line)
      if (marker?.name !== region) return
      ;(marker.end ? ends : starts).push(i)
    })
    const start = starts[0]
    const end = ends[0]
    if (start === undefined) return { error: `no "#region ${region}"` }
    if (starts.length > 1) return { error: `"#region ${region}" twice` }
    if (end === undefined || ends.length > 1 || end < start) {
      return { error: `"#region ${region}" needs one "#endregion ${region}"` }
    }
    body = lines.slice(start + 1, end)
  }
  const kept = body.filter((line) => regionMarker(line) === null)
  const code = dedent(trimBlank(kept)).join("\n")
  if (code === "") return { error: `region "${region}" is empty` }
  return { code }
}

function languageOf(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1)
  return ext === "md" ? "markdown" : ext
}

/** GitHub's heading anchors: lowercase, punctuation dropped, `-` for spaces. */
export function slug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-")
}

export function anchorsOf(markdown: string): Set<string> {
  const anchors = new Set<string>()
  const counts = new Map<string, number>()
  let fence: string | undefined
  for (const line of markdown.split("\n")) {
    const f = FENCE.exec(line)
    if (f !== null) {
      const ticks = f[1] ?? "```"
      if (fence === undefined) fence = ticks
      else if (ticks.length >= fence.length && (f[2] ?? "").trim() === "") {
        fence = undefined
      }
      continue
    }
    if (fence !== undefined) continue
    const heading = /^#{1,6}\s+(.*)$/.exec(line)
    if (heading === null) continue
    const base = slug(heading[1] ?? "")
    const seen = counts.get(base) ?? 0
    counts.set(base, seen + 1)
    anchors.add(seen === 0 ? base : `${base}-${seen}`)
  }
  return anchors
}

export interface Problem {
  file: string
  line: number
  message: string
}

type Reader = (path: string) => Promise<string | undefined>

async function readFile(path: string): Promise<string | undefined> {
  const file = Bun.file(path)
  return (await file.exists()) ? file.text() : undefined
}

/**
 * Regenerates every snippet of one doc, and lists what is wrong with it.
 * `doc` is relative to `root`.
 */
export async function processDoc(
  doc: string,
  markdown: string,
  root = ROOT,
  read: Reader = readFile,
): Promise<{ output: string; problems: Problem[] }> {
  const problems: Problem[] = []
  const lines = markdown.split("\n")
  const out: string[] = []
  const docDir = dirname(join(root, doc))
  let fence: string | undefined

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ""
    const at = (message: string) =>
      problems.push({ file: doc, line: i + 1, message })

    const f = FENCE.exec(line)
    if (f !== null) {
      const ticks = f[1] ?? "```"
      if (fence === undefined) {
        fence = ticks
        const lang = (f[2] ?? "").trim().split(/\s/)[0] ?? ""
        if (CHECKED_LANGUAGES.has(lang.toLowerCase())) {
          at(
            `a \`${lang}\` block outside a snippet: move the code into a ` +
              "checked file and include it with <!-- snippet: … -->",
          )
        }
      } else if (ticks.length >= fence.length && (f[2] ?? "").trim() === "") {
        fence = undefined
      }
      out.push(line)
      continue
    }
    if (fence !== undefined) {
      out.push(line)
      continue
    }

    const open = OPEN.exec(line.trim())
    if (open === null) {
      out.push(line)
      continue
    }
    const close = lines.indexOf(CLOSE, i + 1)
    if (close === -1) {
      at(`snippet has no "${CLOSE}"`)
      out.push(line)
      continue
    }
    const target = open[1] ?? ""
    const hash = target.indexOf("#")
    const path = hash === -1 ? target : target.slice(0, hash)
    const region = hash === -1 ? undefined : target.slice(hash + 1)
    const source = await read(join(root, path))
    let generated: string[]
    if (source === undefined) {
      at(`snippet source ${path} does not exist`)
      generated = lines.slice(i + 1, close)
    } else {
      const extracted = extractRegion(source, region)
      if ("error" in extracted) {
        at(`snippet ${target}: ${extracted.error}`)
        generated = lines.slice(i + 1, close)
      } else {
        const link = relative(docDir, join(root, path))
        generated = [
          `[\`${path}\`](${link})`,
          "",
          `\`\`\`${languageOf(path)}`,
          extracted.code,
          "```",
        ]
      }
    }
    out.push(line, ...generated, CLOSE)
    i = close
  }
  if (fence !== undefined) {
    problems.push({ file: doc, line: lines.length, message: "unclosed fence" })
  }

  problems.push(...(await checkLinks(doc, out.join("\n"), root, read)))
  return { output: out.join("\n"), problems }
}

/** Relative links (and anchors into Markdown files) must resolve. */
async function checkLinks(
  doc: string,
  markdown: string,
  root: string,
  read: Reader,
): Promise<Problem[]> {
  const problems: Problem[] = []
  const docPath = join(root, doc)
  const lines = markdown.split("\n")
  let fence: string | undefined
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ""
    const f = FENCE.exec(line)
    if (f !== null) {
      const ticks = f[1] ?? "```"
      if (fence === undefined) fence = ticks
      else if (ticks.length >= fence.length && (f[2] ?? "").trim() === "") {
        fence = undefined
      }
      continue
    }
    if (fence !== undefined) continue
    for (const match of line.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = match[1] ?? ""
      if (/^[a-z]+:/i.test(target)) continue
      const hash = target.indexOf("#")
      const path = hash === -1 ? target : target.slice(0, hash)
      const anchor = hash === -1 ? undefined : target.slice(hash + 1)
      const file = path === "" ? docPath : resolve(dirname(docPath), path)
      const content = path === "" ? markdown : await read(file)
      if (content === undefined) {
        // A directory link is fine if the directory exists.
        const isDir = await dirExists(file)
        if (!isDir) {
          problems.push({
            file: doc,
            line: i + 1,
            message: `link to ${target}: no such file`,
          })
        }
        continue
      }
      if (anchor !== undefined && file.endsWith(".md")) {
        if (!anchorsOf(content).has(anchor)) {
          problems.push({
            file: doc,
            line: i + 1,
            message: `link to ${target}: no heading with that anchor`,
          })
        }
      }
    }
  }
  return problems
}

async function dirExists(path: string): Promise<boolean> {
  const glob = new Bun.Glob("*")
  try {
    for await (const _ of glob.scan({ cwd: path, onlyFiles: false })) {
      return true
    }
  } catch {
    return false
  }
  return false
}

/** Checks (or with `write`, rewrites) every doc; returns the problems. */
export async function run(write: boolean, root = ROOT): Promise<Problem[]> {
  const problems: Problem[] = []
  for (const doc of await docFiles(root)) {
    const markdown = await readFile(join(root, doc))
    if (markdown === undefined) {
      problems.push({ file: doc, line: 0, message: "missing" })
      continue
    }
    const result = await processDoc(doc, markdown, root)
    problems.push(...result.problems)
    if (result.output === markdown) continue
    if (write) {
      await Bun.write(join(root, doc), result.output)
    } else {
      problems.push({
        file: doc,
        line: 0,
        message: "snippets are out of date: run `bun run docs:sync`",
      })
    }
  }
  return problems
}

if (import.meta.main) {
  const write = process.argv.includes("--write")
  const problems = await run(write)
  for (const p of problems) console.error(`${p.file}:${p.line}: ${p.message}`)
  if (problems.length > 0) process.exit(1)
  console.log(write ? "docs: snippets synced" : "docs: all snippets current")
}
