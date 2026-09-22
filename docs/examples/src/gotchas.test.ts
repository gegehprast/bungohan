import { afterEach, expect, test } from "bun:test"
import {
  createServerHarness,
  createTestHarness,
  type TestHarness,
} from "@bungohan/testing"
import { EnemyRoom, Tower, TowerRoom } from "./gotchas"

let h: TestHarness | undefined

afterEach(async () => {
  await h?.stop()
  h = undefined
})

test("a room whose state lacks schemaName is refused at definition", async () => {
  const server = await createServerHarness()
  expect(() => server.define("enemies", EnemyRoom)).toThrow(/schemaName/)
  await server.stop()
})

test("plain fields never reach clients", async () => {
  h = await createTestHarness({ rooms: { tower: TowerRoom } })
  const view = (
    await (await h.connect()).joinOrCreate("tower", {}, { state: Tower })
  ).unwrap()
  const room = h.server.getMatchMaker().getRoom(view.id)
  if (!(room instanceof TowerRoom)) throw new Error("no room")
  room.state.hp = 42
  room.state.armor.set(9)
  await h.flushSync()

  expect(view.state.armor.get()).toBe(9)
  expect(view.state.hp).toBe(100) // the client's own initializer, never updated
})
