import { describe, expect, test } from "bun:test"
import { f } from "@bungohan/types"
import { encodeSnapshot } from "./encoder"
import {
  createMap,
  createNumber,
  createSchemaArray,
  createSchemaMap,
  createString,
} from "./factories"
import { fromPlain, toPlain } from "./plain"
import { Schema } from "./schema"
import { SchemaRegistry } from "./schema-registry"
import { GameRoom, Item, Player } from "./test-fixtures"
import { validateSchemaClass } from "./validate"

describe("validateSchemaClass", () => {
  test("a well-formed tree has no problems", () => {
    expect(validateSchemaClass(GameRoom)).toEqual([])
  })

  test("walks nested fields and element classes, reports each problem", () => {
    class NoName extends Schema {
      public v = createNumber()
    }
    class Dup extends Schema {
      public static override schemaName = "V.Dup"
    }
    class Dup2 extends Schema {
      public static override schemaName = "V.Dup"
    }
    class Deep extends Schema {
      public static override schemaName = "V.Deep"
      // A descriptor that got past the types.
      public bad = createMap(f.string, f.int8 as unknown as typeof f.float64)
      public dup = new Dup2()
    }
    class Root extends Schema {
      public static override schemaName = "V.Root"
      public nested = new NoName()
      public list = createSchemaArray(Deep)
      public dups = createSchemaMap(f.string, Dup)
      public notSchema = createSchemaArray(Date as unknown as typeof Deep)
      public plain = 1 // ignored: not a field wrapper
    }
    expect(validateSchemaClass(Root)).toEqual([
      expect.stringMatching(/^Root\.notSchema: element class .*Date.* is not/),
      "NoName: missing its own static schemaName " +
        '(add `public static override schemaName = "…"`)',
      'Deep.bad: invalid map value descriptor {"kind":"int8"}',
      'Dup2: schemaName "V.Dup" is also used by Dup',
    ])
  })

  test("a throwing constructor is reported, not thrown", () => {
    class Boom extends Schema {
      public static override schemaName = "V.Boom"
      public constructor() {
        super()
        throw new Error("nope")
      }
    }
    expect(validateSchemaClass(Boom)).toEqual([
      "Boom: constructor threw: Error: nope",
    ])
  })
})

describe("toPlain / fromPlain", () => {
  test("round-trips a tree with full precision and subclass elements", () => {
    class Special extends Item {
      public static override schemaName = "V.Special"
      public power = createNumber()
    }
    SchemaRegistry.register(Special)
    const room = new GameRoom()
    room.tick.set(42)
    room.title.set("hi")
    const p = new Player()
    p.x.set(1.23456) // fixed:2 on the wire; full precision here
    p.pos.y.set(-3)
    p.tags.add("a")
    p.scores.set("k", 2.5)
    const special = new Special()
    special.power.set(9)
    p.items.push(special)
    room.players.set("p1", p)
    room.log.push("one", "two")

    const plain = JSON.parse(JSON.stringify(toPlain(room)))
    const back = fromPlain(GameRoom, plain).unwrap()
    expect(toPlain(back)).toEqual(plain)
    const player = back.players.get("p1")
    expect(player?.x.get()).toBe(1.23456)
    expect(player?.items.at(0)).toBeInstanceOf(Special)
    // The rebuilt tree syncs like any other.
    expect(encodeSnapshot(back).isOk()).toBe(true)
  })

  test("bad data is INVALID_DATA with a path", () => {
    const result = fromPlain(GameRoom, { tick: "x" })
    expect(result.isErr() && result.error.code).toBe("INVALID_DATA")
    expect(result.isErr() && result.error.message).toBe(
      "GameRoom.tick: expected a number",
    )
    const bad = fromPlain(GameRoom, { players: [["p", { hp: true }]] })
    expect(bad.isErr() && bad.error.message).toBe(
      "GameRoom.players[0].hp: expected a number",
    )
    expect(fromPlain(GameRoom, null).isErr()).toBe(true)
  })

  test("missing fields keep initializers; unknown fields are ignored", () => {
    class S extends Schema {
      public static override schemaName = "V.S"
      public a = createString("init")
      public b = createNumber(5)
    }
    const s = fromPlain(S, { b: 7, extra: 1 }).unwrap()
    expect(s.a.get()).toBe("init")
    expect(s.b.get()).toBe(7)
  })
})
