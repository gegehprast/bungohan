import { describe, expect, test } from "bun:test"
import { f } from "@bungohan/types"
import { createNumber, createSchemaMap, createString } from "./factories"
import { Schema } from "./schema"
import { SchemaRegistry } from "./schema-registry"
import { GameRoom, Player } from "./test-fixtures"

describe("lazy initialization (spec §5.1)", () => {
  test("the base constructor does not initialize", () => {
    const room = new GameRoom()
    expect(room._info).toBeUndefined()
    expect(room.tick._owner).toBeUndefined()
  })

  test("_ensureInit sees subclass fields, in declaration order", () => {
    const info = new Player()._ensureInit()
    expect(info.name).toBe("T.Player")
    expect(info.fields.map((f) => [f.name, f.type])).toEqual([
      ["name", "string"],
      ["x", "fixed:2"],
      ["hp", "float64"],
      ["alive", "bool"],
      ["pos", "schema<T.Vec>"],
      ["items", "schemaArray<T.Item>"],
      ["tags", "set<string>"],
      ["scores", "map<string,fixed:1>"],
    ])
  })

  test("init binds fields and links nested schemas and elements", () => {
    const p = new Player()
    const room = new GameRoom()
    room.players.set("a", p) // before the room is initialized
    expect(p._parent).toBeUndefined()

    room._ensureInit()
    expect(room.tick._owner).toBe(room)
    expect(room.tick._fieldIndex).toBe(0)
    expect(p._parent).toBe(room)
    expect(p._parentField).toBe(room.players)
    expect(p.pos._parent).toBe(p)
    expect(p.pos._tree.parent).toBe(p._tree)
  })

  test("_ensureInit is idempotent and the class table is shared", () => {
    const a = new Player()
    const b = new Player()
    expect(a._ensureInit()).toBe(a._ensureInit())
    expect(a._ensureInit()).toBe(b._ensureInit())
  })

  test("Schema.create initializes eagerly", () => {
    expect(Schema.create(GameRoom)._info).toBeDefined()
  })

  test("instances get unique ids and their own change tree", () => {
    const a = new Player()
    const b = new Player()
    expect(a._id).not.toBe(b._id)
    expect(a._tree.owner).toBe(a)
  })

  test("underscore fields and plain properties are not synchronized", () => {
    class WithExtras extends Schema {
      public static override schemaName = "T.WithExtras"
      public _hidden = createNumber()
      public plainValue = 5
      public shown = createString()
    }
    const fields = new WithExtras()._ensureInit().fields
    expect(fields.map((f) => f.name)).toEqual(["shown"])
  })
})

describe("SchemaRegistry", () => {
  test("classes auto-register on first construction", () => {
    class AutoReg extends Schema {
      public static override schemaName = "T.AutoReg"
      public v = createNumber()
    }
    expect(SchemaRegistry.has("T.AutoReg")).toBe(false)
    new AutoReg()
    expect(SchemaRegistry.get("T.AutoReg")).toBe(AutoReg)
  })

  test("explicit registration, without constructing", () => {
    class Explicit extends Schema {
      public static override schemaName = "T.Explicit"
    }
    SchemaRegistry.register(Explicit)
    expect(SchemaRegistry.get("T.Explicit")).toBe(Explicit)
  })

  test("an inherited schemaName does not count", () => {
    class Base extends Schema {
      public static override schemaName = "T.Base"
      public children = createSchemaMap(f.string, Base)
    }
    class Derived extends Base {}
    SchemaRegistry.register(Derived)
    expect(SchemaRegistry.get("T.Base")).not.toBe(Derived)
  })
})
