/**
 * Runs a cross-language test runner against a live Bungohan server.
 *
 * It starts the interop server (`packages/testing/src/interop/server.ts`)
 * in this process, puts its URL in `BUNGOHAN_INTEROP_URL`, runs the given
 * command, and stops the server. That is how `bun run test:csharp` and
 * `bun run test:godot` reach a real server with one command, so the
 * server-side `behavior` vectors and the end-to-end tests are not skipped.
 *
 *     bun scripts/interop.ts [--cwd <dir>] <command> [args…]
 */
import { startInteropServer } from "../packages/testing/src/interop/server"

const argv = process.argv.slice(2)
let cwd = process.cwd()
if (argv[0] === "--cwd") {
  cwd = argv[1] ?? cwd
  argv.splice(0, 2)
}
if (argv.length === 0) {
  console.error("usage: bun scripts/interop.ts [--cwd <dir>] <command> [args…]")
  process.exit(2)
}

const server = await startInteropServer()
let code = 1
try {
  const child = Bun.spawn(argv, {
    cwd,
    env: { ...process.env, BUNGOHAN_INTEROP_URL: server.url },
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  })
  code = await child.exited
} finally {
  await server.stop()
}
process.exit(code)
