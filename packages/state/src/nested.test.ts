/**
 * Replacing a directly nested Schema field (`holder.bag = new Bag()`) after
 * the instance is initialized: the server sends it, frees the old block,
 * and receivers forget the old binding (PROTOCOL.md §11.4–11.6).
 */
import { describe, expect, test } from "bun:test"
import { f, type WireOp } from "@bungohan/types"
import { applyDelta } from "./decoder"
import { encodeSnapshot } from "./encoder"
import {
  createInt,
  createSchemaArray,
  createSchemaMap,
  createString,
} from "./factories"
import { Schema } from "./schema"
import { SchemaRegistry } from "./schema-registry"
import { Peer } from "./test-fixtures"

class Gem extends Schema {
  public static override schemaName = "N.Gem"
  public v = createInt(f.uint8)
}

class Bag extends Schema {
  public static override schemaName = "N.Bag"
  public label = createString()
  public gems = createSchemaArray(Gem)
}

class Holder extends Schema {
  public static override schemaName = "N.Holder"
  public bag = new Bag()
  public spare = createSchemaMap(f.string, Bag)
}

class Crate extends Schema {
  public static override schemaName = "N.Crate"
  public bag = new Bag()
}

class Yard extends Schema {
  public static override schemaName = "N.Yard"
  public crates = createSchemaMap(f.string, Crate)
}

SchemaRegistry.register(Gem, Bag, Holder, Crate, Yard)

function gem(v: number): Gem {
  const g = new Gem()
  g.v.set(v)
  return g
}

function bag(label: string, ...gems: number[]): Bag {
  const b = new Bag()
  b.label.set(label)
  for (const v of gems) b.gems.push(gem(v))
  return b
}

function joined(setup?: (holder: Holder) => void): Peer<Holder> {
  const server = new Holder()
  setup?.(server)
  const peer = new Peer(server, new Holder())
  peer.join()
  return peer
}

function nonDefine(ops: WireOp[]): WireOp[] {
  return ops.filter((op) => op[0] !== 4)
}

// Holder: bag 0, spare 1 (refId 1). Bag: label 0, gems 1.
const BAG_FIELD = 0

describe("replacing a nested schema field (server)", () => {
  test("emits a SET with the new ref, then the new instance's content", () => {
    const peer = joined((h) => h.bag.label.set("old"))
    const oldRef = peer.server.bag._wireRef
    peer.server.bag = bag("new", 7)
    const ops = nonDefine(peer.sync())
    const newRef = peer.server.bag._wireRef
    expect(newRef).not.toBe(-1)
    expect(newRef).not.toBe(oldRef)
    const bagClass = (ops[0]?.[3] as [number, number] | undefined)?.[0]
    expect(ops[0]).toEqual([0, 0, BAG_FIELD, [bagClass ?? -1, newRef]])
    expect(ops).toContainEqual([0, newRef, 0, "new"])
    expect(ops.some((op) => op[0] === 1 && op[1] === newRef + 1)).toBe(true)
    peer.expectInSync()
    expect(peer.client.bag.gems.at(0)?.v.get()).toBe(7)
  })

  test("later mutations of the replacement are synchronized", () => {
    const peer = joined()
    peer.server.bag = bag("a")
    peer.sync()
    peer.server.bag.label.set("b")
    peer.server.bag.gems.push(gem(3))
    const ops = peer.sync()
    expect(ops.length).toBeGreaterThan(0)
    peer.expectInSync()
    expect(peer.client.bag.label.get()).toBe("b")
  })

  test("an idle tick after a replace sends nothing", () => {
    const peer = joined()
    peer.server.bag = bag("a")
    peer.sync()
    expect(peer.sync()).toEqual([])
  })

  test("releases the old instance: its block is reused after the commit", () => {
    const peer = joined((h) => h.bag.gems.push(gem(1)))
    const old = peer.server.bag
    const oldRef = old._wireRef
    const oldGemRef = old.gems.at(0)?._wireRef
    peer.server.bag = bag("a")
    peer.sync()
    expect(old._wireRef).toBe(-1)
    expect(old.gems.at(0)?._wireRef).toBe(-1)

    // LIFO reuse within the class: a new Bag takes the freed block, a new
    // Gem the freed Gem block.
    peer.server.spare.set("k", bag("reused", 9))
    peer.sync()
    const reused = peer.server.spare.get("k")
    expect(reused?._wireRef).toBe(oldRef)
    expect(reused?.gems.at(0)?._wireRef).toBe(oldGemRef)
    peer.expectInSync()
  })

  test("a replaced instance moved elsewhere in the same tick is sent anew", () => {
    const peer = joined((h) => h.bag.label.set("moved"))
    const old = peer.server.bag
    peer.server.bag = bag("fresh")
    peer.server.spare.set("k", old)
    peer.sync()
    peer.expectInSync()
    expect(peer.client.spare.get("k")).not.toBe(peer.client.bag)
    old.label.set("still tracked")
    peer.sync()
    peer.expectInSync()
  })

  test("an element moved into a nested field is sent anew", () => {
    const peer = joined((h) => h.spare.set("k", bag("elem", 4)))
    const element = peer.server.spare.get("k") as Bag
    peer.server.spare.delete("k")
    peer.server.bag = element
    peer.sync()
    peer.expectInSync()
    element.gems.push(gem(5))
    peer.sync()
    peer.expectInSync()
    expect(peer.client.bag.gems.length).toBe(2)
  })

  test("a snapshot after a replace carries the replacement", () => {
    const peer = joined()
    peer.server.bag = bag("snap", 2)
    peer.sync()
    const late = new Holder()
    const applied = applyDelta(late, encodeSnapshot(peer.server).unwrap())
    expect(applied.isOk()).toBe(true)
    expect(late.bag.label.get()).toBe("snap")
    expect(late.bag.gems.at(0)?.v.get()).toBe(2)
  })
})

describe("rebinding a nested object (receiver)", () => {
  // Holder 0, Bag 1, Gem 2. Holder at 0 (spare 1), Bag at 2 (gems 3),
  // Gem at 4. The replacement Bag gets 5 (gems 6).
  const defines: WireOp[] = [
    [
      4,
      0,
      "N.Holder",
      ["bag", "spare"],
      ["schema<N.Bag>", "schemaMap<string,N.Bag>"],
    ],
    [4, 1, "N.Bag", ["label", "gems"], ["string", "schemaArray<N.Gem>"]],
    [4, 2, "N.Gem", ["v"], ["uint8"]],
  ]
  const snapshot: WireOp[] = [
    ...defines,
    [0, 0, 0, [1, 2]],
    [0, 2, 0, "old"],
    [1, 3, 0, [2, 4]],
    [0, 4, 0, 1],
  ]

  function replica(): Holder {
    const client = new Holder()
    expect(applyDelta(client, snapshot).isOk()).toBe(true)
    return client
  }

  test("forgets the old refId and its collections' refIds", () => {
    const client = replica()
    expect(applyDelta(client, [[0, 0, 0, [1, 5]]]).isOk()).toBe(true)
    for (const op of [
      [0, 2, 0, "x"],
      [1, 3, 0, [2, 7]],
    ] as WireOp[]) {
      const stale = applyDelta(client, [op])
      expect(stale.isErr() && stale.error.code).toBe("UNKNOWN_REF")
    }
  })

  test("a reused refId creates a distinct object, not the nested one", () => {
    const client = replica()
    const oldGem = client.bag.gems.at(0)
    expect(applyDelta(client, [[0, 0, 0, [1, 5]]]).isOk()).toBe(true)
    expect(client.bag.gems.length).toBe(0)
    // Next frame: the freed Bag block 2..3 and Gem block 4 are reused.
    const reuse: WireOp[] = [
      [1, 1, "k", [1, 2]],
      [0, 2, 0, "reused"],
      [1, 3, 0, [2, 4]],
      [0, 4, 0, 9],
    ]
    expect(applyDelta(client, reuse).isOk()).toBe(true)
    const spare = client.spare.get("k")
    expect(spare).toBeDefined()
    expect(spare).not.toBe(client.bag)
    expect(spare?.label.get()).toBe("reused")
    expect(client.bag.label.get()).toBe("")
    expect(spare?.gems.at(0)).not.toBe(oldGem)
    expect(spare?.gems.at(0)?.v.get()).toBe(9)
  })

  test("a rebound object keeps one holder: dropping its owner drops it", () => {
    // Yard 0 (crates 1), Crate 1, Bag 2, Gem 3. A Crate at 2 holds its Bag
    // at 3 (gems 4); the Bag is rebound to 5 (gems 6), then the Crate goes.
    const yard = new Yard()
    const ops: WireOp[] = [
      [4, 0, "N.Yard", ["crates"], ["schemaMap<string,N.Crate>"]],
      [4, 1, "N.Crate", ["bag"], ["schema<N.Bag>"]],
      [4, 2, "N.Bag", ["label", "gems"], ["string", "schemaArray<N.Gem>"]],
      [4, 3, "N.Gem", ["v"], ["uint8"]],
      [1, 1, "c", [1, 2]],
      [0, 2, 0, [2, 3]],
    ]
    expect(applyDelta(yard, ops).isOk()).toBe(true)
    expect(applyDelta(yard, [[0, 2, 0, [2, 5]]]).isOk()).toBe(true)
    expect(applyDelta(yard, [[2, 1, "c"]]).isOk()).toBe(true)
    const stale = applyDelta(yard, [[0, 5, 0, "x"]])
    expect(stale.isErr() && stale.error.code).toBe("UNKNOWN_REF")
  })
})

class Unit extends Schema {
  public static override schemaName = "N.Unit"
  public v = createInt(f.uint8)
}

class Slot extends Schema {
  public static override schemaName = "N.Slot"
  public nested = new Unit()
}

class Owner extends Schema {
  public static override schemaName = "N.Owner"
  public nested = new Unit()
  public items = createSchemaMap(f.string, Unit)
  public slots = createSchemaMap(f.string, Slot)
}

SchemaRegistry.register(Unit, Slot, Owner)

function unit(v: number): Unit {
  const u = new Unit()
  u.v.set(v)
  return u
}

/** Runs `body` with `console.error` captured; returns the messages. */
function capturingErrors(body: () => void): string[] {
  const logged: string[] = []
  const original = console.error
  console.error = (...args: unknown[]) => logged.push(String(args[0]))
  try {
    body()
  } finally {
    console.error = original
  }
  return logged
}

describe("a nested field only takes an unattached instance", () => {
  test("assigning an element still in a map doesn't orphan the client's copy", () => {
    const peer = new Peer(new Owner(), new Owner())
    peer.join()
    const shared = unit(5)
    peer.server.items.set("k", shared)
    peer.sync()
    capturingErrors(() => {
      peer.server.nested = shared
    })
    peer.sync()
    shared.v.set(7)
    peer.sync()
    expect(peer.client.items.get("k")?.v.get()).toBe(7)
    peer.expectInSync()
  })

  test("refuses the assignment, keeps the server value and logs why", () => {
    const peer = new Peer(new Owner(), new Owner())
    peer.join()
    const shared = unit(5)
    peer.server.items.set("k", shared)
    peer.sync()
    const original = peer.server.nested
    const logged = capturingErrors(() => {
      peer.server.nested = shared
    })
    expect(peer.server.nested).toBe(original)
    expect(shared._parent).toBe(peer.server)
    expect(logged.length).toBe(1)
    expect(logged[0]).toContain("Owner.nested")
    expect(logged[0]).toContain("Owner.items")
    expect(logged[0]).toContain("remove it first")
    expect(peer.sync()).toEqual([])
    peer.expectInSync()
  })

  test("refuses one held by another nested field, the room state, or itself", () => {
    const peer = new Peer(new Owner(), new Owner())
    peer.join()
    const slot = new Slot()
    peer.server.slots.set("s", slot)
    peer.sync()
    const before = peer.server.nested
    const logged = capturingErrors(() => {
      peer.server.nested = slot.nested
      // The root isn't a Unit, but the check comes before any typing.
      ;(slot as unknown as { nested: Schema }).nested = peer.server
      const loose = Schema.create(Slot)
      ;(loose as unknown as { nested: Schema }).nested = loose
    })
    expect(logged.length).toBe(3)
    expect(logged[0]).toContain("a nested field of Slot")
    expect(logged[1]).toContain("room's state")
    expect(logged[2]).toContain("hold itself")
    expect(peer.server.nested).toBe(before)
    expect(slot.nested).toBeInstanceOf(Unit)
    expect(peer.sync()).toEqual([])
    peer.expectInSync()
  })

  test("removing it and assigning it in the same tick moves it", () => {
    const peer = new Peer(new Owner(), new Owner())
    peer.join()
    const shared = unit(5)
    const slot = new Slot()
    peer.server.items.set("k", shared)
    peer.server.slots.set("s", slot)
    peer.sync()
    const inSlot = slot.nested

    const logged = capturingErrors(() => {
      peer.server.items.delete("k")
      peer.server.nested = shared
      slot.nested = unit(1)
      peer.server.items.set("k2", inSlot)
    })
    expect(logged).toEqual([])
    expect(peer.server.nested).toBe(shared)
    peer.sync()
    peer.expectInSync()

    shared.v.set(7)
    inSlot.v.set(8)
    peer.sync()
    expect(peer.client.nested.v.get()).toBe(7)
    expect(peer.client.items.get("k2")?.v.get()).toBe(8)
    peer.expectInSync()
  })
})
