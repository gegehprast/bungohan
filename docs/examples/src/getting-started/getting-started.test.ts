/**
 * Runs the getting-started server and client exactly as the guide says:
 * two `bun` processes over a real WebSocket.
 */
import { expect, test } from "bun:test"

const HERE = import.meta.dir

function freePort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() })
  const port = probe.port
  void probe.stop(true)
  if (port === undefined) throw new Error("no free port")
  return port
}

async function readUntil(
  stream: ReadableStream<Uint8Array>,
  text: string,
): Promise<string> {
  const decoder = new TextDecoder()
  let seen = ""
  for await (const chunk of stream) {
    seen += decoder.decode(chunk)
    if (seen.includes(text)) return seen
  }
  throw new Error(`stream ended before "${text}"; saw: ${seen}`)
}

test("the first server and client talk", async () => {
  const port = freePort()
  const server = Bun.spawn(["bun", "server.ts"], {
    cwd: HERE,
    env: { ...process.env, PORT: String(port) },
    stdout: "pipe",
    stderr: "inherit",
  })
  try {
    await readUntil(server.stdout, "listening on")
    const client = Bun.spawn(["bun", "client.ts"], {
      cwd: HERE,
      env: { ...process.env, SERVER_URL: `ws://localhost:${port}` },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [out, err, code] = await Promise.all([
      new Response(client.stdout).text(),
      new Response(client.stderr).text(),
      client.exited,
    ])
    expect(err).toBe("")
    expect(code).toBe(0)
    expect(out).toContain("count is now 3")
  } finally {
    server.kill("SIGTERM")
    expect(await server.exited).toBe(0)
  }
}, 30_000)
