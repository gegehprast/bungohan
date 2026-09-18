import type { FixedDecimals } from "@bungohan/types"
import {
  ArrayState,
  type MapKey,
  MapState,
  SchemaArrayState,
  SchemaMapState,
  SchemaSetState,
  SetState,
} from "./collections"
import {
  BooleanState,
  FixedPointState,
  Float32State,
  NumberState,
  type PrimitiveWire,
  StringState,
} from "./primitives"
import type { Schema } from "./schema"
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

export function createMap<K extends MapKey, V extends PrimitiveWire>(
  initial?: Map<K, V>,
): MapState<K, V> {
  return new MapState<K, V>(initial)
}

export function createSet<T extends PrimitiveWire>(
  initial?: Set<T>,
): SetState<T> {
  return new SetState<T>(initial)
}

export function createArray<T extends PrimitiveWire>(
  initial?: T[],
): ArrayState<T> {
  return new ArrayState<T>(initial)
}

export function createSchemaMap<K extends MapKey, V extends Schema>(
  initial?: Map<K, V>,
): SchemaMapState<K, V> {
  return new SchemaMapState<K, V>(initial)
}

export function createSchemaSet<T extends Schema>(
  initial?: Set<T>,
): SchemaSetState<T> {
  return new SchemaSetState<T>(initial)
}

export function createSchemaArray<T extends Schema>(
  initial?: T[],
): SchemaArrayState<T> {
  return new SchemaArrayState<T>(initial)
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
