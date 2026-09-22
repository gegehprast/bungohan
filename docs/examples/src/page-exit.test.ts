/**
 * Page-exit handlers in a happy-dom window, against a real server: a leave
 * with the page is a consented leave, so no seat is held.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test"
import { createTestHarness, type TestHarness } from "@bungohan/testing"
import { ArenaRoom } from "@bungohan/tutorial-server/ArenaRoom"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { enter } from "./client"
import { leaveWithThePage } from "./page-exit"

let h: TestHarness

beforeAll(() => {
  GlobalRegistrator.register()
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

beforeEach(async () => {
  h = await createTestHarness({
    rooms: { arena: ArenaRoom },
    client: { pingInterval: 0, logger: { warn() {}, error() {} } },
  })
})

afterEach(async () => {
  await h.stop()
})

async function join(name: string) {
  const client = await h.connect()
  const room = await enter(client, name)
  if (typeof room === "string") throw new Error(room)
  return { client, room }
}

/** A reload: beforeunload, then pagehide, on the page's window. */
function reload(): void {
  window.dispatchEvent(new Event("beforeunload", { cancelable: true }))
  window.dispatchEvent(new Event("pagehide"))
}

test("leaveOnPageExit() listens on the page's window by default", async () => {
  const alice = await join("Alice")
  const bob = await join("Bob")
  const stop = alice.client.leaveOnPageExit()
  reload()
  stop()
  await h.tick(100) // deliver the LEAVE, then a sync tick for Bob
  expect(bob.room.state.players.has(alice.room.sessionId)).toBe(false)
  expect(alice.client.connectionState).toBe("disconnected")
})

test("an own handler leaves its room once, with the page", async () => {
  const alice = await join("Alice")
  const bob = await join("Bob")
  const stop = leaveWithThePage(alice.room)
  reload()
  stop()
  await h.tick(100) // deliver the LEAVE, then a sync tick for Bob
  expect(alice.room.status).toBe("left")
  expect(bob.room.state.players.has(alice.room.sessionId)).toBe(false)
})
