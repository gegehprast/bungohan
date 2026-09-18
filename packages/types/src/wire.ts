/**
 * State-sync wire vocabulary (spec §5.7). `WireOp[]` is the stable interface
 * between `@bungohan/state` and whichever codec encodes it (§8.1).
 */

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

/**
 * Per-field type in the class table. Collection element types are erased by
 * TypeScript and therefore not described here (see spec §5.7.9).
 */
export type SchemaFieldType =
  | "float64"
  | "float32"
  | `fixed:${number}`
  | "string"
  | "bool"
  | "schema"
  | "map"
  | "set"
  | "array"
  | "schemaMap"
  | "schemaSet"
  | "schemaArray"

/** Field types that own a collection refId (allocated implicitly). */
export const COLLECTION_FIELD_TYPES: ReadonlySet<SchemaFieldType> = new Set([
  "map",
  "set",
  "array",
  "schemaMap",
  "schemaSet",
  "schemaArray",
])

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
