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
  createSchemaSet,
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

class Box extends Schema {
  public static override schemaName = "N.Box"
  public units = createSchemaArray(Unit)
}

class Owner extends Schema {
  public static override schemaName = "N.Owner"
  public nested = new Unit()
  public items = createSchemaMap(f.string, Unit)
  public slots = createSchemaMap(f.string, Slot)
  public pool = createSchemaSet(Unit)
  public list = createSchemaArray(Unit)
  public boxes = createSchemaMap(f.string, Box)
}

SchemaRegistry.register(Unit, Slot, Box, Owner)

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
    expect(logged[0]).toContain("held by Slot.nested")
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

function owner(): Peer<Owner> {
  const peer = new Peer(new Owner(), new Owner())
  peer.join()
  return peer
}

describe("a nested field owns its instance exclusively", () => {
  test("a collection can't take the nested instance (would orphan it)", () => {
    const peer = owner()
    const a = peer.server.nested
    a.v.set(1)
    peer.sync()
    const logged = capturingErrors(() => {
      peer.server.items.set("k", a)
    })
    expect(logged.length).toBe(1)
    peer.sync()
    peer.server.nested = unit(2)
    peer.sync()
    for (const key of ["x", "y", "z"]) peer.server.items.set(key, unit(3))
    peer.sync()
    a.v.set(9)
    peer.sync()
    expect(peer.server.items.has("k")).toBe(false)
    expect(peer.client.items.has("k")).toBe(false)
    peer.expectInSync()
  })

  const refusals: [
    string,
    (o: Owner, u: Unit) => void,
    (o: Owner) => unknown,
  ][] = [
    ["map set", (o, u) => o.items.set("k", u), (o) => [...o.items.keys()]],
    ["set add", (o, u) => o.pool.add(u), (o) => [...o.pool]],
    ["array push", (o, u) => o.list.push(unit(1), u), (o) => [...o.list]],
    ["array unshift", (o, u) => o.list.unshift(u), (o) => [...o.list]],
    ["array splice", (o, u) => o.list.splice(0, 1, u), (o) => [...o.list]],
    ["array set-at-index", (o, u) => o.list.set(0, u), (o) => [...o.list]],
  ]
  for (const [kind, add, contents] of refusals) {
    test(`${kind} refuses it and leaves the collection unchanged`, () => {
      const peer = owner()
      peer.server.list.push(unit(4))
      peer.sync()
      const before = contents(peer.server)
      const nested = peer.server.nested
      const logged = capturingErrors(() => add(peer.server, nested))
      expect(contents(peer.server)).toEqual(before)
      expect(nested._parent).toBe(peer.server)
      expect(nested._parentField).toBeUndefined()
      expect(logged.length).toBe(1)
      expect(logged[0]).toMatch(/Owner\.(items|pool|list)/)
      expect(logged[0]).toContain("held by the nested field Owner.nested")
      expect(logged[0]).toContain("first assign something else")
      expect(peer.sync()).toEqual([])
      peer.expectInSync()
    })
  }

  test("a collection can't hold its own owner (a cycle)", () => {
    const peer = owner()
    const box = new Box()
    peer.server.boxes.set("b", box)
    peer.sync()
    const units = box.units as unknown as { push(...items: Schema[]): number }
    const logged = capturingErrors(() => {
      units.push(box)
      units.push(peer.server)
    })
    expect(logged.length).toBe(2)
    expect(logged[0]).toContain("hold itself")
    expect(box.units.length).toBe(0)
    expect(peer.sync()).toEqual([])
  })

  test("clearing the field first, then adding it, moves it in one tick", () => {
    const peer = owner()
    const a = peer.server.nested
    a.v.set(1)
    peer.sync()
    const logged = capturingErrors(() => {
      peer.server.nested = unit(2)
      peer.server.items.set("k", a)
    })
    expect(logged).toEqual([])
    peer.sync()
    for (const key of ["x", "y", "z"]) peer.server.items.set(key, unit(3))
    peer.sync()
    a.v.set(9)
    peer.sync()
    expect(peer.client.items.get("k")?.v.get()).toBe(9)
    expect(peer.client.nested.v.get()).toBe(2)
    peer.expectInSync()
  })

  test("an element added before its collection was initialized is reported", () => {
    const peer = owner()
    const box = new Box() // not initialized: its array can't check anything
    const gem = unit(3)
    box.units.push(gem)
    const logged = capturingErrors(() => {
      peer.server.nested = gem // allowed: gem has no parent yet
      peer.server.boxes.set("b", box)
    })
    expect(peer.server.nested).toBe(gem)
    expect(logged.length).toBe(1)
    expect(logged[0]).toContain("Box.units")
    expect(logged[0]).toContain("nested field Owner.nested")
  })

  test("a nested value assigned before init, held elsewhere, is reported", () => {
    const peer = owner()
    const shared = unit(3)
    peer.server.items.set("k", shared)
    peer.sync()
    const slot = new Slot() // not initialized: plain field, no setter yet
    slot.nested = shared
    const logged = capturingErrors(() => {
      peer.server.slots.set("s", slot)
    })
    expect(logged.length).toBe(1)
    expect(logged[0]).toContain("Slot.nested")
    expect(logged[0]).toContain("held by Owner.items")
  })
})

describe("collections may share an instance", () => {
  // Removing it from the collection that attached it last used to drop it
  // from the tree: its refId was freed while the other still held it.
  for (const removeFrom of ["items", "list"] as const) {
    test(`removing it from ${removeFrom} keeps it live in the other`, () => {
      const peer = owner()
      const shared = unit(1)
      peer.server.items.set("k", shared)
      peer.server.list.push(shared)
      peer.sync()
      expect(peer.client.items.get("k")).toBe(peer.client.list.at(0))
      const ref = shared._wireRef

      if (removeFrom === "items") peer.server.items.delete("k")
      else peer.server.list.pop()
      peer.sync()
      expect(shared._wireRef).toBe(ref)
      for (const key of ["x", "y", "z"]) peer.server.items.set(key, unit(2))
      peer.sync()
      shared.v.set(9)
      peer.sync()
      const held =
        removeFrom === "items"
          ? peer.client.list.at(0)
          : peer.client.items.get("k")
      expect(held?.v.get()).toBe(9)
      peer.expectInSync()
    })
  }

  test("a shared instance leaves the wire only when its last holder goes", () => {
    const peer = owner()
    const shared = unit(1)
    peer.server.items.set("k", shared)
    peer.server.pool.add(shared)
    peer.server.list.push(shared)
    peer.sync()
    peer.server.list.clear()
    peer.server.items.delete("k")
    peer.sync()
    expect(shared._wireRef).not.toBe(-1)
    peer.server.pool.delete(shared)
    peer.sync()
    expect(shared._wireRef).toBe(-1)
    peer.server.items.set("back", shared)
    peer.sync()
    peer.expectInSync()
  })

  test("a holder removed from the tree doesn't take a shared element along", () => {
    const peer = owner()
    const box = new Box()
    const shared = unit(1)
    peer.server.items.set("k", shared)
    peer.server.boxes.set("b", box)
    box.units.push(shared) // attached last: the box is its parent
    peer.sync()
    peer.server.boxes.delete("b")
    peer.sync()
    shared.v.set(5)
    for (const key of ["x", "y"]) peer.server.items.set(key, unit(2))
    peer.sync()
    expect(peer.client.items.get("k")?.v.get()).toBe(5)
    peer.expectInSync()
  })
})

describe("a nested field's SET always introduces a new instance", () => {
  // Receivers rebind their own nested object to the ref and reset it, so
  // the full content must follow even if the value has a refId already.
  test("placed by an earlier op in the same frame (array push, then pop)", () => {
    const peer = owner()
    const slot = new Slot()
    peer.server.slots.set("s", slot)
    peer.sync()
    const x = unit(7)
    // The root's array ops are emitted before the slot is visited.
    peer.server.list.push(x)
    peer.server.list.pop()
    slot.nested = x
    peer.sync()
    expect(peer.client.slots.get("s")?.nested.v.get()).toBe(7)
    peer.expectInSync()
    x.v.set(8)
    peer.sync()
    expect(peer.client.slots.get("s")?.nested.v.get()).toBe(8)
    peer.expectInSync()
  })

  // Out of a collection, through a nested field (which sends it anew), and
  // back to the same set / map key, all in one tick: coalescing must still
  // replace the old identity receivers hold there.
  for (const kind of ["set", "map"] as const) {
    test(`back into the same ${kind} after passing through a nested field`, () => {
      const peer = owner()
      const x = unit(7)
      if (kind === "set") peer.server.pool.add(x)
      else peer.server.items.set("k", x)
      peer.sync()
      if (kind === "set") peer.server.pool.delete(x)
      else peer.server.items.delete("k")
      peer.server.nested = x
      peer.server.nested = unit(1)
      if (kind === "set") peer.server.pool.add(x)
      else peer.server.items.set("k", x)
      peer.sync()
      peer.expectInSync()
      x.v.set(9)
      peer.sync()
      const held =
        kind === "set" ? [...peer.client.pool][0] : peer.client.items.get("k")
      expect(held?.v.get()).toBe(9)
      peer.expectInSync()
    })
  }

  test("known, removed, put in a detached holder that is attached", () => {
    const peer = owner()
    const x = unit(7)
    peer.server.list.push(x)
    peer.sync()
    const slot = Schema.create(Slot) // initialized, but not on the wire
    peer.server.list.pop()
    slot.nested = x
    peer.server.slots.set("s", slot)
    peer.sync()
    expect(peer.client.slots.get("s")?.nested.v.get()).toBe(7)
    peer.expectInSync()
  })
})
