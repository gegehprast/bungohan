import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import type { TestClientOptions } from "@bungohan/testing"
import { createTestHarness, type TestHarness } from "@bungohan/testing"
import { ArenaRoom } from "@bungohan/tutorial-server/ArenaRoom"
import { enter, mirror, remember, resume, type Scene, start } from "./client"

let h: TestHarness
let log: ReturnType<typeof spyOn>

beforeEach(async () => {
  log = spyOn(console, "log").mockImplementation(() => {})
  h = await createTestHarness({
    rooms: { arena: ArenaRoom },
    client: { pingInterval: 0, logger: { warn() {}, error() {} } },
  })
})

afterEach(async () => {
  await h.stop()
  log.mockRestore()
})

async function join(name: string, options: TestClientOptions = {}) {
  const client = await h.connect(options)
  const room = await enter(client, name)
  if (typeof room === "string") throw new Error(room)
  return { client, room }
}

function recordingScene() {
  const live = new Set<string>()
  const add = (key: string) => {
    if (live.has(key)) throw new Error(`${key} added twice`)
    live.add(key)
  }
  const scene: Scene = {
    addPlayer: (id) => add(`player:${id}`),
    addGem: (id) => add(`gem:${id}`),
    remove: (key) => live.delete(key),
    clear: () => live.clear(),
  }
  return { live, scene }
}

function memoryStorage(): Storage {
  const items = new Map<string, string>()
  return {
    get length() {
      return items.size
    },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) => void items.delete(key),
    setItem: (key, value) => void items.set(key, value),
  }
}

test("listen() mirrors state, and survives a reconnection", async () => {
  const alice = await join("Alice")
  const { live, scene } = recordingScene()
  mirror(alice.room, scene)
  expect(live.size).toBe(1 + 5)

  const bob = await join("Bob")
  await h.tick(50)
  expect(live.has(`player:${bob.room.sessionId}`)).toBe(true)

  // The connection drops; client-js reconnects after 1 s, and the fresh
  // snapshot builds a new replica, which listen() follows.
  const before = alice.room.state
  await h.dropConnection(alice.client)
  await h.tick(1000)
  await h.tick(50)
  expect(alice.room.status).toBe("joined")
  expect(alice.room.state).not.toBe(before)
  expect(live.size).toBe(2 + 5)
})

test("a remembered seat is resumed by a new client after a reload", async () => {
  const storage = memoryStorage()
  const tab = await join("Alice", { reconnection: { enabled: false } })
  remember(tab.room, storage)
  await h.dropConnection(tab.client) // the page went away without leaving

  const reloaded = await h.connect()
  const resumed = await resume(reloaded, storage)
  expect(resumed?.sessionId).toBe(tab.room.sessionId)
  expect(resumed?.state.players.get(tab.room.sessionId)?.name.get()).toBe(
    "Alice",
  )
})

test("start() resumes the seat after a reload, else joins afresh", async () => {
  const storage = memoryStorage()
  const first = await h.connect({ reconnection: { enabled: false } })
  const joined = await start(first, "Alice", storage)
  if (typeof joined === "string") throw new Error(joined)
  await h.dropConnection(first) // a reload: the socket closes, no LEAVE

  const resumed = await start(await h.connect(), "Alice", storage)
  if (typeof resumed === "string") throw new Error(resumed)
  expect(resumed.sessionId).toBe(joined.sessionId)

  storage.clear() // a new tab: nothing saved, so a fresh seat
  const fresh = await start(await h.connect(), "Bob", storage)
  if (typeof fresh === "string") throw new Error(fresh)
  expect(fresh.sessionId).not.toBe(joined.sessionId)
})
