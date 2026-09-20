/**
 * The interop server (`server.ts`) through client-js over a real
 * WebSocket. The C# and GDScript runners talk to this same server
 * (`bun run test:csharp` / `test:godot`), so this suite is what keeps it
 * honest between those runs: if a room type, a message or a field here
 * changes, this fails in `bun test` rather than in another language.
 */
import { afterEach, expect, test } from "bun:test"
import { BungohanClient } from "@bungohan/client-js"
import { type InteropServerHandle, startInteropServer } from "./server"
import { InteropState, interopContract } from "./shared"

let handle: InteropServerHandle | undefined
let client: BungohanClient | undefined

afterEach(async () => {
  await client?.disconnect()
  await handle?.stop()
  client = undefined
  handle = undefined
})

async function connect(): Promise<BungohanClient> {
  handle = await startInteropServer()
  client = new BungohanClient({
    url: handle.url,
    autoConnect: false,
    pingInterval: 0,
  })
  ;(await client.connect()).unwrap()
  return client
}

const join = { state: InteropState, contract: interopContract }

/** Waits for a state frame to bring the replica up to date (real time). */
async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5000
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(5)
  }
}

test("typed messages drive the state, and the dump mirrors it", async () => {
  const c = await connect()
  const room = (await c.joinOrCreate("interop", {}, join)).unwrap()

  const welcome = new Promise<string>((resolve) => {
    room.onMessage("welcome", ({ sessionId }) => resolve(sessionId))
  })
  expect(await welcome).toBe(room.sessionId)

  room.send("setName", { name: "ada" })
  room.send("move", { dx: 1.25, dy: -3.5 })
  room.send("move", { dx: 0.5, dy: 0.25 })
  room.send("addTag", { tag: "red" })
  room.send("bump", { by: 7, alive: false, note: "hi" })

  // Messages are answered at once, but state arrives on the next sync
  // tick, so wait for the replica before comparing the two.
  await until(() => room.state.turn.get() === 2, "the state to catch up")

  const dumped = new Promise<unknown>((resolve) => {
    room.onMessage("dump", resolve)
  })
  room.send("requestDump", {})
  const dump = (await dumped) as {
    turn: number
    label: string
    log: string[]
    players: { id: string; name: string; x: number; y: number }[]
  }

  const player = room.state.players.get(room.sessionId)
  expect(player?.name.get()).toBe("ada")
  expect(player?.x.get()).toBe(1.75)
  expect(player?.y.get()).toBe(-3.25)
  expect(player?.score.get()).toBe(7)
  expect(player?.alive.get()).toBe(false)
  expect([...(player?.tags.value ?? [])]).toEqual(["red"])
  expect([...room.state.log.value]).toEqual(["name:ada", "note:hi"])

  expect(dump.turn).toBe(room.state.turn.get())
  expect(dump.label).toBe("interop")
  expect(dump.log).toEqual([...room.state.log.value])
  expect(dump.players.map((p) => p.id)).toEqual([room.sessionId])
  expect(dump.players[0]?.x).toBe(1.75)
})

test("an absent optional decodes as absent", async () => {
  const c = await connect()
  const room = (await c.joinOrCreate("interop", {}, join)).unwrap()
  const echoed = new Promise<Record<string, unknown>>((resolve) => {
    room.onMessage("echoed", (message) =>
      resolve(message as unknown as Record<string, unknown>),
    )
  })
  room.send("echo", { text: "hello", count: 0 })
  const message = await echoed
  expect(message["text"]).toBe("hello")
  expect("note" in message).toBe(false)
})

test("kickMe ends the room but not the connection", async () => {
  const c = await connect()
  const room = (await c.joinOrCreate("interop", {}, join)).unwrap()
  const left = new Promise<number>((resolve) => {
    room.onLeave(resolve)
  })
  room.send("kickMe", { reason: "bye" })
  expect(await left).toBe(4000)
  expect(c.connectionState).toBe("connected")
})

test("a wrong contract hash is refused before any hook runs", async () => {
  const c = await connect()
  // Sent by hand: client-js always sends the real hash of its contract.
  const joined = await c.joinOrCreate(
    "interop",
    {},
    {
      state: InteropState,
      contract: { ...interopContract },
    },
  )
  // A shallow copy hashes the same, so this must succeed…
  expect(joined.isOk()).toBe(true)
  const bad = await c.joinOrCreate(
    "interop",
    {},
    {
      state: InteropState,
      contract: {
        client: interopContract.client,
        server: { welcome: interopContract.server.welcome },
      },
    },
  )
  expect(bad.isErr()).toBe(true)
  if (bad.isErr()) expect(bad.error.code).toBe("CONTRACT_MISMATCH")
})

test("the compat room the behavior vectors target exists and has no contract", async () => {
  const c = await connect()
  const room = (await c.joinOrCreate("compat")).unwrap()
  expect(room.roomType).toBe("compat")
  // The vectors' server-side cases send raw frames into exactly this
  // room, at roomRef 1, and expect `t` to be a handled raw message.
  expect(room.sendRaw("t", { any: "shape" }).isOk()).toBe(true)
  // It declares no contract, so any client hash is a mismatch.
  const typed = await c.joinOrCreate(
    "compat",
    {},
    { contract: interopContract },
  )
  expect(typed.isErr()).toBe(true)
  if (typed.isErr()) expect(typed.error.code).toBe("CONTRACT_MISMATCH")
  await Bun.sleep(30)
  expect(room.status).toBe("joined")
  expect(c.connectionState).toBe("connected")
})

test("raw messages round-trip through the interop room", async () => {
  const c = await connect()
  const room = (await c.joinOrCreate("interop", {}, join)).unwrap()
  const echoed = new Promise<[string, unknown]>((resolve) => {
    room.onMessageRaw((type, payload) => resolve([type, payload]))
  })
  room.sendRaw("ping", [1, "two", true])
  expect(await echoed).toEqual(["pong", [1, "two", true]])
})
