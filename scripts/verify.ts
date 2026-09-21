/**
 * Runs every check a change must pass, the same way every time:
 *
 *     bun run verify               # all six
 *     bun run verify --no-redis    # without Valkey/Redis (shown as SKIPPED)
 *     bun run verify --no-browser  # without Chromium (shown as SKIPPED)
 *
 * The point is that nothing passes by quietly skipping. `bun test` without
 * REDIS_URL skips the Redis suites and still reports success, and a check
 * nobody remembers to run can't fail. Here Redis and the browser check are
 * required unless explicitly opted out, an opt-out is printed as SKIPPED,
 * and a `bun test` run that skipped anything fails.
 */
import { RedisClient } from "bun"

const ROOT = new URL("..", import.meta.url).pathname
const args = new Set(process.argv.slice(2))
const withRedis = !args.has("--no-redis")
const withBrowser = !args.has("--no-browser")
const redisUrl = process.env["REDIS_URL"] ?? "redis://127.0.0.1:6379"

interface Step {
  readonly name: string
  readonly cmd: string[]
  readonly cwd?: string
  readonly env?: Record<string, string>
  /** Why this step can't pass as run, or undefined if it can. */
  readonly check?: (output: string) => string | undefined
}

type Outcome =
  | { readonly status: "PASS"; readonly ms: number }
  | { readonly status: "FAIL"; readonly ms: number; readonly why: string }
  | { readonly status: "SKIPPED"; readonly why: string }

/** Fails a `bun test` run that skipped tests: a skip is not a pass. */
function noSkips(output: string): string | undefined {
  const skipped = /^\s*(\d+) skip$/m.exec(output)?.[1]
  if (skipped === undefined || skipped === "0") return undefined
  return `${skipped} tests were skipped (Redis suites need REDIS_URL)`
}

async function redisReachable(url: string): Promise<string | undefined> {
  const client = new RedisClient(url)
  try {
    await Promise.race([
      client.ping(),
      new Promise((_, fail) =>
        setTimeout(() => fail(new Error("timed out")), 2000),
      ),
    ])
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  } finally {
    client.close()
  }
}

async function run(step: Step): Promise<Outcome> {
  const start = performance.now()
  const proc = Bun.spawn(step.cmd, {
    cwd: step.cwd ?? ROOT,
    env: { ...process.env, ...step.env },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  const ms = performance.now() - start
  const output = `${out}\n${err}`
  if (code !== 0) {
    const tail = output.trim().split("\n").slice(-25).join("\n")
    return { status: "FAIL", ms, why: `exit ${code}\n${tail}` }
  }
  const problem = step.check?.(output)
  if (problem !== undefined) return { status: "FAIL", ms, why: problem }
  return { status: "PASS", ms }
}

const steps: Step[] = [
  {
    name: "bun test",
    cmd: ["bun", "test"],
    env: withRedis ? { REDIS_URL: redisUrl } : {},
    ...(withRedis && { check: noSkips }),
  },
  { name: "tsc --noEmit", cmd: ["bunx", "--bun", "tsc", "--noEmit"] },
  { name: "biome check", cmd: ["bunx", "--bun", "biome", "check"] },
  { name: "test:csharp", cmd: ["bun", "run", "test:csharp"] },
  { name: "test:godot", cmd: ["bun", "run", "test:godot"] },
  {
    name: "check:browser",
    cmd: ["bun", "run", "check:browser"],
    cwd: `${ROOT}apps/example-shooter/server`,
  },
]

const results: [string, Outcome][] = []
if (withRedis) {
  const down = await redisReachable(redisUrl)
  if (down !== undefined) {
    console.error(
      `Redis isn't reachable at ${redisUrl} (${down}).\n` +
        "Start Valkey/Redis, set REDIS_URL, or pass --no-redis to skip the " +
        "Redis suites explicitly.",
    )
    process.exit(1)
  }
}

for (const step of steps) {
  if (step.name === "check:browser" && !withBrowser) {
    results.push([step.name, { status: "SKIPPED", why: "--no-browser" }])
    continue
  }
  const tty = process.stdout.isTTY === true
  if (tty) process.stdout.write(`… ${step.name}`)
  const outcome = await run(step)
  if (tty) process.stdout.write("\r\x1b[K")
  results.push([step.name, outcome])
  const time = "ms" in outcome ? ` (${(outcome.ms / 1000).toFixed(1)}s)` : ""
  console.log(`${outcome.status.padEnd(7)} ${step.name}${time}`)
  if (outcome.status === "FAIL") console.log(`\n${outcome.why}\n`)
}
if (!withRedis) {
  results.push(["redis suites", { status: "SKIPPED", why: "--no-redis" }])
}

console.log("\n── verify ─────────────────────────")
for (const [name, outcome] of results) {
  const note = outcome.status === "SKIPPED" ? `  (${outcome.why})` : ""
  console.log(`${outcome.status.padEnd(7)} ${name}${note}`)
}
const failed = results.filter(([, o]) => o.status === "FAIL").length
const skipped = results.filter(([, o]) => o.status === "SKIPPED").length
console.log(
  failed > 0
    ? `\n${failed} FAILED`
    : skipped > 0
      ? `\nall run checks passed; ${skipped} skipped on request`
      : "\nall six passed",
)
process.exit(failed > 0 ? 1 : 0)
