/**
 * Publishes the packed tarballs, in dependency order.
 *
 *     bun run publish:dry          # prints and dry-runs every command
 *     bun run publish:alpha        # the real thing, on the "alpha" dist-tag
 *     bun scripts/publish.ts --tag latest
 *
 * A prerelease published on another tag also moves `latest` to it, as long
 * as no stable version exists: npm won't delete `latest`, so otherwise a
 * plain `bun add @bungohan/core` keeps installing the first alpha. Pass
 * `--no-latest` to skip that. Once a stable version is out, `latest` stays on
 * it and alphas only move their own tag.
 *
 * It publishes `.pack/*.tgz` — the tarballs `bun run pack` produced and
 * `bun run check:pack` proved — never a package directory. A directory would
 * be packed by `bun publish` itself, which does not apply `publishConfig`,
 * and the published manifest would point at source that isn't in the
 * tarball. See RELEASING.md.
 *
 * Nothing here logs in. `bunx npm login` first; a dry run without a login
 * reports an auth error and that is fine, the point is the command and the
 * tarball's contents.
 */
import { join } from "node:path"
import { PUBLISHED, ROOT, version } from "./packages"

const args = process.argv.slice(2)
const dryRun = args.includes("--dry-run")
const moveLatest = !args.includes("--no-latest")
const tag = args[args.indexOf("--tag") + 1]

if (!args.includes("--tag") || tag === undefined || tag.startsWith("-")) {
  console.error(
    "usage: bun scripts/publish.ts --tag <dist-tag> [--dry-run] [--no-latest]",
  )
  process.exit(1)
}

const released = await version()
const missing: string[] = []
const tarballs = PUBLISHED.map((name) => {
  const path = join(ROOT, ".pack", `bungohan-${name}-${released}.tgz`)
  return { name, path }
})
for (const { path } of tarballs) {
  if (!(await Bun.file(path).exists())) missing.push(path)
}
if (missing.length > 0) {
  console.error(
    `no tarballs for ${released}. Run \`bun run check:pack\` first ` +
      "(it builds, packs and proves them).\n  missing: " +
      missing.join("\n           "),
  )
  process.exit(1)
}

console.log(
  `${dryRun ? "dry run: " : ""}publishing ${released} on "${tag}", ` +
    `${tarballs.length} packages in dependency order\n`,
)

for (const { name, path } of tarballs) {
  const cmd = [
    "bun",
    "publish",
    path.slice(ROOT.length + 1),
    "--tag",
    tag,
    "--access",
    "public",
    ...(dryRun ? ["--dry-run"] : []),
  ]
  console.log(`$ ${cmd.join(" ")}`)
  const proc = Bun.spawn(cmd, { cwd: ROOT, stdout: "inherit", stderr: "pipe" })
  const [stderr, code] = await Promise.all([
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (stderr !== "") console.log(stderr.trimEnd())
  if (code !== 0) {
    if (dryRun) {
      console.log(
        `  (@bungohan/${name} exited ${code}; a dry run without a login ` +
          "reports an auth error)\n",
      )
      continue
    }
    console.error(
      `\n@bungohan/${name} failed (exit ${code}). The packages before it are ` +
        "published; fix and re-run — publish:alpha is safe to repeat, npm " +
        "refuses a version that already exists.",
    )
    process.exit(1)
  }
  console.log("")
}

/** Whether any stable (non-prerelease) version of the packages is on npm. */
async function stableExists(): Promise<boolean | undefined> {
  const proc = Bun.spawn(
    ["bunx", "npm", "view", "@bungohan/core", "versions", "--json"],
    { cwd: ROOT, stdout: "pipe", stderr: "ignore" },
  )
  const [out, code] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ])
  if (code !== 0) return undefined
  const parsed: unknown = JSON.parse(out)
  const versions = Array.isArray(parsed) ? parsed : [parsed]
  return versions.some((v) => typeof v === "string" && !v.includes("-"))
}

async function pointLatest(): Promise<void> {
  if (!moveLatest || tag === "latest" || !released.includes("-")) return
  const stable = await stableExists()
  if (stable === undefined && dryRun) {
    console.log("(couldn't read the published versions; listing anyway)")
  } else if (stable === undefined) {
    console.error(
      "couldn't read the published versions, so `latest` wasn't moved. " +
        "See RELEASING.md step 5 to move it by hand.",
    )
    process.exit(1)
  }
  if (stable) {
    console.log("a stable version is published; `latest` stays on it\n")
    return
  }
  console.log(`no stable version yet: pointing "latest" at ${released}\n`)
  for (const { name } of tarballs) {
    const spec = `@bungohan/${name}@${released}`
    const cmd = ["bunx", "npm", "dist-tag", "add", spec, "latest"]
    console.log(`$ ${cmd.join(" ")}`)
    if (dryRun) continue
    const code = await Bun.spawn(cmd, {
      cwd: ROOT,
      stdout: "inherit",
      stderr: "inherit",
    }).exited
    if (code !== 0) {
      console.error(
        `\nmoving "latest" failed at @bungohan/${name} (exit ${code}). ` +
          "Everything is published; re-run the dist-tag commands from here " +
          "on by hand (RELEASING.md step 5).",
      )
      process.exit(1)
    }
  }
  console.log("")
}

await pointLatest()

console.log(
  dryRun
    ? "dry run finished; nothing was uploaded"
    : `published ${released} on "${tag}".\n` +
        "Next: tag the release commit (see RELEASING.md).",
)
