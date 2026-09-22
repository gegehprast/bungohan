import { afterEach, expect, spyOn, test } from "bun:test"
import { encodeSnapshot } from "@bungohan/state"
import { createTestHarness, type TestHarness } from "@bungohan/testing"
import {
  Card,
  equip,
  Hero,
  Holder,
  Inventory,
  Item,
  Stats,
  stock,
  TableRoom,
  TableState,
} from "./state"

let h: TestHarness | undefined

afterEach(async () => {
  await h?.stop()
  h = undefined
})

test("the example classes are valid, sync-able schemas", () => {
  const hero = new Hero()
  stock(hero.inventory)
  expect(encodeSnapshot(hero).isOk()).toBe(true)
  expect(new Stats().health.get()).toBe(100)
  expect(new Inventory().prices.size).toBe(0)
})

test("fixed-point keeps full precision on the server", () => {
  const stats = new Stats()
  stats.x.set(1.23456)
  expect(stats.x.get()).toBe(1.23456)
})

test("the ownership rule: release first, then assign", () => {
  const holder = new Holder()
  expect(encodeSnapshot(holder).isOk()).toBe(true)
  const item = new Item()
  holder.bag.set(1, item)

  // Assigning an instance a collection still holds is refused (and logged).
  const error = spyOn(console, "error").mockImplementation(() => {})
  const before = holder.hand
  holder.hand = item
  expect(holder.hand).toBe(before)
  expect(error).toHaveBeenCalled()
  error.mockRestore()

  expect(equip(holder, 1)).toBe(true)
  expect(holder.hand).toBe(item)
  expect(holder.bag.has(1)).toBe(false)
})

test("a filtered field reaches only the clients its filter admits", async () => {
  h = await createTestHarness({ rooms: { table: TableRoom } })
  const join = { state: TableState }
  const alice = (
    await (await h.connect()).joinOrCreate("table", {}, join)
  ).unwrap()
  const bob = (
    await (await h.connect()).joinOrCreate("table", {}, join)
  ).unwrap()
  await h.tick(50)

  const aliceCard = bob.state.cards.get(alice.sessionId)
  expect(aliceCard).toBeInstanceOf(Card)
  expect(aliceCard?.face.get()).toBe("face down")
  expect(aliceCard?.secret.get()).toBe("") // hidden from Bob
  expect(alice.state.cards.get(alice.sessionId)?.secret.get()).toBe(
    `secret of ${alice.sessionId}`,
  )
})
