/**
 * Refuses `bun publish` / `npm publish` run from a package directory.
 *
 * Both pack the directory themselves, and neither applies `publishConfig`,
 * so the published manifest would keep `"main": "./src/index.ts"` — a file
 * the tarball doesn't contain. `bun run pack` applies it; publish the
 * tarball it makes. See RELEASING.md.
 */
console.error(
  "Refusing to publish from a package directory: the manifest here points " +
    "at src/, and publish does not apply publishConfig.\n" +
    "Use the tarballs instead:\n" +
    "  bun run check:pack      # build, pack, prove\n" +
    "  bun run publish:dry\n" +
    "  bun run publish:alpha\n" +
    "See RELEASING.md.",
)
process.exit(1)
