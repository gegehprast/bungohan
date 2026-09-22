import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import { MemoryStore } from "@bungohan/core"
import { createTestHarness, type TestHarness } from "@bungohan/testing"
import { GuildRoom, GuildState } from "./lifecycle"

let h: TestHarness | undefined
let log: ReturnType<typeof spyOn>

beforeEach(() => {
  log = spyOn(console, "log").mockImplementation(() => {})
})

afterEach(async () => {
  await h?.stop()
  h = undefined
  log.mockRestore()
})

const guild = { state: GuildState }

async function harness(store = new MemoryStore()) {
  return createTestHarness({
    rooms: { guild: GuildRoom },
    server: { store: { provider: store } },
    client: { pingInterval: 0, logger: { warn() {}, error() {} } },
  })
}

test("onAuth refuses a missing token, admits a valid one", async () => {
  h = await harness()
  const anonymous = await (await h.connect()).joinOrCreate("guild", {}, guild)
  expect(anonymous.isErr() && anonymous.error.code).toBe("AUTH_FAILED")

  const ada = await h.connect({ token: "user:ada" })
  const room = (await ada.joinOrCreate("guild", {}, guild)).unwrap()
  expect(room.state.members.get(room.sessionId)?.name.get()).toBe("ada")
})

test("a drop marks the member away, a reconnect back online", async () => {
  h = await harness()
  const ada = await h.connect({ token: "user:ada" })
  const room = (await ada.joinOrCreate("guild", {}, guild)).unwrap()
  const bob = await h.connect({ token: "user:bob" })
  const watcher = (await bob.joinOrCreate("guild", {}, guild)).unwrap()

  await h.dropConnection(ada)
  await h.tick(50)
  expect(watcher.state.members.get(room.sessionId)?.online.get()).toBe("away")

  await h.tick(1000) // the client's reconnection backoff (1 s)
  await h.tick(50)
  expect(room.status).toBe("joined")
  expect(watcher.state.members.get(room.sessionId)?.online.get()).toBe("online")
})

test("state saved on dispose is loaded by the next room", async () => {
  const store = new MemoryStore()
  h = await harness(store)
  const ada = await h.connect({ token: "user:ada" })
  const first = (await ada.joinOrCreate("guild", {}, guild)).unwrap()
  h.stateOf(GuildRoom, first).treasury.set(250)
  await first.leave()
  await h.tick(50) // last seat gone: the room auto-disposes and saves

  const again = (await ada.joinOrCreate("guild", {}, guild)).unwrap()
  expect(again.id).not.toBe(first.id)
  expect(again.state.treasury.get()).toBe(250)
})
