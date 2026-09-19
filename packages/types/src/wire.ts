/**
 * State-sync wire vocabulary (spec §5.7). `WireOp[]` is the stable interface
 * between `@bungohan/state` and whichever codec encodes it (§8.1).
 */
import type { IntKind } from "./contract"
import type { FixedDecimals } from "./fixed"
import { isIntKind } from "./ints"

/** Op codes, as the first element of every {@link WireOp}. */
export const WireOpCode = {
  SET: 0,
  ADD: 1,
  REMOVE: 2,
  CLEAR: 3,
  DEFINE: 4,
} as const

/** A primitive collection key (map key, array index, set element). */
export type WireKey = string | number | boolean

/** A reference to a Schema instance; creates it if `refId` is unknown. */
export type WireRef = [classId: number, refId: number]

export type WireValue = number | string | boolean | WireRef

/** A primitive field's type (also map values and array elements). */
export type PrimitiveFieldType =
  | "float64"
  | "float32"
  | `fixed:${FixedDecimals}`
  | "string"
  | "bool"

/**
 * A map key's (or set element's) type. Keys are exact: never quantized, and
 * integer kinds reject non-integers and out-of-range values on receipt.
 */
export type KeyFieldType = "string" | "float64" | IntKind

/**
 * Per-field type in the class table (spec §5.7.2, §5.7.11). Collections and
 * nested schemas carry their element types, so the table alone is enough to
 * decode a field or to generate a typed client class for it:
 *
 * | Declaration                              | Table entry                  |
 * |------------------------------------------|------------------------------|
 * | `createNumber()`                         | `float64`                    |
 * | `createFixedPoint(2)`                    | `fixed:2`                    |
 * | `createInt(f.uint16)`                    | `uint16`                     |
 * | `new Vec()` (nested schema field)        | `schema<Vec>`                |
 * | `createMap(f.string, f.float32)`         | `map<string,float32>`        |
 * | `createSet(f.uint16)`                    | `set<uint16>`                |
 * | `createArray(f.fixed(2))`                | `array<fixed:2>`             |
 * | `createSchemaMap(f.string, Player)`      | `schemaMap<string,Player>`   |
 * | `createSchemaSet(Item)`                  | `schemaSet<Item>`            |
 * | `createSchemaArray(Item)`                | `schemaArray<Item>`          |
 *
 * Schema names are the classes' `schemaName`s. They may contain any
 * character: a name always runs to the closing `>` at the end of the string.
 */
export type SchemaFieldType =
  | PrimitiveFieldType
  | IntKind
  | `schema<${string}>`
  | `map<${KeyFieldType},${PrimitiveFieldType}>`
  | `set<${KeyFieldType}>`
  | `array<${PrimitiveFieldType}>`
  | `schemaMap<${KeyFieldType},${string}>`
  | `schemaSet<${string}>`
  | `schemaArray<${string}>`

/** A {@link SchemaFieldType} broken into its parts. */
export type ParsedFieldType =
  | { readonly kind: "primitive"; readonly type: PrimitiveFieldType }
  /** An integer field (`createInt`). Fields only, never collection values. */
  | { readonly kind: "int"; readonly type: IntKind }
  | { readonly kind: "schema"; readonly schema: string }
  | {
      readonly kind: "map"
      readonly key: KeyFieldType
      readonly element: PrimitiveFieldType
    }
  | { readonly kind: "set"; readonly element: KeyFieldType }
  | { readonly kind: "array"; readonly element: PrimitiveFieldType }
  | {
      readonly kind: "schemaMap"
      readonly key: KeyFieldType
      readonly schema: string
    }
  | { readonly kind: "schemaSet"; readonly schema: string }
  | { readonly kind: "schemaArray"; readonly schema: string }

const KEY_TYPES: ReadonlySet<string> = new Set<KeyFieldType>([
  "string",
  "float64",
  "int8",
  "int16",
  "int32",
  "uint8",
  "uint16",
  "uint32",
])

export function isPrimitiveFieldType(type: string): type is PrimitiveFieldType {
  return (
    type === "float64" ||
    type === "float32" ||
    type === "string" ||
    type === "bool" ||
    /^fixed:\d$/.test(type)
  )
}

export function isKeyFieldType(type: string): type is KeyFieldType {
  return KEY_TYPES.has(type)
}

/**
 * Parses a class-table field type; `undefined` if it isn't one. Receivers
 * run this once per DEFINE, never per op.
 */
export function parseFieldType(type: string): ParsedFieldType | undefined {
  if (isPrimitiveFieldType(type)) return { kind: "primitive", type }
  if (isIntKind(type)) return { kind: "int", type }
  const open = type.indexOf("<")
  if (open <= 0 || !type.endsWith(">")) return undefined
  const head = type.slice(0, open)
  const inner = type.slice(open + 1, -1)
  const comma = inner.indexOf(",")
  const key = inner.slice(0, comma)
  const rest = inner.slice(comma + 1)
  switch (head) {
    case "schema":
    case "schemaSet":
    case "schemaArray":
      return inner === "" ? undefined : { kind: head, schema: inner }
    case "set":
      return isKeyFieldType(inner) ? { kind: "set", element: inner } : undefined
    case "array":
      return isPrimitiveFieldType(inner)
        ? { kind: "array", element: inner }
        : undefined
    case "map":
      return comma > 0 && isKeyFieldType(key) && isPrimitiveFieldType(rest)
        ? { kind: "map", key, element: rest }
        : undefined
    case "schemaMap":
      return comma > 0 && isKeyFieldType(key) && rest !== ""
        ? { kind: "schemaMap", key, schema: rest }
        : undefined
    default:
      return undefined
  }
}

/**
 * True for the collection kinds, i.e. the fields that own an implicit
 * collection refId (spec §5.7.9).
 */
export function isCollectionField(parsed: ParsedFieldType): boolean {
  return (
    parsed.kind !== "primitive" &&
    parsed.kind !== "int" &&
    parsed.kind !== "schema"
  )
}

/**
 * - `SET`    on a schema instance: `fieldIndex`; on an array: replace at index.
 * - `ADD`    map: upsert `key`; array: insert at index `key`;
 *            set: 3-element form `[1, refId, value]`.
 * - `REMOVE` map: `key`; array: index; set: the element (or its refId for
 *            schema sets).
 * - `CLEAR`  empties a collection.
 * - `DEFINE` appends a class to the room's class table (spec §5.7.2).
 */
export type WireOp =
  | [op: 0, refId: number, fieldOrIndex: number, value: WireValue]
  | [op: 1, refId: number, key: WireKey, value: WireValue]
  | [op: 1, refId: number, value: WireValue]
  | [op: 2, refId: number, key: WireKey]
  | [op: 3, refId: number]
  | [
      op: 4,
      classId: number,
      name: string,
      fields: string[],
      types: SchemaFieldType[],
    ]

export interface SchemaClassEntry {
  classId: number
  name: string
  /** Field names in declaration order; a field's index is its position. */
  fields: string[]
  /** Parallel to `fields`. */
  types: SchemaFieldType[]
}

/** The room's class table (the §5.7.2 handshake). */
export interface SchemaTable {
  classes: SchemaClassEntry[]
}
