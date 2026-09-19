import type { FixedDecimals } from "@bungohan/types"
import {
  ArrayState,
  MapState,
  SchemaArrayState,
  SchemaMapState,
  SchemaSetState,
  SetState,
} from "./collections"
import type { KeyField, KeyOf, ValueField, ValueOf } from "./elements"
import {
  BooleanState,
  FixedPointState,
  Float32State,
  NumberState,
  StringState,
} from "./primitives"
import type { Schema } from "./schema"
import type { SchemaConstructor } from "./schema-registry"
import type { FilterFn, State } from "./state-base"

export function createNumber(initial = 0): NumberState {
  return new NumberState(initial)
}

/** **Lossy** 32-bit float on the wire. See {@link Float32State}. */
export function createFloat32(initial = 0): Float32State {
  return new Float32State(initial)
}

/**
 * **Lossy** fixed-point number: sent as an int32 of `value * 10^decimals`.
 * See {@link FixedPointState} and spec §5.7.6.1.
 */
export function createFixedPoint(
  decimalPlaces: FixedDecimals,
  initial = 0,
): FixedPointState {
  return new FixedPointState(decimalPlaces, initial)
}

/**
 * `createString<"idle" | "running">("idle")`. Without `initial`, the value
 * starts as `""` even if `T` is a literal union that excludes it.
 */
export function createString<T extends string = string>(
  initial?: NoInfer<T>,
): StringState<T> {
  return new StringState<T>(initial ?? ("" as T))
}

export function createBoolean(initial = false): BooleanState {
  return new BooleanState(initial)
}

/**
 * Map of primitives. `key` is `f.string`, `f.float64` or an integer kind
 * (`f.uint16`, …); `value` is `f.float64`, `f.float32`, `f.fixed(n)`,
 * `f.string` or `f.bool`. Lossy value types (`f.float32`, `f.fixed(n)`) are
 * quantized on the wire exactly like the matching primitive fields
 * (spec §5.7.6.1); keys never are.
 *
 * ```ts
 * public scores = createMap(f.string, f.fixed(1)) // MapState<string, number>
 * ```
 */
export function createMap<K extends KeyField, V extends ValueField>(
  key: K,
  value: V,
  initial?: Iterable<readonly [KeyOf<K>, ValueOf<V>]>,
): MapState<KeyOf<K>, ValueOf<V>> {
  return new MapState(key, value, initial)
}

/**
 * Set of keys: `createSet(f.string)`, `createSet(f.uint16)`. Elements are
 * exact (never quantized), like map keys.
 */
export function createSet<T extends KeyField>(
  of: T,
  initial?: Iterable<KeyOf<T>>,
): SetState<KeyOf<T>> {
  return new SetState(of, initial)
}

/** Array of primitives: `createArray(f.fixed(2))`. See {@link createMap}. */
export function createArray<T extends ValueField>(
  of: T,
  initial?: Iterable<ValueOf<T>>,
): ArrayState<ValueOf<T>> {
  return new ArrayState(of, initial)
}

/**
 * Map of Schema instances: `createSchemaMap(f.string, Player)`. The class
 * table lists the element class by its `schemaName`. Elements may also be
 * instances of a subclass (each ref carries its own class id).
 */
export function createSchemaMap<K extends KeyField, V extends Schema>(
  key: K,
  of: SchemaConstructor<V>,
  initial?: Iterable<readonly [KeyOf<K>, V]>,
): SchemaMapState<KeyOf<K>, V> {
  return new SchemaMapState(key, of, initial)
}

/** Set of Schema instances: `createSchemaSet(Item)`. */
export function createSchemaSet<T extends Schema>(
  of: SchemaConstructor<T>,
  initial?: Iterable<T>,
): SchemaSetState<T> {
  return new SchemaSetState(of, initial)
}

/** Array of Schema instances: `createSchemaArray(Item)`. */
export function createSchemaArray<T extends Schema>(
  of: SchemaConstructor<T>,
  initial?: Iterable<T>,
): SchemaArrayState<T> {
  return new SchemaArrayState(of, initial)
}

/** Default client shape seen by filter functions (core's Client satisfies it). */
export interface FilterClient {
  readonly id: string
}

/**
 * Sends `wrapped` only to clients for which `filterFn` returns true
 * (spec §5.6). Returns the same wrapper, so its API is unchanged.
 *
 * `filterFn` runs with `this` bound to the owning schema, once per client per
 * sync tick. It must be a pure function of the schema and the client; if it
 * throws, the field is treated as hidden for that client.
 *
 * ```ts
 * public secret = createFiltered(createString(""), function (this: RoomState, client) {
 *   return this.ownerId.get() === client.id
 * })
 * // or, capturing the instance lexically:
 * public secret = createFiltered(createString(""), (client) => this.ownerId.get() === client.id)
 * ```
 */
export function createFiltered<
  S extends State,
  TThis extends Schema = Schema,
  C = FilterClient,
>(wrapped: S, filterFn: (this: TThis, client: C) => boolean): S {
  // Type-erased for storage; the encoder calls it with the owner as `this`
  // and a client from the same `clients` iterable the room passes in.
  wrapped._filter = filterFn as unknown as FilterFn
  return wrapped
}
