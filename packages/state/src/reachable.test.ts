import { describe, expect, test } from "bun:test"
import { f, type WireOp } from "@bungohan/types"
import { applyDelta } from "./decoder"
import { encodeSnapshot } from "./encoder"
import {
  createNumber,
  createSchemaArray,
  createSchemaMap,
  createSchemaSet,
} from "./factories"
import { Schema } from "./schema"
import { reachableSchemaClasses } from "./validate"

class Leaf extends Schema {
  public static override schemaName = "Reach.Leaf"
  public n = createNumber()
}
class Nested extends Schema {
  public static override schemaName = "Reach.Nested"
  public leaf = new Leaf()
}
class Listed extends Schema {
  public static override schemaName = "Reach.Listed"
}
class Kept extends Schema {
  public static override schemaName = "Reach.Kept"
}
class Root extends Schema {
  public static override schemaName = "Reach.Root"
  public nested = new Nested()
  public byId = createSchemaMap(f.string, Listed)
  public set = createSchemaSet(Kept)
  public list = createSchemaArray(Leaf)
}

describe("reachableSchemaClasses", () => {
  test("walks nested fields and collection element classes, once each", () => {
    expect(reachableSchemaClasses(Root)).toEqual([
      Root,
      Nested,
      Listed,
      Kept,
      Leaf,
    ])
  })

  test("skips what it can't instantiate instead of throwing", () => {
    class Broken extends Schema {
      public static override schemaName = "Reach.Broken"
      public constructor() {
        super()
        throw new Error("no")
      }
    }
    class Holder extends Schema {
      public static override schemaName = "Reach.Holder"
      public items = createSchemaMap(f.string, Broken)
    }
    expect(reachableSchemaClasses(Holder)).toEqual([Holder, Broken])
  })
})

describe("applyDelta: unknown classes", () => {
  class Mystery extends Schema {
    public static override schemaName = "Reach.Mystery.Unregistered"
    public n = createNumber()
  }
  class Box extends Schema {
    public static override schemaName = "Reach.Box"
    public things = createSchemaMap(f.string, Leaf)
  }

  /** A snapshot whose element class the receiver has no local class for. */
  function snapshotWithUnknownElement(): WireOp[] {
    const server = new Box()
    const leaf = new Leaf()
    leaf.n.set(1)
    server.things.set("known", leaf)
    const ops = encodeSnapshot(server).unwrap()
    // Rename the element class in its DEFINE: a name nothing registered.
    return ops.map((op) =>
      op[0] === 4 && op[2] === "Reach.Leaf"
        ? [4, op[1], Mystery.schemaName, op[3], op[4]]
        : op,
    )
  }

  test("are skipped, and reported once per class through onUnknownClass", () => {
    const client = new Box()
    const unknown: string[] = []
    const ops = snapshotWithUnknownElement()
    applyDelta(client, ops, {
      onUnknownClass: (name) => unknown.push(name),
    }).unwrap()
    expect(unknown).toEqual([Mystery.schemaName])
    expect(client.things.size).toBe(0)
  })
})
