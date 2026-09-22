/**
 * Publishes the packed tarballs, in dependency order.
 *
 *     bun run publish:dry          # prints and dry-runs every command
 *     bun run publish:alpha        # the real thing, on the "alpha" dist-tag
 *     bun scripts/publish.ts --tag latest
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
const tag = args[args.indexOf("--tag") + 1]

if (!args.includes("--tag") || tag === undefined || tag.startsWith("-")) {
  console.error("usage: bun scripts/publish.ts --tag <dist-tag> [--dry-run]")
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

console.log(
  dryRun
    ? "dry run finished; nothing was uploaded"
    : `published ${released} on "${tag}".\n` +
        "Next: tag the commit, then `bun scripts/published.ts` " +
        "(see RELEASING.md).",
)
