/**
 * The post-publish docs change, prepared but not applied: the docs still say
 * the packages aren't on npm, which stops being true the moment
 * `bun run publish:alpha` succeeds.
 *
 *     bun scripts/published.ts --dry-run   # see the edits
 *     bun scripts/published.ts             # apply them
 *
 * Run it after the first publish, not before. It reads the version and the
 * dist-tag it should name from the manifests and `--tag` (default `alpha`).
 */
import { join } from "node:path"
import { ROOT, version } from "./packages"

const args = process.argv.slice(2)
const dryRun = args.includes("--dry-run")
const tag = args.includes("--tag") ? args[args.indexOf("--tag") + 1] : "alpha"
const released = await version()

interface Edit {
  readonly file: string
  readonly from: string
  readonly to: string
}

const prerelease = released.includes("-")
/** `bun add` needs the tag while the release is a prerelease. */
const install = prerelease ? `@${tag}` : ""

const edits: Edit[] = [
  {
    file: "docs/getting-started.md",
    from: [
      "> The packages aren't on npm yet; these are the names they will be",
      "> published under.",
      "",
      "The server needs Bun 1.3.3 or newer.",
      "",
      "```sh",
      "bun add @bungohan/core @bungohan/schema      # server",
      "bun add @bungohan/client-js @bungohan/schema # client",
      "```",
    ].join("\n"),
    to: [
      `> Bungohan is at \`${released}\`, published on the \`${tag}\` tag.`,
      "> The API can still change between alpha releases.",
      "",
      "The server needs Bun 1.3.3 or newer.",
      "",
      "```sh",
      `bun add @bungohan/core${install} @bungohan/schema${install}      # server`,
      `bun add @bungohan/client-js${install} @bungohan/schema${install} # client`,
      "```",
    ].join("\n"),
  },
  {
    file: "packages/core/README.md",
    from: [
      "```sh",
      "bun add @bungohan/core @bungohan/schema",
      "```",
      "",
      "Requires Bun 1.3.3 or newer. (Not published yet: these are the names the",
      "packages will be published under.)",
    ].join("\n"),
    to: [
      "```sh",
      `bun add @bungohan/core${install} @bungohan/schema${install}`,
      "```",
      "",
      `Requires Bun 1.3.3 or newer. Published at \`${released}\` on the`,
      `\`${tag}\` tag; the API can still change between alpha releases.`,
    ].join("\n"),
  },
  {
    file: "packages/client-js/README.md",
    from: [
      "```sh",
      "bun add @bungohan/client-js @bungohan/schema",
      "```",
      "",
      "(Not published yet: these are the names the packages will be published",
      "under.) `react` (18 or newer) is an optional peer dependency, needed only",
      "for `@bungohan/client-js/react`.",
    ].join("\n"),
    to: [
      "```sh",
      `bun add @bungohan/client-js${install} @bungohan/schema${install}`,
      "```",
      "",
      `Published at \`${released}\` on the \`${tag}\` tag. \`react\` (18 or newer)`,
      "is an optional peer dependency, needed only for",
      "`@bungohan/client-js/react`.",
    ].join("\n"),
  },
]

let applied = 0
const problems: string[] = []
for (const edit of edits) {
  const path = join(ROOT, edit.file)
  const source = await Bun.file(path).text()
  if (!source.includes(edit.from)) {
    problems.push(
      source.includes(edit.to)
        ? `${edit.file}: already updated`
        : `${edit.file}: the "not published yet" note isn't there as expected`,
    )
    continue
  }
  applied++
  if (dryRun) {
    console.log(`--- ${edit.file}\n${edit.from}\n+++\n${edit.to}\n`)
  } else {
    await Bun.write(path, source.replace(edit.from, edit.to))
    console.log(`updated ${edit.file}`)
  }
}

for (const problem of problems) console.log(problem)
console.log(
  dryRun
    ? `\n--dry-run: ${applied} of ${edits.length} edits would apply`
    : `\n${applied} of ${edits.length} files updated. ` +
        "Run `bun test scripts/docs-snippets.test.ts`, then commit.",
)
process.exit(problems.length > 0 && applied === 0 ? 1 : 0)
