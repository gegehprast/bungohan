import type { FixedDecimals, IntKind, ScalarField } from "@bungohan/types"
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
  IntState,
  NumberState,
  StringState,
} from "./primitives"
import type { Schema } from "./schema"
import type { SchemaConstructor } from "./schema-registry"
import type { FilterFn, State } from "./state-base"

/**
 * A `number` field, sent exactly as a float64 (8 bytes). Use it when the
 * value must be exact or its range is unknown; for positions and other
 * values with a known resolution, `createFixedPoint` is far smaller (see
 * docs/guides/state.md#picking-a-number-type).
 */
export function createNumber(initial = 0): NumberState {
  return new NumberState(initial)
}

/** **Lossy** 32-bit float on the wire. See {@link Float32State}. */
export function createFloat32(initial = 0): Float32State {
  return new Float32State(initial)
}

/**
 * **Lossy** fixed-point number with `decimalPlaces` (0–9): sent as the
 * int32 `round(value * 10^decimalPlaces)`, rounding half away from zero
 * and saturating (±21,474,836.47 at 2 places), usually in 1–3 bytes. The
 * server keeps the exact value you set, so small steps still accumulate,
 * and a write that doesn't change the rounded value sends nothing. The
 * usual choice for positions. See {@link FixedPointState}.
 */
export function createFixedPoint(
  decimalPlaces: FixedDecimals,
  initial = 0,
): FixedPointState {
  return new FixedPointState(decimalPlaces, initial)
}

/**
 * Integer of one kind: `createInt(f.int32)`, `createInt(f.uint8, 1)`. The
 * wire carries the value truncated toward zero and saturated at the
 * kind's range (a `uint8` set to 300 sends 255). See {@link IntState}.
 */
export function createInt<K extends IntKind>(
  of: ScalarField<K>,
  initial = 0,
): IntState {
  return new IntState(of, initial)
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

/** A `boolean` field. */
export function createBoolean(initial = false): BooleanState {
  return new BooleanState(initial)
}

/**
 * Map of primitives. `key` is `f.string`, `f.float64` or an integer kind
 * (`f.uint16`, …); `value` is `f.float64`, `f.float32`, `f.fixed(n)`,
 * `f.string` or `f.bool`. Lossy value types (`f.float32`, `f.fixed(n)`) are
 * quantized on the wire exactly like the matching primitive fields; keys
 * never are.
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
  /** The seat's `sessionId`, as everywhere else on the server. */
  readonly sessionId: string
  /** The same value as `sessionId`. */
  readonly id: string
}

/**
 * Sends `wrapped` only to clients for which `filterFn` returns true
 * (see docs/guides/state.md#per-client-visibility). Returns the same
 * wrapper, so its API is unchanged.
 *
 * `filterFn` runs with `this` bound to the owning schema, once per client per
 * sync tick. It must be a pure function of the schema and the client; if it
 * throws, the field is treated as hidden for that client.
 *
 * ```ts
 * public secret = createFiltered(createString(""), function (this: RoomState, client) {
 *   return this.ownerId.get() === client.sessionId
 * })
 * // or, capturing the instance lexically:
 * public secret = createFiltered(createString(""), (client) => this.ownerId.get() === client.sessionId)
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

/** The filter of `createServerOnly`: no client ever sees the field. */
function serverOnly(): boolean {
  return false
}

/**
 * A field that stays on the server: never sent to any client, but part of
 * the state everywhere else, so `saveState` stores it and `loadState`
 * restores it (a generated layout, an RNG seed, a hidden goal). Use it rather
 * than a plain class field when the value must survive a save.
 * Clients see its zero value (`""`, `0`, `false`, an empty collection),
 * and its name, not its value, is in the class table they receive.
 * Returns the same wrapper. See docs/guides/state.md#server-only-fields.
 */
export function createServerOnly<S extends State>(wrapped: S): S {
  return createFiltered(wrapped, serverOnly)
}
