import { afterEach, expect, spyOn, test } from "bun:test"
import { createTestHarness, type TestHarness } from "@bungohan/testing"
import { ChatRoom, ChatState, chatContract, OrderedRoom } from "./messages"
import { chat } from "./messages.client"

let h: TestHarness | undefined

afterEach(async () => {
  await h?.stop()
  h = undefined
})

const join = { state: ChatState, contract: chatContract }

test("typed and raw messages both ways", async () => {
  h = await createTestHarness({ rooms: { chat: ChatRoom } })
  const log = spyOn(console, "log").mockImplementation(() => {})
  const room = (await chat(await h.connect())).unwrap()
  await h.tick(50)
  expect(log.mock.calls).toContainEqual([`${room.sessionId}: hello`])
  expect(log.mock.calls).toContainEqual([
    "emote",
    { from: room.sessionId, emote: "wave" },
  ])
  log.mockRestore()
})

test("a per-client chain keeps async handlers in order", async () => {
  h = await createTestHarness({ rooms: { chat: OrderedRoom } })
  const room = (
    await (await h.connect()).joinOrCreate("chat", undefined, join)
  ).unwrap()
  const texts: string[] = []
  room.onMessage("said", ({ text }) => texts.push(text))
  // The first takes longest to moderate; without the chain it would finish last.
  room.send("say", { text: "first, and the longest", channel: "all" })
  room.send("say", { text: "second", channel: "all" })
  await h.tick(100)
  expect(texts).toEqual(["first, and the longest", "second"])
})
