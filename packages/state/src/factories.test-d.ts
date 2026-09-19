/**
 * Type-level tests for the state factories, checked by `tsc --noEmit`.
 */
import { f } from "@bungohan/types"
import type {
  ArrayState,
  MapState,
  SchemaArrayState,
  SchemaMapState,
  SetState,
} from "./collections"
import {
  createArray,
  createFiltered,
  createFixedPoint,
  createMap,
  createNumber,
  createSchemaArray,
  createSchemaMap,
  createSet,
  createString,
} from "./factories"
import { Schema } from "./schema"

class Leaf extends Schema {
  public static override schemaName = "TD.Leaf"
  public v = createNumber()
}

/** Self-reference infers without an annotation. */
class Tree extends Schema {
  public static override schemaName = "TD.Tree"
  public children = createSchemaMap(f.string, Tree)
}

class Owned extends Schema {
  public static override schemaName = "TD.Owned"
  public ownerId = createString()
  public score = createNumber()

  // `this` is typed as the owning class via the annotation…
  public a = createFiltered(createNumber(), function (this: Owned, client) {
    return this.ownerId.get() === client.id
  })
  // …or captured lexically by an arrow function.
  public b = createFiltered(
    createString(),
    (client) => this.ownerId.get() === client.id,
  )
  // A custom client type.
  public c = createFiltered(
    createNumber(),
    (client: { team: number }) => client.team === this.score.get(),
  )
}

export function checks(o: Owned): void {
  // createFiltered keeps the wrapper's own API.
  o.a.set(1)
  o.b.set("x")

  // Element types are inferred from the descriptors.
  const m: MapState<number, number> = createMap(f.uint16, f.fixed(2))
  const s: SetState<string> = createSet(f.string)
  const a: ArrayState<boolean> = createArray(f.bool)
  const sm: SchemaMapState<string, Leaf> = createSchemaMap(f.string, Leaf)
  const sa: SchemaArrayState<Leaf> = createSchemaArray(Leaf)
  const t: SchemaMapState<string, Tree> = new Tree().children
  m.set(1, 0.5)
  s.add("x")
  a.push(true)
  sm.set("k", new Leaf())
  sa.push(new Leaf())
  t.get("x")?.children.get("y")
  // @ts-expect-error — keys follow the key descriptor
  m.set("1", 0.5)
  // @ts-expect-error — elements follow the value descriptor
  a.push(1)
  // @ts-expect-error — elements follow the class
  sm.set("k", new Tree())

  // Initial contents are checked against the descriptors.
  createMap(f.string, f.float32, new Map([["a", 1]]))
  // @ts-expect-error — string values for a float32 map
  createMap(f.string, f.float32, new Map([["a", "b"]]))

  // @ts-expect-error — map values use the primitive field types, no int8
  createMap(f.string, f.int8)
  // @ts-expect-error — nor nested message-only kinds
  createArray(f.array(f.string))
  // @ts-expect-error — keys are exact: no float32 keys
  createMap(f.float32, f.string)
  // @ts-expect-error — no fixed-point keys
  createMap(f.fixed(2), f.string)
  // @ts-expect-error — no bool keys
  createMap(f.bool, f.string)
  // @ts-expect-error — schema collections take a Schema class
  createSchemaMap(f.string, f.float64)
  // @ts-expect-error — primitive maps take a descriptor, not a class
  createMap(f.string, Leaf)
  // @ts-expect-error — sets hold keys: no bools
  createSet(f.bool)
  // @ts-expect-error — nor lossy numbers
  createSet(f.fixed(2))
  // @ts-expect-error — schema sets are createSchemaSet
  createSet(Owned)
  // @ts-expect-error — at most 9 decimal places (int32 range)
  createFixedPoint(10)

  const status = createString<"idle" | "busy">("idle")
  // @ts-expect-error — not in the literal union
  status.set("done")
}
