import { describe, expect, test } from "bun:test"
import { f, type WireOp } from "@bungohan/types"
import { applyDelta } from "./decoder"
import { clearChangeTrees, encodeSnapshot, generateDeltas } from "./encoder"
import {
  createFiltered,
  createNumber,
  createSchemaMap,
  createString,
} from "./factories"
import { Schema } from "./schema"
import { Item, item, plain } from "./test-fixtures"

interface TestClient {
  readonly id: string
}

class Hand extends Schema {
  public static override schemaName = "T.Hand"
  public ownerId = createString()
  public count = createNumber()
  /** Only the owner sees the cards. */
  public cards = createFiltered(
    createSchemaMap(f.string, Item),
    function (this: Hand, client: TestClient) {
      return this.ownerId.get() === client.id
    },
  )
  /** Arrow form: `this` is the instance, captured lexically. */
  public secret = createFiltered(
    createString(),
    (client: TestClient) => this.ownerId.get() === client.id,
  )
}

class Table extends Schema {
  public static override schemaName = "T.Table"
  public round = createNumber()
  public hands = createSchemaMap(f.string, Hand)
}

function hand(owner: string): Hand {
  const h = new Hand()
  h.ownerId.set(owner)
  h.secret.set(`${owner}-secret`)
  h.cards.set("c1", item(`${owner}-card`))
  return h
}

/** A server plus one replica per client, synced with per-client deltas. */
class Room {
  public readonly server = new Table()
  public readonly clients = new Map<TestClient, Table>()

  public join(id: string): Table {
    const client = { id }
    const replica = new Table()
    const ops = encodeSnapshot(this.server, client).unwrap()
    expect(applyDelta(replica, ops).isOk()).toBe(true)
    this.clients.set(client, replica)
    return replica
  }

  public sync(): Map<TestClient, WireOp[]> {
    const perClient = generateDeltas(this.server, this.clients.keys())
    for (const [client, replica] of this.clients) {
      const ops = perClient.get(client) ?? []
      const applied = applyDelta(replica, ops)
      if (applied.isErr()) throw applied.error
    }
    clearChangeTrees(this.server)
    return perClient
  }
}

function cardsOf(table: Table, owner: string): string[] {
  const h = table.hands.get(owner)
  return h === undefined ? [] : [...h.cards.values()].map((c) => c.name.get())
}

describe("createFiltered (spec §5.6)", () => {
  test("returns the same wrapper, marked as filtered", () => {
    const inner = createString()
    expect(createFiltered(inner, () => true)).toBe(inner)
    expect(inner._filter).toBeDefined()
  })

  test("snapshots include filtered fields only for passing clients", () => {
    const room = new Room()
    room.server.hands.set("alice", hand("alice"))
    room.server.hands.set("bob", hand("bob"))
    const alice = room.join("alice")
    const bob = room.join("bob")

    expect(cardsOf(alice, "alice")).toEqual(["alice-card"])
    expect(cardsOf(alice, "bob")).toEqual([])
    expect(alice.hands.get("alice")?.secret.get()).toBe("alice-secret")
    expect(alice.hands.get("bob")?.secret.get()).toBe("")
    expect(cardsOf(bob, "bob")).toEqual(["bob-card"])
    // Unfiltered fields reach everyone.
    expect(bob.hands.get("alice")?.ownerId.get()).toBe("alice")
  })

  test("a snapshot without a client omits every filtered field", () => {
    const server = new Table()
    server.hands.set("a", hand("a"))
    const replica = new Table()
    applyDelta(replica, encodeSnapshot(server).unwrap())
    expect(cardsOf(replica, "a")).toEqual([])
    expect(replica.hands.get("a")?.secret.get()).toBe("")
  })

  test("deltas are per client; unfiltered ops are shared", () => {
    const room = new Room()
    room.server.hands.set("alice", hand("alice"))
    room.server.hands.set("bob", hand("bob"))
    const alice = room.join("alice")
    const bob = room.join("bob")

    room.server.round.set(1)
    const shared = room.sync()
    const [a, b] = [...shared.values()]
    expect(a).toBe(b) // same array instance: encode once

    room.server.hands.get("alice")?.cards.set("c2", item("ace"))
    room.server.hands.get("alice")?.secret.set("new")
    room.sync()
    expect(cardsOf(alice, "alice")).toEqual(["alice-card", "ace"])
    expect(cardsOf(bob, "alice")).toEqual([])
    expect(alice.hands.get("alice")?.secret.get()).toBe("new")
    expect(bob.hands.get("alice")?.secret.get()).toBe("")

    // Changes inside a filtered subtree are filtered too.
    room.server.hands.get("alice")?.cards.get("c2")?.qty.set(4)
    const perClient = room.sync()
    const bobOps = [...perClient].find(([c]) => c.id === "bob")?.[1]
    expect(bobOps).toEqual([])
    expect(alice.hands.get("alice")?.cards.get("c2")?.qty.get()).toBe(4)
  })

  test("clients with the same visibility share one array", () => {
    const room = new Room()
    room.server.hands.set("alice", hand("alice"))
    room.join("alice")
    room.join("bob")
    room.join("carol")
    room.server.hands.get("alice")?.secret.set("x")
    const perClient = room.sync()
    const byId = new Map([...perClient].map(([c, ops]) => [c.id, ops]))
    expect(byId.get("bob")).toBe(byId.get("carol"))
    expect(byId.get("alice")).not.toBe(byId.get("bob"))
  })

  test("visibility changes reveal and hide the current value", () => {
    const room = new Room()
    room.server.hands.set("h", hand("alice"))
    const alice = room.join("alice")
    const bob = room.join("bob")

    // Ownership moves to bob: bob gets the full value, alice loses it.
    room.server.hands.get("h")?.ownerId.set("bob")
    room.sync()
    expect(cardsOf(bob, "h")).toEqual(["alice-card"])
    expect(bob.hands.get("h")?.secret.get()).toBe("alice-secret")
    expect(cardsOf(alice, "h")).toEqual([])
    expect(alice.hands.get("h")?.secret.get()).toBe("")

    // And back again.
    room.server.hands.get("h")?.ownerId.set("alice")
    room.sync()
    expect(cardsOf(alice, "h")).toEqual(["alice-card"])
    expect(cardsOf(bob, "h")).toEqual([])
  })

  test("new instances with filtered fields, added after join", () => {
    const room = new Room()
    const alice = room.join("alice")
    const bob = room.join("bob")
    room.server.hands.set("alice", hand("alice"))
    room.sync()
    expect(cardsOf(alice, "alice")).toEqual(["alice-card"])
    expect(cardsOf(bob, "alice")).toEqual([])
    expect(plain(bob.hands.get("alice")?.ownerId)).toBe("alice")
  })

  test("without clients, filtered ops are withheld", () => {
    const room = new Room()
    room.server.hands.set("a", hand("a"))
    room.join("a")
    room.server.hands.get("a")?.secret.set("s2")
    room.server.round.set(3)
    const ops = generateDeltas(room.server)
    expect(ops).toEqual([[0, 0, 0, 3]])
  })

  test("a throwing filter hides the field", () => {
    class Risky extends Schema {
      public static override schemaName = "T.Risky"
      public v = createFiltered(createNumber(1), () => {
        throw new Error("bug")
      })
    }
    const original = console.error
    console.error = () => {}
    try {
      const replica = new Risky()
      applyDelta(replica, encodeSnapshot(new Risky(), { id: "x" }).unwrap())
      expect(replica.v.get()).toBe(0)
    } finally {
      console.error = original
    }
  })
})
