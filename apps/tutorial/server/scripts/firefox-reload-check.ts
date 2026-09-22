/**
 * Real-browser regression check for the page-exit "ghost" (spec §7.5,
 * `leaveOnPageExit`): in Firefox-engine browsers a WebSocket message sent
 * from `pagehide` on a *reload* never leaves the browser, so a client that
 * only leaves on `pagehide` gets its seat held for the reconnection timeout
 * and its player stays in the room. Chromium delivers it, which is why
 * `check:browser` (Chromium) can't catch this.
 *
 * The real tutorial server (in-process, so the rooms can be inspected) and
 * the real vanilla tutorial client, in headless Firefox or Zen driven over
 * WebDriver BiDi. Load the page, reload it twice, and after each reload
 * the room must hold exactly one seat: the new page's.
 *
 * Run: `bun run check:firefox` (in apps/tutorial/server).
 * Needs Firefox or Zen: set FIREFOX to its binary, or have `firefox` or
 * `zen-browser` on PATH. Uses ports 6060 (the tutorial server, which the
 * client hard-codes) and 9224 (BiDi); both must be free.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createBungohanServer, type Room } from "@bungohan/core"
import { DEFAULT_PORT, ROOM_TYPE } from "@bungohan/tutorial-shared"
import page from "../../client/index.html"
import { ArenaRoom } from "../src/ArenaRoom"

const BIDI_PORT = 9224
const RELOADS = 2
/** How long a leave may take to reach the server after the new join. */
const SETTLE_MS = 1500

function browserBinary(): string | undefined {
  const fromEnv = process.env["FIREFOX"]
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv
  return Bun.which("firefox") ?? Bun.which("zen-browser") ?? undefined
}

interface BidiMessage {
  readonly type: "success" | "error" | "event"
  readonly id?: number
  readonly method?: string
  readonly result?: unknown
  readonly error?: string
  readonly message?: string
  readonly params?: {
    readonly level?: string
    readonly type?: string
    readonly text?: string
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms))
}

/** Polls `fn` until it returns something other than undefined/false. */
async function until<T>(
  what: string,
  fn: () => Promise<T | undefined | false> | T | undefined | false,
  ms = 20_000,
): Promise<T> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try {
      const value = await fn()
      if (value !== undefined && value !== false) return value
    } catch {
      // Not ready yet: retry until the deadline.
    }
    await sleep(100)
  }
  throw new Error(`timed out waiting for ${what}`)
}

function connectBidi(url: string): Promise<WebSocket> {
  return new Promise((done, fail) => {
    const socket = new WebSocket(url)
    socket.onopen = () => done(socket)
    socket.onerror = () => fail(new Error(`can't connect to ${url}`))
  })
}

const binary = browserBinary()
if (binary === undefined) {
  console.error(
    "No Firefox-engine browser found: set FIREFOX to its binary, or put " +
      "firefox or zen-browser on PATH (`bun run verify --no-firefox` skips " +
      "this check explicitly).",
  )
  process.exit(1)
}

const server = createBungohanServer({
  transport: { config: { port: DEFAULT_PORT } },
  logger: { level: "warn" },
})
server.defineRoomType(ROOM_TYPE, ArenaRoom, { maxClients: 16 })
const pages = Bun.serve({ port: 0, routes: { "/": page } })
const profileDir = mkdtempSync(join(tmpdir(), "bungohan-firefox-"))
let browser: Bun.Subprocess | undefined

/** Every seat in every arena, held ones included. */
function seats(): { sessionId: string; connected: boolean }[] {
  const rooms: Room[] = server.getMatchMaker().getAllRooms()
  return rooms
    .filter((room) => room.roomType === ROOM_TYPE)
    .flatMap((room) => room.getClients())
    .map((client) => ({
      sessionId: client.sessionId,
      connected: client.connected,
    }))
}

let failed = false
try {
  const started = await server.start()
  if (started.isErr()) throw started.error
  console.log(`browser: ${binary}`)
  browser = Bun.spawn(
    [
      binary,
      "--headless",
      "--no-remote",
      "--profile",
      profileDir,
      "--remote-debugging-port",
      String(BIDI_PORT),
    ],
    { stdout: "ignore", stderr: "ignore" },
  )
  const bidi = await until("the browser's BiDi endpoint", () =>
    connectBidi(`ws://127.0.0.1:${BIDI_PORT}/session`),
  )

  let nextId = 1
  const waiting = new Map<number, (message: BidiMessage) => void>()
  const errors: string[] = []
  bidi.onmessage = (event) => {
    const message = JSON.parse(String(event.data)) as BidiMessage
    if (message.id !== undefined) waiting.get(message.id)?.(message)
    const entry = message.params
    if (
      message.method === "log.entryAdded" &&
      entry?.level === "error" &&
      entry.type === "javascript"
    ) {
      errors.push(entry.text ?? "(no text)")
    }
  }
  const send = (method: string, params: object = {}): Promise<unknown> =>
    new Promise((done, fail) => {
      const id = nextId++
      waiting.set(id, (message) => {
        waiting.delete(id)
        if (message.type === "error") {
          fail(new Error(`${method}: ${message.error}: ${message.message}`))
        } else done(message.result)
      })
      bidi.send(JSON.stringify({ id, method, params }))
    })

  await send("session.new", { capabilities: {} })
  await send("session.subscribe", { events: ["log.entryAdded"] })
  const tree = (await send("browsingContext.getTree")) as {
    contexts: { context: string }[]
  }
  const context = tree.contexts[0]?.context
  if (context === undefined) throw new Error("the browser has no tab")

  const url = `http://localhost:${pages.port}/?name=Reloader`
  await send("browsingContext.navigate", { context, url, wait: "complete" })
  let current = await until("the first page to join", () => {
    const all = seats()
    return all.length === 1 && all[0]?.connected ? all[0].sessionId : false
  })
  console.log(`page joined as ${current}`)

  const checks: [string, boolean][] = []
  for (let i = 1; i <= RELOADS; i++) {
    const previous = current
    await send("browsingContext.reload", { context, wait: "complete" })
    current = await until(
      `reload ${i} to join`,
      () =>
        seats().find((s) => s.connected && s.sessionId !== previous)?.sessionId,
    )
    await sleep(SETTLE_MS)
    const after = seats()
    const ghosts = after.filter((s) => s.sessionId !== current)
    console.log(
      `reload ${i}: joined as ${current}; seats: ` +
        after
          .map((s) => `${s.sessionId}${s.connected ? "" : " (held)"}`)
          .join(", "),
    )
    checks.push([
      `reload ${i} leaves exactly one seat, no ghost`,
      after.length === 1 && ghosts.length === 0,
    ])
  }
  checks.push(["no JavaScript errors in the page", errors.length === 0])

  for (const [what, ok] of checks) console.log(ok ? "PASS" : "FAIL", what)
  if (errors.length > 0) console.log(errors)
  failed = checks.some(([, ok]) => !ok)
  bidi.close()
} catch (error) {
  console.error(error)
  failed = true
} finally {
  browser?.kill()
  // kill() only signals: the browser keeps writing its profile until it exits.
  await browser?.exited
  rmSync(profileDir, { recursive: true, force: true })
  await pages.stop(true)
  await server.stop()
}
process.exit(failed ? 1 : 0)
