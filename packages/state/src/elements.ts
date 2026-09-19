/**
 * Runtime element descriptors for collections (spec §5.7.11). Collections
 * take the §4.1 `f.*` builders for primitive elements and keys, and a Schema
 * class for schema elements, so the class table can say "map of Player" or
 * "array of fixed:2" instead of just "map".
 */
import {
  type FixedDecimals,
  type FixedField,
  fromFixed,
  type IntKind,
  isIntKind,
  isIntOf,
  type KeyFieldType,
  type PrimitiveFieldType,
  type ScalarField,
  toFixed,
} from "@bungohan/types"
import type { PrimitiveWire } from "./primitives"

/** Descriptors for map values and array elements: the primitive field set. */
export type ValueField =
  | ScalarField<"float64" | "float32" | "string" | "bool">
  | FixedField

/**
 * Descriptors for map keys and set elements. Keys are exact (never
 * quantized): strings, float64, or an integer kind.
 */
export type KeyField = ScalarField<KeyFieldType>

/** The TypeScript type a key descriptor produces. */
export type KeyOf<F extends KeyField> =
  F extends ScalarField<"string"> ? string : number

/** The TypeScript type a value descriptor produces. */
export type ValueOf<F extends ValueField> =
  F extends ScalarField<"string">
    ? string
    : F extends ScalarField<"bool">
      ? boolean
      : number

/**
 * @internal Wire conversion for one element type. `encode` is total (any
 * input yields a valid wire value) because it runs on the server's per-tick
 * path; `decode` validates, since its input is untrusted.
 */
export interface ElementCodec<T extends string = string> {
  /** Token in the class table (`float64`, `fixed:2`, `uint16`, …). */
  readonly type: T
  encode(value: unknown): PrimitiveWire
  decode(wire: unknown): PrimitiveWire | undefined
}

const num = (value: unknown): number => (typeof value === "number" ? value : 0)

const FLOAT64: ElementCodec<"float64"> = {
  type: "float64",
  encode: num,
  decode: (wire) => (typeof wire === "number" ? wire : undefined),
}

const FLOAT32: ElementCodec<"float32"> = {
  type: "float32",
  encode: (value) => Math.fround(num(value)),
  decode: (wire) => (typeof wire === "number" ? Math.fround(wire) : undefined),
}

const STRING: ElementCodec<"string"> = {
  type: "string",
  encode: (value) => (typeof value === "string" ? value : ""),
  decode: (wire) => (typeof wire === "string" ? wire : undefined),
}

const BOOL: ElementCodec<"bool"> = {
  type: "bool",
  encode: (value) => value === true,
  decode: (wire) => (typeof wire === "boolean" ? wire : undefined),
}

function fixedCodec(decimals: FixedDecimals): ElementCodec<PrimitiveFieldType> {
  return {
    type: `fixed:${decimals}`,
    encode: (value) => toFixed(num(value), decimals),
    decode: (wire) =>
      typeof wire === "number" && Number.isInteger(wire)
        ? fromFixed(wire, decimals)
        : undefined,
  }
}

const FIXED = ([0, 1, 2, 3, 4, 5, 6, 7, 8, 9] as const).map(fixedCodec)

function intCodec(kind: IntKind): ElementCodec<KeyFieldType> {
  return {
    type: kind,
    encode: num,
    decode: (wire) => (isIntOf(wire, kind) ? wire : undefined),
  }
}

const INT: ReadonlyMap<string, ElementCodec<KeyFieldType>> = new Map(
  (["int8", "int16", "int32", "uint8", "uint16", "uint32"] as const).map(
    (kind) => [kind, intCodec(kind)],
  ),
)

/**
 * Stand-in for a descriptor that failed validation. Such a field is left
 * out of the class table (and never synchronized), so this only keeps the
 * collection usable locally.
 */
export const INVALID_CODEC: ElementCodec<"string"> = {
  type: "string",
  encode: (value) =>
    typeof value === "number" ||
    typeof value === "string" ||
    typeof value === "boolean"
      ? value
      : "",
  decode: () => undefined,
}

function kindOf(descriptor: unknown): unknown {
  return typeof descriptor === "object" && descriptor !== null
    ? Reflect.get(descriptor, "kind")
    : undefined
}

/** Codec for a map value / array element descriptor, if it is one. */
export function valueCodec(
  descriptor: unknown,
): ElementCodec<PrimitiveFieldType> | undefined {
  const kind = kindOf(descriptor)
  switch (kind) {
    case "float64":
      return FLOAT64
    case "float32":
      return FLOAT32
    case "string":
      return STRING
    case "bool":
      return BOOL
    case "fixed": {
      const decimals: unknown = Reflect.get(Object(descriptor), "decimals")
      return typeof decimals === "number" ? FIXED[decimals] : undefined
    }
    default:
      return undefined
  }
}

/** Codec for a map key / set element descriptor, if it is one. */
export function keyCodec(
  descriptor: unknown,
): ElementCodec<KeyFieldType> | undefined {
  const kind = kindOf(descriptor)
  if (kind === "string") return STRING
  if (kind === "float64") return FLOAT64
  return typeof kind === "string" && isIntKind(kind) ? INT.get(kind) : undefined
}

/** Human-readable descriptor, for declaration error messages. */
export function describe(descriptor: unknown): string {
  try {
    return JSON.stringify(descriptor) ?? String(descriptor)
  } catch {
    return String(descriptor)
  }
}
