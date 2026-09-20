/**
 * End-to-end browser check: the real server, the real Vite client and two
 * headless Chromium tabs over the DevTools protocol. Tab A creates a room,
 * tab B joins it by code, both ready up and start, and B holds `D`. The
 * frames each tab sent and received are decoded with the framework's own
 * codec to check that B's move reaches A's state. B walks away from the
 * nearer wall, since players spawn at a random x and the arena clamps.
 *
 * Run: `bun run check:browser` (in apps/example-shooter/server).
 * Needs Chromium on PATH, or set CHROMIUM to its binary. Uses ports 6060
 * (server), 5173 (Vite) and 9223 (DevTools); all must be free.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { GAME_CONFIG, GameState, Input } from "@bungohan/example-shooter-shared"
import {
  decodeFrame,
  type Frame,
  MessagePackSerializer,
  SchemaCodec,
} from "@bungohan/serializer"
import {
  applyDelta,
  reachableSchemaClasses,
  SchemaRegistry,
} from "@bungohan/state"
import { CLIENT_FRAME_HEADERS, SERVER_FRAME_HEADERS } from "@bungohan/types"

const SERVER_DIR = resolve(import.meta.dir, "..")
const CLIENT_DIR = resolve(import.meta.dir, "../../client")
const CHROMIUM = process.env["CHROMIUM"] ?? "chromium"
const VITE_URL = "http://localhost:5173/"
const DEVTOOLS_PORT = 9223
const JOIN_SUCCESS = 4
const STATE_SNAPSHOT = 2
const STATE_PATCH = 3
const ROOM_MESSAGE = 0

interface CdpMessage {
  readonly id?: number
  readonly method?: string
  readonly sessionId?: string
  readonly result?: unknown
  readonly error?: { readonly message: string }
  readonly params?: {
    readonly response?: {
      readonly opcode: number
      readonly payloadData: string
    }
    readonly exceptionDetails?: {
      readonly text: string
      readonly exception?: { readonly description?: string }
    }
    readonly type?: string
    readonly args?: readonly {
      readonly value?: unknown
      readonly description?: string
    }[]
  }
}

interface Tab {
  readonly name: string
  readonly session: string
  readonly received: Uint8Array[]
  readonly sent: Uint8Array[]
}

interface Handshake {
  readonly roomRef: number | undefined
  readonly body: readonly unknown[]
}

const procs: Bun.Subprocess[] = []
const profileDir = mkdtempSync(join(tmpdir(), "bungohan-two-tab-"))

function spawn(cmd: string[], cwd: string): void {
  procs.push(Bun.spawn(cmd, { cwd, stdout: "ignore", stderr: "ignore" }))
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

let failed = false
try {
  spawn(["bun", "src/index.ts"], SERVER_DIR)
  spawn(["bun", "x", "vite", "--port", "5173", "--strictPort"], CLIENT_DIR)
  await until("the Vite dev server", async () => (await fetch(VITE_URL)).ok)

  spawn(
    [
      CHROMIUM,
      "--headless=new",
      `--remote-debugging-port=${DEVTOOLS_PORT}`,
      "--no-first-run",
      `--user-data-dir=${profileDir}`,
      "about:blank",
    ],
    SERVER_DIR,
  )
  const version = await until("Chromium's DevTools endpoint", async () => {
    const res = await fetch(`http://127.0.0.1:${DEVTOOLS_PORT}/json/version`)
    return (await res.json()) as { webSocketDebuggerUrl: string }
  })

  const cdp = new WebSocket(version.webSocketDebuggerUrl)
  await new Promise((done) => {
    cdp.onopen = done
  })
  let nextId = 1
  const waiting = new Map<number, (message: CdpMessage) => void>()
  const listeners: ((message: CdpMessage) => void)[] = []
  cdp.onmessage = (event) => {
    const message = JSON.parse(String(event.data)) as CdpMessage
    if (message.id !== undefined) waiting.get(message.id)?.(message)
    else for (const listener of listeners) listener(message)
  }
  const send = (
    method: string,
    params: object = {},
    sessionId?: string,
  ): Promise<unknown> =>
    new Promise((done, fail) => {
      const id = nextId++
      waiting.set(id, (message) => {
        if (message.error !== undefined) {
          fail(new Error(`${method}: ${message.error.message}`))
        } else done(message.result)
      })
      cdp.send(JSON.stringify({ id, method, params, sessionId }))
    })

  const errors: string[] = []
  const open = async (name: string): Promise<Tab> => {
    const { targetId } = (await send("Target.createTarget", {
      url: "about:blank",
    })) as { targetId: string }
    const { sessionId } = (await send("Target.attachToTarget", {
      targetId,
      flatten: true,
    })) as { sessionId: string }
    const tab: Tab = { name, session: sessionId, received: [], sent: [] }
    listeners.push((message) => {
      if (message.sessionId !== sessionId) return
      const params = message.params
      const binary =
        params?.response?.opcode === 2 ? params.response : undefined
      if (binary !== undefined) {
        const bytes = Buffer.from(binary.payloadData, "base64")
        if (message.method === "Network.webSocketFrameReceived") {
          tab.received.push(bytes)
        } else if (message.method === "Network.webSocketFrameSent") {
          tab.sent.push(bytes)
        }
      }
      if (message.method === "Runtime.exceptionThrown") {
        const details = params?.exceptionDetails
        errors.push(
          `${name}: ${details?.exception?.description ?? details?.text}`,
        )
      }
      if (
        message.method === "Runtime.consoleAPICalled" &&
        (params?.type === "error" || params?.type === "warning")
      ) {
        const text = (params.args ?? [])
          .map((arg) => String(arg.value ?? arg.description))
          .join(" ")
        errors.push(`${name} console.${params.type}: ${text}`)
      }
    })
    await send("Network.enable", {}, sessionId)
    await send("Runtime.enable", {}, sessionId)
    await send("Page.enable", {}, sessionId)
    await send("Page.navigate", { url: VITE_URL }, sessionId)
    return tab
  }

  const evaluate = async (tab: Tab, expression: string): Promise<unknown> => {
    const response = (await send(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true },
      tab.session,
    )) as { result: { value?: unknown } }
    return response.result.value
  }
  const click = (tab: Tab, label: string): Promise<unknown> =>
    until(`${tab.name} to click "${label}"`, () =>
      evaluate(
        tab,
        `(() => {
          const all = [...document.querySelectorAll("button")].filter((b) => !b.disabled)
          const b = all.findLast((b) => b.textContent.trim() === ${JSON.stringify(label)})
            ?? all.findLast((b) => b.textContent.includes(${JSON.stringify(label)}))
          if (!b) return undefined
          b.click()
          return true
        })()`,
      ),
    )
  const fill = (
    tab: Tab,
    placeholder: string,
    value: string,
  ): Promise<unknown> =>
    until(`${tab.name} to fill "${placeholder}"`, () =>
      evaluate(
        tab,
        `(() => {
          const i = document.querySelector(${JSON.stringify(`input[placeholder="${placeholder}"]`)})
          if (!i) return undefined
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")
            .set.call(i, ${JSON.stringify(value)})
          i.dispatchEvent(new Event("input", { bubbles: true }))
          return true
        })()`,
      ),
    )

  const a = await open("A")
  const b = await open("B")
  await click(a, "Create Room")
  await fill(a, "Enter your name", "Alice")
  await click(a, "Create")
  const code = String(
    await until("the room code", () =>
      evaluate(
        a,
        `(() => {
          const e = [...document.querySelectorAll("*")].find((e) =>
            e.children.length === 0 && /^[A-Z2-9]{6}$/.test(e.textContent.trim()))
          return e?.textContent.trim()
        })()`,
      ),
    ),
  )
  console.log("room code", code)
  await click(b, "Join by Code")
  await fill(b, "ABC123", code)
  await click(b, "Join")
  await fill(b, "Enter your name", "Bob")
  await click(b, "Join")
  await click(b, "✓ Ready")
  await click(a, "✓ Ready")
  await click(a, "Start Game")
  await until(
    "a canvas in both tabs",
    async () =>
      (await evaluate(a, `!!document.querySelector("canvas")`)) === true &&
      (await evaluate(b, `!!document.querySelector("canvas")`)) === true,
  )

  // Decode what the tabs exchanged: handshakes first, then shooter state.
  const messagePack = new MessagePackSerializer()
  const serverFrames = (tab: Tab): Frame[] =>
    tab.received.map((bytes) =>
      decodeFrame(bytes, SERVER_FRAME_HEADERS).unwrap(),
    )
  const handshakes = (tab: Tab): Handshake[] =>
    serverFrames(tab)
      .filter((frame) => frame.type === JOIN_SUCCESS)
      .map((frame) => ({
        roomRef: frame.header[1],
        body: messagePack.decode(frame.body).unwrap() as unknown[],
      }))
  const shooterHandshake = (tab: Tab): Handshake | undefined =>
    handshakes(tab).find((h) => h.body[1] === "shooter")
  for (const tab of [a, b]) {
    for (const { body } of handshakes(tab)) {
      console.log(tab.name, "joined", body[1], "with codec", body[5])
    }
  }

  for (const cls of reachableSchemaClasses(GameState)) {
    SchemaRegistry.register(cls)
  }
  const replicaOfA = (): { state: GameState; frames: number } => {
    const codec = new SchemaCodec()
    const shooterRef = shooterHandshake(a)?.roomRef
    let session = codec.createSession()
    let state = new GameState()
    let frames = 0
    for (const frame of serverFrames(a)) {
      if (frame.header[0] !== shooterRef) continue
      if (frame.type !== STATE_SNAPSHOT && frame.type !== STATE_PATCH) continue
      if (frame.type === STATE_SNAPSHOT) {
        session = codec.createSession()
        state = new GameState()
      }
      applyDelta(state, session.decodeOps(frame.body).unwrap()).unwrap()
      frames++
    }
    return { state, frames }
  }

  const bobSession = String(
    await until("B's sessionId", () => shooterHandshake(b)?.body[2]),
  )
  const before = replicaOfA().state.players.get(bobSession)?.x.get()
  console.log("B's x in A's replica before:", before)

  await send("Page.bringToFront", {}, b.session)
  // Players spawn at a random x and the arena clamps at its edges, so
  // walk whichever way has room: near the right wall, "d" moves nothing.
  const left =
    typeof before === "number" && before > GAME_CONFIG.ARENA_WIDTH / 2
  const [keyName, keyCode, keyValue] = left
    ? ["a", "KeyA", 65]
    : ["d", "KeyD", 68]
  const key = (type: "keyDown" | "keyUp"): Promise<unknown> =>
    send(
      "Input.dispatchKeyEvent",
      {
        type,
        key: keyName,
        code: keyCode,
        windowsVirtualKeyCode: keyValue,
        text: type === "keyDown" ? keyName : undefined,
      },
      b.session,
    )
  await key("keyDown")
  await sleep(1200)
  await key("keyUp")
  await sleep(500)

  const { state, frames } = replicaOfA()
  const after = state.players.get(bobSession)?.x.get()
  console.log(`B's x in A's replica after: ${after} (${frames} state frames)`)

  const bobHandshake = shooterHandshake(b)
  const clientMessages = (bobHandshake?.body[6] ?? []) as string[]
  const inputId = clientMessages.indexOf("input")
  const inputs = b.sent
    .map((bytes) => decodeFrame(bytes, CLIENT_FRAME_HEADERS).unwrap())
    .filter(
      (frame) =>
        frame.type === ROOM_MESSAGE &&
        frame.header[0] === bobHandshake?.roomRef &&
        frame.header[1] === inputId,
    )
  const decodedInputs = inputs.map((frame) =>
    new SchemaCodec().decodeMessage(Input, frame.body),
  )
  const bodySizes = [...new Set(inputs.map((frame) => frame.body.byteLength))]
  console.log(`B sent ${inputs.length} input messages; body sizes`, bodySizes)
  const patches = serverFrames(a).filter(
    (frame) =>
      frame.type === STATE_PATCH &&
      frame.header[0] === shooterHandshake(a)?.roomRef,
  )
  const meanPatch =
    patches.reduce((sum, frame) => sum + frame.body.byteLength, 0) /
    Math.max(patches.length, 1)
  console.log(
    `A got ${patches.length} STATE_PATCH frames, mean body ${meanPatch.toFixed(1)} B`,
  )

  const checks: [string, boolean][] = [
    [
      "every handshake names the schema codec",
      [...handshakes(a), ...handshakes(b)].every((h) => h.body[5] === "schema"),
    ],
    [
      `B's player moved ${left ? "left" : "right"} in A's replica`,
      typeof before === "number" &&
        typeof after === "number" &&
        (left ? after < before - 50 : after > before + 50),
    ],
    [
      "B's inputs decode under the schema codec",
      decodedInputs.length > 0 && decodedInputs.every((d) => d.isOk()),
    ],
    ["no console errors or exceptions", errors.length === 0],
  ]
  for (const [what, ok] of checks) console.log(ok ? "PASS" : "FAIL", what)
  if (errors.length > 0) console.log(errors)
  failed = checks.some(([, ok]) => !ok)
  cdp.close()
} catch (error) {
  console.error(error)
  failed = true
} finally {
  for (const proc of procs) proc.kill()
  // kill() only signals: Chromium keeps writing its profile until it exits.
  await Promise.all(procs.map((proc) => proc.exited))
  rmSync(profileDir, { recursive: true, force: true })
}
process.exit(failed ? 1 : 0)
