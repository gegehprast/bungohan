/**
 * Moves every published package to one version (lockstep), including the
 * exact `@bungohan/state` peer ranges that pin them to each other.
 *
 *     bun run version 0.1.0-alpha.2
 *     bun run version 0.1.0-alpha.2 --dry-run
 *
 * Lockstep is not a style choice: `core`, `client-js` and `schema` peer-depend
 * on `@bungohan/state` at an exact version so an app can only ever resolve one
 * copy (spec §6.10). Bumping one package alone would break its siblings' pins.
 */
import { join } from "node:path"
import { PUBLISHED, packageDir } from "./packages"

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[\w.-]+)?(?:\+[\w.-]+)?$/

const args = process.argv.slice(2)
const dryRun = args.includes("--dry-run")
const asked = args.find((arg) => !arg.startsWith("-"))

if (asked === undefined || !SEMVER.test(asked)) {
  console.error(
    "usage: bun run version <semver> [--dry-run]\n" +
      "  e.g. bun run version 0.1.0-alpha.2",
  )
  process.exit(1)
}
const next: string = asked

/** The exact ranges that must move with the version. */
function repin(deps: Record<string, string> | undefined): number {
  if (deps === undefined) return 0
  let changed = 0
  for (const name of Object.keys(deps)) {
    if (!name.startsWith("@bungohan/")) continue
    const range = deps[name]
    if (range === undefined || range.startsWith("workspace:")) continue
    if (range !== next) {
      deps[name] = next
      changed++
    }
  }
  return changed
}

for (const name of PUBLISHED) {
  const path = join(packageDir(name), "package.json")
  const pkg = await Bun.file(path).json()
  const was = pkg.version
  pkg.version = next
  const pins = repin(pkg.peerDependencies) + repin(pkg.dependencies)
  const note = pins > 0 ? `, ${pins} exact pin${pins === 1 ? "" : "s"}` : ""
  console.log(`@bungohan/${name}: ${was} → ${next}${note}`)
  if (!dryRun) await Bun.write(path, `${JSON.stringify(pkg, null, 2)}\n`)
}

console.log(
  dryRun
    ? "\n--dry-run: nothing was written"
    : `\n${PUBLISHED.length} packages at ${next}. Next: bun run verify`,
)
