import { describe, expect, test } from "bun:test"
import type { WireOp } from "@bungohan/types"
import { applyDelta } from "./decoder"
import {
  clearChangeTrees,
  encodeSnapshot,
  generateDeltas,
  getSchemaTable,
} from "./encoder"
import { createNumber, createSchemaMap, createString } from "./factories"
import { Schema } from "./schema"
import {
  GameRoom,
  type Item,
  item,
  Peer,
  type Player,
  player,
  type Vec,
} from "./test-fixtures"

function joined(setup?: (room: GameRoom) => void): Peer<GameRoom> {
  const server = new GameRoom()
  setup?.(server)
  const peer = new Peer(server, new GameRoom())
  peer.join()
  return peer
}

function nonDefine(ops: WireOp[]): WireOp[] {
  return ops.filter((op) => op[0] !== 4)
}

describe("snapshot", () => {
  test("reproduces the whole tree on a fresh client", () => {
    const peer = joined((room) => {
      room.tick.set(7)
      room.title.set("arena")
      const a = player("alice", 1.5)
      a.pos.x.set(3)
      a.items.push(item("sword"), item("potion", 3))
      a.tags.add("admin")
      a.scores.set("kills", 2)
      a.hp.set(0) // zero on the server, 100 in the initializer
      room.players.set("a", a)
      room.log.push("start")
      room.bag.add(item("gem"))
    })
    peer.expectInSync()
    expect(peer.client.players.get("a")?.hp.get()).toBe(0)
  })

  test("leads with DEFINE ops for the class table, root first", () => {
    const server = new GameRoom()
    server.players.set("a", player("a"))
    const snapshot = encodeSnapshot(server).unwrap()
    const defines = snapshot.filter((op) => op[0] === 4)
    expect(snapshot.slice(0, defines.length)).toEqual(defines)
    expect(defines.map((op) => op[2])).toEqual([
      "T.GameRoom",
      "T.Player",
      "T.Vec",
    ])
    expect(defines[0]).toEqual([
      4,
      0,
      "T.GameRoom",
      ["tick", "title", "speed", "players", "log", "bag"],
      ["float64", "string", "float32", "schemaMap", "array", "schemaSet"],
    ])
    expect(getSchemaTable(server).classes.map((c) => c.name)).toEqual([
      "T.GameRoom",
      "T.Player",
      "T.Vec",
    ])
  })

  test("omits zero values and allocates collection refs implicitly", () => {
    const server = new GameRoom()
    const ops = nonDefine(encodeSnapshot(server).unwrap())
    // An all-default room is just its refIds: nothing to send.
    expect(ops).toEqual([])
  })

  test("is refused while changes are pending", () => {
    const peer = joined()
    peer.server.tick.set(1)
    const result = encodeSnapshot(peer.server)
    expect(result.isErr() && result.error.code).toBe("SNAPSHOT_DIRTY")
    peer.sync()
    expect(encodeSnapshot(peer.server).isOk()).toBe(true)
  })

  test("a late joiner matches an evolved room", () => {
    const peer = joined()
    peer.server.players.set("a", player("a", 1))
    peer.sync()
    peer.server.players.get("a")?.items.push(item("x"))
    peer.server.players.set("b", player("b", 2))
    peer.sync()

    const late = new Peer(peer.server, new GameRoom())
    late.join()
    late.expectInSync()
    // ...and both keep receiving the same deltas.
    peer.server.players.get("b")?.x.set(9)
    const ops = generateDeltas(peer.server)
    expect(applyDelta(peer.client, ops).isOk()).toBe(true)
    expect(applyDelta(late.client, ops).isOk()).toBe(true)
    clearChangeTrees(peer.server)
    peer.expectInSync()
    late.expectInSync()
  })

  test("state mutated before the first snapshot is still sent", () => {
    const room = new GameRoom() // never initialized explicitly
    room.tick.set(3)
    room.players.set("p", player("p"))
    room.players.get("p")?.pos.y.set(4)
    const peer = new Peer(room, new GameRoom())
    peer.join()
    peer.expectInSync()
  })
})

describe("deltas", () => {
  test("idle ticks emit nothing", () => {
    const peer = joined((room) => room.players.set("a", player("a")))
    expect(peer.sync()).toEqual([])
    expect(generateDeltas(new GameRoom())).toEqual([]) // never snapshotted
  })

  test("a primitive change is a single positional SET", () => {
    const peer = joined()
    peer.server.tick.set(5)
    expect(peer.sync()).toEqual([[0, 0, 0, 5]])
  })

  test("last write wins within a tick", () => {
    const peer = joined()
    peer.server.title.set("a")
    peer.server.title.set("b")
    expect(peer.sync()).toEqual([[0, 0, 1, "b"]])
  })

  test("nested changes target the nested refId, never re-embed", () => {
    const peer = joined((room) => room.players.set("a", player("a")))
    const a = peer.server.players.get("a")
    a?.pos.x.set(12)
    const ops = peer.sync()
    expect(ops).toHaveLength(1)
    const [op] = ops
    expect(op?.[0]).toBe(0)
    expect(op?.[1]).toBe(a?.pos._wireRef)
    expect(op?.[2]).toBe(0)
    expect(op?.[3]).toBe(12)
    peer.expectInSync()
  })

  test("fixed-point: sends the scaled int, only when it changes", () => {
    const peer = joined((room) => room.players.set("a", player("a")))
    const a = peer.server.players.get("a") as Player
    a.x.set(145.5)
    expect(peer.sync()).toEqual([[0, a._wireRef, 1, 14550]])
    a.x.set(145.501) // same wire value
    expect(peer.sync()).toEqual([])
    a.x.set(145.504)
    a.x.set(145.506) // crosses to 14551
    expect(peer.sync()).toEqual([[0, a._wireRef, 1, 14551]])
    expect(peer.client.players.get("a")?.x.get()).toBe(145.51)
  })

  test("float32 sends the rounded value", () => {
    const peer = joined()
    peer.server.speed.set(0.1)
    expect(peer.sync()).toEqual([[0, 0, 2, Math.fround(0.1)]])
    expect(peer.client.speed.get()).toBe(Math.fround(0.1))
  })

  test("map of schemas: add, change, replace, remove, clear", () => {
    const peer = joined()
    const { server } = peer
    server.players.set("a", player("a", 1))
    server.players.set("b", player("b", 2))
    peer.sync()
    peer.expectInSync()

    server.players.get("a")?.name.set("alice")
    server.players.set("b", player("bob", 3)) // replace
    peer.sync()
    peer.expectInSync()

    server.players.delete("a")
    peer.sync()
    peer.expectInSync()

    server.players.clear()
    server.players.set("c", player("c"))
    peer.sync()
    peer.expectInSync()
  })

  test("map ops are coalesced per key", () => {
    const peer = joined()
    const { server } = peer
    server.players.set("tmp", player("tmp"))
    server.players.delete("tmp") // added and removed: nothing to send
    expect(peer.sync()).toEqual([])

    const a = player("a")
    server.players.set("a", a)
    peer.sync()
    server.players.delete("a")
    server.players.set("a", a) // back to where it started
    expect(peer.sync()).toEqual([])
  })

  test("primitive map, set and array fields", () => {
    const peer = joined((room) => room.players.set("a", player("a")))
    const a = peer.server.players.get("a") as Player
    a.scores.set("kills", 1)
    a.scores.set("deaths", 2)
    a.tags.add("x").add("y")
    peer.server.log.push("one", "two", "three")
    peer.sync()
    peer.expectInSync()

    a.scores.delete("kills")
    a.scores.set("deaths", 3)
    a.tags.delete("x")
    peer.server.log.splice(1, 1, "TWO", "2.5")
    peer.server.log.unshift("zero")
    peer.sync()
    peer.expectInSync()

    peer.server.log.sort()
    peer.server.log.reverse()
    peer.server.log.set(0, "first")
    a.tags.clear()
    peer.sync()
    peer.expectInSync()
  })

  test("set ADD uses the 3-element form", () => {
    const peer = joined((room) => room.players.set("a", player("a")))
    const a = peer.server.players.get("a") as Player
    a.tags.add("vip")
    expect(peer.sync()).toEqual([[1, a.tags._wireRef, "vip"]])
    a.tags.delete("vip")
    expect(peer.sync()).toEqual([[2, a.tags._wireRef, "vip"]])
  })

  test("array of schemas: insert, remove, replace, reorder", () => {
    const peer = joined((room) => room.players.set("a", player("a")))
    const items = (peer.server.players.get("a") as Player).items
    items.push(item("a"), item("b"), item("c"))
    peer.sync()
    peer.expectInSync()

    items.shift()
    items.splice(1, 0, item("d"))
    items.set(0, item("e"))
    peer.sync()
    peer.expectInSync()

    items.reverse()
    items.sort((x, y) => (x.name.get() < y.name.get() ? -1 : 1))
    peer.sync()
    peer.expectInSync()

    items.pop()
    items.at(0)?.qty.set(99)
    peer.sync()
    peer.expectInSync()

    items.clear()
    items.push(item("z"))
    peer.sync()
    peer.expectInSync()
  })

  test("set of schemas", () => {
    const peer = joined()
    const gem = item("gem")
    peer.server.bag.add(gem).add(item("coin"))
    peer.sync()
    peer.expectInSync()
    gem.qty.set(5)
    peer.sync()
    peer.expectInSync()
    peer.server.bag.delete(gem)
    peer.sync()
    peer.expectInSync()
  })

  test("a new instance is sent in full once, then only diffs", () => {
    const peer = joined()
    const a = player("a", 1)
    a.items.push(item("sword"))
    peer.server.players.set("a", a)
    const first = peer.sync()
    expect(first.length).toBeGreaterThan(3)
    a.items.at(0)?.qty.set(2)
    expect(peer.sync()).toHaveLength(1)
    peer.expectInSync()
  })

  test("moving an instance between collections keeps it", () => {
    const peer = joined((room) => {
      const a = player("a")
      a.items.push(item("sword"))
      room.players.set("a", a)
      room.players.set("b", player("b"))
    })
    const a = peer.server.players.get("a") as Player
    const b = peer.server.players.get("b") as Player
    const sword = a.items.at(0) as Item
    const clientSword = peer.client.players.get("a")?.items.at(0)

    a.items.shift()
    b.items.push(sword)
    sword.qty.set(7)
    peer.sync()
    peer.expectInSync()
    // Same client object, moved — not recreated.
    expect(peer.client.players.get("b")?.items.at(0)).toBe(clientSword)
  })

  test("a removed instance re-added later is resent in full", () => {
    const peer = joined()
    const a = player("a", 1)
    a.items.push(item("sword"))
    peer.server.players.set("a", a)
    peer.sync()

    peer.server.players.delete("a")
    peer.sync()
    expect(a._wireRef).toBe(-1) // forgotten
    a.x.set(2) // mutated while detached: not tracked, not needed

    peer.server.players.set("again", a)
    const ops = peer.sync()
    // Full content again (placement + name + x + pos + item...), not a ref.
    expect(ops.length).toBeGreaterThan(3)
    peer.expectInSync()
  })

  test("freed refIds are reused by the same class, from the next tick", () => {
    const peer = joined()
    const a = player("a")
    a.items.push(item("sword"))
    peer.server.players.set("a", a)
    peer.sync()
    const playerRef = a._wireRef
    const itemRef = a.items.at(0)?._wireRef

    // Removal tick: nothing new may take the freed blocks in this frame.
    peer.server.players.delete("a")
    const b = player("b")
    peer.server.players.set("b", b)
    peer.sync()
    expect(b._wireRef).not.toBe(playerRef)

    // Next tick: the freed Player block (ref R, items at R+1) and Item block
    // are handed out again, to instances of the same class.
    const c = player("c")
    c.items.push(item("shield"))
    peer.server.players.set("c", c)
    peer.sync()
    expect(c._wireRef).toBe(playerRef)
    expect(c.items._wireRef).toBe(playerRef + 1)
    expect(c.items.at(0)?._wireRef).toBe(itemRef)
    peer.expectInSync()

    // The client built a fresh object for the reused refId.
    peer.server.players.get("c")?.name.set("carol")
    peer.sync()
    expect(peer.client.players.get("c")?.name.get()).toBe("carol")
    expect(peer.client.players.get("b")?.name.get()).toBe("b")
  })

  test("the receiver drops removed instances (and their subtree)", () => {
    const peer = joined((room) => room.players.set("a", player("a")))
    const a = peer.server.players.get("a") as Player
    const posRef = a.pos._wireRef
    peer.server.players.delete("a")
    peer.sync()
    const stale = applyDelta(peer.client, [[0, posRef, 0, 1]])
    expect(stale.isErr() && stale.error.code).toBe("UNKNOWN_REF")
  })

  test("a class first used after join is DEFINEd inline, before use", () => {
    class Late extends Schema {
      public static override schemaName = "T.Late"
      public v = createNumber()
    }
    class LateRoom extends Schema {
      public static override schemaName = "T.LateRoom"
      public things = createSchemaMap<string, Late>()
    }
    const peer = new Peer(new LateRoom(), new LateRoom())
    peer.join()
    const late = new Late()
    late.v.set(1)
    peer.server.things.set("x", late)
    const ops = peer.sync()
    expect(ops[0]).toEqual([4, 1, "T.Late", ["v"], ["float64"]])
    expect(ops[1]).toEqual([1, 1, "x", [1, late._wireRef]])
    expect(peer.client.things.get("x")?.v.get()).toBe(1)
  })
})

describe("receiver listeners", () => {
  test("fire after the frame, with populated instances", () => {
    const peer = joined()
    const seen: unknown[] = []
    peer.client.players.onAdd((p, key) => {
      seen.push(["add", key, p.name.get(), p.items.length, p.pos.x.get()])
    })
    peer.client.tick.onChange((v, old) => seen.push(["tick", v, old]))

    const a = player("alice")
    a.items.push(item("sword"))
    a.pos.x.set(4)
    peer.server.players.set("a", a)
    peer.server.tick.set(1)
    peer.sync()
    // Op order: an instance's primitive fields precede its collections.
    expect(seen).toEqual([
      ["tick", 1, 0],
      ["add", "a", "alice", 1, 4],
    ])
  })

  test("instances created this frame fire none of their own listeners", () => {
    const peer = joined()
    const fired: string[] = []
    peer.client.players.onAdd((p) => {
      p.name.onChange(() => fired.push("name"))
      p.items.onAdd(() => fired.push("item"))
    })
    const a = player("a")
    a.items.push(item("x"))
    peer.server.players.set("a", a)
    peer.sync()
    expect(fired).toEqual([])

    a.name.set("b")
    a.items.push(item("y"))
    peer.sync()
    expect(fired).toEqual(["name", "item"])
  })

  test("onRemove and onChange on collections", () => {
    const peer = joined((room) => {
      room.players.set("a", player("a"))
      room.log.push("x")
    })
    const events: unknown[] = []
    peer.client.players.onRemove((p, key) =>
      events.push(["rm", key, p.name.get()]),
    )
    peer.client.log.onChange((v, old, i) => events.push(["log", i, old, v]))
    peer.server.players.delete("a")
    peer.server.log.set(0, "y")
    peer.sync()
    expect(events).toEqual([
      ["rm", "a", "a"],
      ["log", 0, "x", "y"],
    ])
  })

  test("the snapshot fires listeners on the root", () => {
    const server = new GameRoom()
    server.players.set("a", player("a"))
    server.tick.set(2)
    const client = new GameRoom()
    const events: unknown[] = []
    client.players.onAdd((_p, key) => events.push(key))
    client.tick.onChange((v) => events.push(v))
    new Peer(server, client).join()
    expect(events).toEqual([2, "a"])
  })

  test("a throwing listener does not break the frame", () => {
    const peer = joined()
    peer.client.tick.onChange(() => {
      throw new Error("user bug")
    })
    const original = console.error
    console.error = () => {}
    try {
      peer.server.tick.set(1)
      peer.server.title.set("t")
      peer.sync()
    } finally {
      console.error = original
    }
    peer.expectInSync()
  })
})

describe("receiver robustness", () => {
  class Ghostly extends Schema {
    public static override schemaName = "T.Ghostly"
    public known = createString()
    public others = createSchemaMap<string, Vec>()
  }

  function ghostPeer(): Ghostly {
    const client = new Ghostly()
    const ops: WireOp[] = [
      [
        4,
        0,
        "T.Ghostly",
        ["extra", "known", "others", "extraMap"],
        ["float64", "string", "schemaMap", "map"],
      ],
      [4, 1, "T.NeverRegistered", ["v", "list"], ["float64", "array"]],
    ]
    expect(applyDelta(client, ops).isOk()).toBe(true)
    return client
  }

  test("fields the client doesn't have are skipped, refs stay aligned", () => {
    const client = ghostPeer()
    // root = 0; collections: others = 1, extraMap = 2
    const result = applyDelta(client, [
      [0, 0, 0, 5], // unknown field "extra"
      [0, 0, 1, "hi"],
      [1, 2, "k", 1], // into the unknown "extraMap"
    ])
    expect(result.isOk()).toBe(true)
    expect(client.known.get()).toBe("hi")
  })

  test("instances of unknown classes are ignored, with their refs", () => {
    const client = ghostPeer()
    const result = applyDelta(client, [
      [1, 1, "ghost", [1, 10]], // class 1 has no local constructor
      [0, 10, 0, 3], // its field
      [1, 11, 0, 7], // its collection (ref 11)
    ])
    expect(result.isOk()).toBe(true)
    expect(client.others.size).toBe(0)
  })

  test("a reused refId that was ignored before is honored", () => {
    const client = ghostPeer()
    // A known class (Vec), first placed in the unknown "extraMap" (ref 2):
    // ref 20 gets marked ignored along with its ignored parent.
    const first = applyDelta(client, [
      [4, 2, "T.Vec", ["x", "y"], ["float64", "float64"]],
      [1, 2, "k", [2, 20]],
      [0, 20, 0, 1],
    ])
    expect(first.isOk()).toBe(true)
    // Later the server frees ref 20 and reuses it for a Vec in a known map.
    const reused = applyDelta(client, [
      [2, 2, "k"],
      [1, 1, "v", [2, 20]],
      [0, 20, 0, 5],
    ])
    expect(reused.isOk()).toBe(true)
    expect(client.others.get("v")?.x.get()).toBe(5)
  })

  test("type disagreements are reported, not guessed", () => {
    const client = new Ghostly()
    const result = applyDelta(client, [
      [4, 0, "T.Ghostly", ["known"], ["float64"]],
    ])
    expect(result.isErr() && result.error.code).toBe("SCHEMA_MISMATCH")
  })

  test("malformed ops are rejected", () => {
    const client = ghostPeer()
    const bad: unknown[] = [
      ["x"],
      [9, 0],
      [0, 0, 1, 42], // number into a string field
      [1, 1, "k", "not-a-ref"],
      [2, 1],
    ]
    for (const op of bad) {
      const result = applyDelta(client, [op as WireOp])
      expect(result.isErr() && result.error.code).toBe("MALFORMED_OP")
    }
    const unknown = applyDelta(client, [[0, 999, 0, 1]])
    expect(unknown.isErr() && unknown.error.code).toBe("UNKNOWN_REF")
  })
})
