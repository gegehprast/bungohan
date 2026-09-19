/**
 * Plain-data form of a schema tree, for persistence (`Room.saveState` /
 * `loadState` through `IStore`, which stores JSON). Not a wire format: the
 * wire is the op stream (§5.7).
 *
 * - A Schema is an object of its synchronized fields plus `"$class"` (its
 *   `schemaName`), so subclass elements come back as the right class.
 * - Primitives are their full-precision server value (`get()`), not the
 *   quantized wire value.
 * - Maps are `[key, value][]` (keys may be numbers), sets and arrays are
 *   arrays.
 */
import { err, ok, type Result } from "@bungohan/result"
import {
  ArrayBase,
  CollectionState,
  MapBase,
  SchemaArrayState,
  SchemaMapState,
  SchemaSetState,
  SetBase,
} from "./collections"
import { StateError } from "./errors"
import { PrimitiveState } from "./primitives"
import { fieldValue, Schema } from "./schema"
import { type SchemaConstructor, SchemaRegistry } from "./schema-registry"

const CLASS_KEY = "$class"

type Plain = unknown

function elementToPlain(value: unknown): Plain {
  return value instanceof Schema ? toPlain(value) : value
}

/** The schema tree as JSON-safe plain data. */
export function toPlain(schema: Schema): Record<string, Plain> {
  const info = schema._ensureInit()
  const out: Record<string, Plain> = { [CLASS_KEY]: info.name }
  for (const field of info.fields) {
    const value = fieldValue(schema, field.name)
    if (value instanceof Schema) out[field.name] = toPlain(value)
    else if (value instanceof PrimitiveState) out[field.name] = value.get()
    else if (value instanceof MapBase) {
      out[field.name] = [...value].map(([k, v]) => [k, elementToPlain(v)])
    } else if (value instanceof SetBase || value instanceof ArrayBase) {
      out[field.name] = [...value].map(elementToPlain)
    }
  }
  return out
}

class Invalid {
  public readonly message: string

  public constructor(message: string) {
    this.message = message
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** A new instance of the plain object's class (or `fallback`), filled in. */
function instantiate(
  plain: unknown,
  fallback: SchemaConstructor,
  path: string,
): Schema | Invalid {
  if (!isRecord(plain)) return new Invalid(`${path}: expected an object`)
  const name = plain[CLASS_KEY]
  const ctor =
    typeof name === "string" ? (SchemaRegistry.get(name) ?? fallback) : fallback
  const instance = new ctor()
  const filled = fill(instance, plain, path)
  return filled instanceof Invalid ? filled : instance
}

/** Primitive element check: the collection's codec decides the JS type. */
function primitiveElement(
  collection: CollectionState<unknown, unknown, unknown>,
  value: unknown,
  path: string,
): unknown {
  const type = collection._codec?.type
  const expected =
    type === "string" ? "string" : type === "bool" ? "boolean" : "number"
  return typeof value === expected
    ? value
    : new Invalid(`${path}: expected a ${expected}`)
}

function element(
  collection: CollectionState<unknown, unknown, unknown>,
  value: unknown,
  path: string,
): unknown {
  if (
    collection instanceof SchemaMapState ||
    collection instanceof SchemaSetState ||
    collection instanceof SchemaArrayState
  ) {
    return instantiate(value, collection._class, path)
  }
  return primitiveElement(collection, value, path)
}

function fillCollection(
  collection: CollectionState<unknown, unknown, unknown>,
  plain: unknown,
  path: string,
): Invalid | undefined {
  if (!Array.isArray(plain)) return new Invalid(`${path}: expected an array`)
  collection._reset()
  for (let i = 0; i < plain.length; i++) {
    const at = `${path}[${i}]`
    if (collection instanceof MapBase) {
      const entry: unknown = plain[i]
      if (!Array.isArray(entry) || entry.length !== 2) {
        return new Invalid(`${at}: expected a [key, value] pair`)
      }
      const key = collection._keyCodec.decode(entry[0])
      if (key === undefined || typeof key === "boolean") {
        return new Invalid(`${at}: bad key`)
      }
      const value = element(collection, entry[1], at)
      if (value instanceof Invalid) return value
      collection.set(key, value)
    } else {
      const value = element(collection, plain[i], at)
      if (value instanceof Invalid) return value
      if (collection instanceof SetBase) collection.add(value)
      else if (collection instanceof ArrayBase) collection.push(value)
    }
  }
  return undefined
}

function fill(
  schema: Schema,
  plain: Record<string, unknown>,
  path: string,
): Invalid | undefined {
  const info = schema._ensureInit()
  for (const field of info.fields) {
    if (!Object.hasOwn(plain, field.name)) continue
    const input = plain[field.name]
    const at = `${path}.${field.name}`
    const value = fieldValue(schema, field.name)
    if (value instanceof Schema) {
      if (!isRecord(input)) return new Invalid(`${at}: expected an object`)
      const nested = fill(value, input, at)
      if (nested !== undefined) return nested
    } else if (value instanceof PrimitiveState) {
      if (typeof input !== typeof value.get()) {
        return new Invalid(`${at}: expected a ${typeof value.get()}`)
      }
      value.set(input)
    } else if (value instanceof CollectionState) {
      const problem = fillCollection(value, input, at)
      if (problem !== undefined) return problem
    }
  }
  return undefined
}

/**
 * Rebuilds a tree saved with {@link toPlain} as a new `ctor` instance.
 * Fields missing from the data keep their initializer values; fields the
 * data has but the class doesn't are ignored. Wrong types are
 * `INVALID_DATA`.
 */
export function fromPlain<T extends Schema>(
  ctor: SchemaConstructor<T>,
  plain: unknown,
): Result<T, StateError> {
  if (!isRecord(plain)) {
    return err(new StateError("INVALID_DATA", "expected an object"))
  }
  const instance = new ctor()
  const problem = fill(instance, plain, ctor.name)
  return problem === undefined
    ? ok(instance)
    : err(new StateError("INVALID_DATA", problem.message))
}
