/**
 * Both entry points bundle for the browser, so the tutorial's client code
 * keeps working in the place it is meant to run.
 */
import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const CLIENT = new URL("..", import.meta.url).pathname

test("the vanilla and React clients bundle for the browser", async () => {
  const out = await mkdtemp(join(tmpdir(), "bungohan-tutorial-"))
  try {
    const proc = Bun.spawn(
      [
        "bun",
        "build",
        "--target=browser",
        "--outdir",
        out,
        "src/main.ts",
        "src/react/main.tsx",
      ],
      { cwd: CLIENT, stdout: "pipe", stderr: "pipe" },
    )
    const [stderr, code] = await Promise.all([
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    expect(stderr).not.toContain("error")
    expect(code).toBe(0)
  } finally {
    await rm(out, { recursive: true, force: true })
  }
}, 30_000)
