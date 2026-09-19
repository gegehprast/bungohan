/**
 * `replica` conformance cases (PROTOCOL.md §14): builds the case's classes
 * as `@bungohan/state` Schema classes, applies each frame's ops to a
 * replica root, and compares the tree with the frame's `expect`, including
 * which objects are the same object (`"$"` labels).
 */
import {
  applyDelta,
  CollectionState,
  createArray,
  createBoolean,
  createFixedPoint,
  createFloat32,
  createInt,
  createMap,
  createNumber,
  createSchemaArray,
  createSchemaMap,
  createSchemaSet,
  createSet,
  createString,
  type KeyField,
  MapBase,
  PrimitiveState,
  Schema,
  type SchemaConstructor,
  SchemaRegistry,
  SetBase,
  type ValueField,
} from "@bungohan/state"
import {
  type FixedDecimals,
  f,
  type KeyFieldType,
  type PrimitiveFieldType,
  parseFieldType,
  type WireOp,
} from "@bungohan/types"
import { difference } from "./vectors"

type Case = Readonly<Record<string, unknown>>

interface ClassDecl {
  readonly name: string
  readonly fields: readonly (readonly [string, string])[]
}

function classDecls(value: unknown): ClassDecl[] {
  if (!Array.isArray(value)) throw new Error("classes must be an array")
  return value.map((decl: unknown) => {
    if (typeof decl !== "object" || decl === null) throw new Error("bad class")
    const { name, fields } = decl as Record<string, unknown>
    if (typeof name !== "string" || !Array.isArray(fields)) {
      throw new Error("bad class declaration")
    }
    return {
      name,
      fields: fields.map((field: unknown) => {
        if (
          !Array.isArray(field) ||
          typeof field[0] !== "string" ||
          typeof field[1] !== "string"
        ) {
          throw new Error(`${name}: bad field`)
        }
        return [field[0], field[1]] as const
      }),
    }
  })
}

const KEYS: Readonly<Record<KeyFieldType, KeyField>> = {
  string: f.string,
  float64: f.float64,
  int8: f.int8,
  int16: f.int16,
  int32: f.int32,
  uint8: f.uint8,
  uint16: f.uint16,
  uint32: f.uint32,
}

function valueField(type: PrimitiveFieldType): ValueField {
  if (type === "float64") return f.float64
  if (type === "float32") return f.float32
  if (type === "string") return f.string
  if (type === "bool") return f.bool
  const decimals = Number(type.slice("fixed:".length))
  if (!isDecimals(decimals)) throw new Error(`bad type ${type}`)
  return f.fixed(decimals)
}

function isDecimals(value: number): value is FixedDecimals {
  return Number.isInteger(value) && value >= 0 && value <= 9
}

/** Schema classes for the declarations, registered under their names. */
function buildClasses(decls: readonly ClassDecl[]) {
  const classes = new Map<string, SchemaConstructor>()
  const classOf = (name: string): SchemaConstructor => {
    const ctor = classes.get(name)
    if (ctor === undefined) throw new Error(`undeclared class ${name}`)
    return ctor
  }
  const fieldFor = (type: string): unknown => {
    const parsed = parseFieldType(type)
    if (parsed === undefined) throw new Error(`bad type ${type}`)
    switch (parsed.kind) {
      case "primitive": {
        const t = parsed.type
        if (t === "float64") return createNumber()
        if (t === "float32") return createFloat32()
        if (t === "string") return createString()
        if (t === "bool") return createBoolean()
        const decimals = Number(t.slice("fixed:".length))
        if (!isDecimals(decimals)) throw new Error(`bad type ${type}`)
        return createFixedPoint(decimals)
      }
      case "int":
        return createInt(f[parsed.type])
      case "schema":
        return new (classOf(parsed.schema))()
      case "map":
        return createMap(KEYS[parsed.key], valueField(parsed.element))
      case "set":
        return createSet(KEYS[parsed.element])
      case "array":
        return createArray(valueField(parsed.element))
      case "schemaMap":
        return createSchemaMap(KEYS[parsed.key], classOf(parsed.schema))
      case "schemaSet":
        return createSchemaSet(classOf(parsed.schema))
      case "schemaArray":
        return createSchemaArray(classOf(parsed.schema))
    }
  }
  for (const decl of decls) {
    const ctor = class extends Schema {
      public static override schemaName = decl.name
      public constructor() {
        super()
        for (const [name, type] of decl.fields) {
          Reflect.set(this, name, fieldFor(type))
        }
      }
    }
    classes.set(decl.name, ctor)
  }
  SchemaRegistry.register(...classes.values())
  return classOf
}

/** Checks `actual` against an `expect` tree, binding `$` labels. */
class TreeCheck {
  private readonly _objects = new Map<string, object>()
  private readonly _labels = new Map<object, string>()

  public compare(actual: unknown, expected: unknown, path: string): string[] {
    if (actual instanceof Schema) return this._instance(actual, expected, path)
    if (actual instanceof PrimitiveState) {
      const diff = difference(actual.get(), expected, path)
      return diff === undefined ? [] : [diff]
    }
    if (actual instanceof CollectionState) {
      return this._collection(actual, expected, path)
    }
    return [`${path}: unexpected ${String(actual)}`]
  }

  private _instance(actual: Schema, expected: unknown, path: string) {
    if (typeof expected !== "object" || expected === null) {
      return [`${path}: expected ${JSON.stringify(expected)}, got an instance`]
    }
    const record = expected as Record<string, unknown>
    const problems: string[] = []
    const label = record["$"]
    if (typeof label === "string") {
      const bound = this._objects.get(label)
      const known = this._labels.get(actual)
      if (bound !== undefined && bound !== actual) {
        problems.push(`${path}: "${label}" is a different object than before`)
      } else if (known !== undefined && known !== label) {
        problems.push(`${path}: "${label}" is the object labeled "${known}"`)
      } else {
        this._objects.set(label, actual)
        this._labels.set(actual, label)
      }
    }
    const fields = actual._ensureInit().fields.map((field) => field.name)
    const names = new Set([
      ...fields,
      ...Object.keys(record).filter((k) => k !== "$"),
    ])
    for (const name of names) {
      if (!fields.includes(name) || !(name in record)) {
        problems.push(`${path}.${name}: field missing on one side`)
        continue
      }
      problems.push(
        ...this.compare(
          Reflect.get(actual, name),
          record[name],
          `${path}.${name}`,
        ),
      )
    }
    return problems
  }

  private _collection(
    actual: CollectionState<unknown, unknown, unknown>,
    expected: unknown,
    path: string,
  ): string[] {
    if (!Array.isArray(expected)) return [`${path}: expected an array`]
    const elements = [...actual._elements()]
    if (elements.length !== expected.length) {
      return [`${path}: ${elements.length} elements ≠ ${expected.length}`]
    }
    if (actual instanceof MapBase) {
      const problems: string[] = []
      for (const entry of expected) {
        const key: unknown = Array.isArray(entry) ? entry[0] : undefined
        if (typeof key !== "string" && typeof key !== "number") {
          problems.push(`${path}: bad expected entry`)
          continue
        }
        if (!actual.has(key)) {
          problems.push(`${path}: no key ${JSON.stringify(key)}`)
          continue
        }
        problems.push(
          ...this._element(actual.get(key), entry[1], `${path}[${key}]`),
        )
      }
      return problems
    }
    if (actual instanceof SetBase) {
      // Set elements are keys: primitives, or instances (checked in order
      // of the expected list against any unmatched element).
      const remaining = [...elements]
      const problems: string[] = []
      for (const [i, want] of expected.entries()) {
        const at = remaining.findIndex((element) =>
          this._tries(() => this._element(element, want, `${path}{${i}}`)),
        )
        if (at < 0) problems.push(`${path}: no element matches #${i}`)
        else remaining.splice(at, 1)
      }
      return problems
    }
    return elements.flatMap((element, i) =>
      this._element(element, expected[i], `${path}[${i}]`),
    )
  }

  /** Runs a comparison, keeping its label bindings only if it matched. */
  private _tries(compare: () => string[]): boolean {
    const objects = new Map(this._objects)
    const labels = new Map(this._labels)
    if (compare().length === 0) return true
    this._objects.clear()
    this._labels.clear()
    for (const [label, object] of objects) this._objects.set(label, object)
    for (const [object, label] of labels) this._labels.set(object, label)
    return false
  }

  private _element(actual: unknown, expected: unknown, path: string) {
    if (actual instanceof Schema) return this.compare(actual, expected, path)
    const diff = difference(actual, expected, path)
    return diff === undefined ? [] : [diff]
  }
}

/** Runs one `replica` case; returns the problems found (none: passed). */
export function runReplica(c: Case): string[] {
  const classOf = buildClasses(classDecls(c["classes"]))
  const rootName = c["root"]
  if (typeof rootName !== "string") throw new Error("no root class")
  const root = new (classOf(rootName))()
  const check = new TreeCheck()
  const frames = c["frames"]
  if (!Array.isArray(frames)) throw new Error("no frames")
  for (const [i, frame] of frames.entries()) {
    const { ops, expect } = frame as Record<string, unknown>
    if (!Array.isArray(ops)) throw new Error(`frame ${i}: no ops`)
    const applied = applyDelta(root, ops as WireOp[])
    if (applied.isErr()) return [`frame ${i}: ${applied.error.message}`]
    if (expect === undefined) continue
    const problems = check.compare(root, expect, `frame ${i}: $`)
    if (problems.length > 0) return problems
  }
  return []
}
