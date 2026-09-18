/**
 * Typed message contracts (spec §4.1). Each builder returns a plain runtime
 * descriptor (read by codecs and codegen) whose TypeScript type also carries
 * the payload shape, so one declaration yields both. Nothing here validates
 * payloads at runtime.
 */
import type { FixedDecimals } from "./fixed"

// ---------------------------------------------------------------------------
// Field descriptors
// ---------------------------------------------------------------------------

export type IntKind = "int8" | "int16" | "int32" | "uint8" | "uint16" | "uint32"

export type ScalarKind = IntKind | "float32" | "float64" | "string" | "bool"

/** TypeScript type produced by each scalar kind. */
interface ScalarTypeMap {
  int8: number
  int16: number
  int32: number
  uint8: number
  uint16: number
  uint32: number
  float32: number
  float64: number
  string: string
  bool: boolean
}

export type EnumValue = string | number

export interface ScalarField<K extends ScalarKind = ScalarKind> {
  readonly kind: K
}

export interface FixedField<D extends FixedDecimals = FixedDecimals> {
  readonly kind: "fixed"
  readonly decimals: D
}

/** Encoded on the wire as the value's index in `values`. */
export interface EnumField<V extends EnumValue = EnumValue> {
  readonly kind: "enum"
  readonly values: readonly V[]
}

export interface ArrayField<E extends Field = Field> {
  readonly kind: "array"
  readonly of: E
}

/** String-keyed map. */
export interface MapField<E extends Field = Field> {
  readonly kind: "map"
  readonly of: E
}

/** As a message property, makes the property optional (`key?: T`). */
export interface OptionalField<E extends Field = Field> {
  readonly kind: "optional"
  readonly of: E
}

export interface NestedField<M extends MessageDef = MessageDef> {
  readonly kind: "nested"
  readonly message: M
}

export type Field =
  | ScalarField
  | FixedField
  | EnumField
  | ArrayField
  | MapField
  | OptionalField
  | NestedField

/** A message's fields. Property order is the positional wire order. */
export type FieldShape = { readonly [name: string]: Field }

export interface MessageDef<
  N extends string = string,
  S extends FieldShape = FieldShape,
> {
  readonly kind: "message"
  readonly name: N
  readonly fields: S
  /** `Object.keys(fields)`, precomputed: the positional wire order. */
  readonly fieldNames: readonly string[]
}

// ---------------------------------------------------------------------------
// Inference
// ---------------------------------------------------------------------------

/** Flattens an intersection into one object type (readable hovers). */
type Simplify<T> = { [K in keyof T]: T[K] }

/** The TypeScript value type described by a field descriptor. */
export type InferField<F> = F extends {
  readonly kind: infer K extends ScalarKind
}
  ? ScalarTypeMap[K]
  : F extends FixedField
    ? number
    : F extends EnumField<infer V>
      ? V
      : F extends ArrayField<infer E>
        ? InferField<E>[]
        : F extends MapField<infer E>
          ? { [key: string]: InferField<E> }
          : F extends OptionalField<infer E>
            ? InferField<E> | undefined
            : F extends NestedField<infer M>
              ? Infer<M>
              : never

type RequiredKeys<S> = {
  [K in keyof S]: S[K] extends OptionalField ? never : K
}[keyof S]

type OptionalKeys<S> = {
  [K in keyof S]: S[K] extends OptionalField ? K : never
}[keyof S]

/** Plain object type for a field shape; `f.optional` fields become `?:`. */
export type InferShape<S extends FieldShape> = Simplify<
  { -readonly [K in RequiredKeys<S>]: InferField<S[K]> } & {
    -readonly [K in OptionalKeys<S>]?: S[K] extends OptionalField<infer E>
      ? InferField<E>
      : never
  }
>

/** Payload type of a message: `Infer<typeof PlayerMove>`. */
export type Infer<M> =
  M extends MessageDef<string, infer S> ? InferShape<S> : never

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

function scalar<K extends ScalarKind>(kind: K): ScalarField<K> {
  return Object.freeze({ kind })
}

/** Field builders. Scalars are constants; the rest are functions. */
export const f = {
  int8: scalar("int8"),
  int16: scalar("int16"),
  int32: scalar("int32"),
  uint8: scalar("uint8"),
  uint16: scalar("uint16"),
  uint32: scalar("uint32"),
  float32: scalar("float32"),
  float64: scalar("float64"),
  string: scalar("string"),
  bool: scalar("bool"),

  /**
   * Lossy fixed-point number: sent as a signed 32-bit integer
   * `round(value * 10^decimals)`, saturating at the int32 range.
   * See spec §5.7.6.1 for the exact rules.
   */
  fixed<const D extends FixedDecimals>(decimals: D): FixedField<D> {
    return Object.freeze({ kind: "fixed", decimals })
  },

  /** One of the listed literals: `f.enum("red", "blue")`. */
  enum<const V extends readonly EnumValue[]>(
    ...values: V
  ): EnumField<V[number]> {
    return Object.freeze({ kind: "enum", values: Object.freeze([...values]) })
  },

  array<E extends Field>(of: E): ArrayField<E> {
    return Object.freeze({ kind: "array", of })
  },

  map<E extends Field>(of: E): MapField<E> {
    return Object.freeze({ kind: "map", of })
  },

  optional<E extends Field>(of: E): OptionalField<E> {
    return Object.freeze({ kind: "optional", of })
  },

  nested<M extends MessageDef>(message: M): NestedField<M> {
    return Object.freeze({ kind: "nested", message })
  },
} as const

/**
 * True for keys JS orders numerically before all others (canonical array
 * indices: "0", "7", "42", but not "07", "-1" or "1.5"). Such a key would
 * silently change the positional wire order of a message's fields.
 */
export function isIntegerLikeKey(key: string): boolean {
  return /^(?:0|[1-9]\d*)$/.test(key) && Number(key) < 4294967295
}

/** Compile-time counterpart: numeric-looking field names become `never`. */
type NoNumericKeys<S> = {
  // `{ 0: … }` has key type 0 (a number); `{ "0": … }` has "0".
  [K in keyof S]: K extends number | `${number}` ? never : S[K]
}

/**
 * Declares a message. Field names should be identifiers (codegen emits them
 * as C#/GDScript members) and must not be integer-like, since JS would
 * reorder those keys and break the positional wire order.
 *
 * Integer-like names are rejected at compile time and, once, at definition
 * time: this throws a `TypeError` while the module defining the message
 * loads. That is a deliberate exception to the framework's no-throw rule; it
 * is a static programming error, never a runtime condition (spec §4.1.1).
 */
export function defineMessage<const N extends string, S extends FieldShape>(
  name: N,
  fields: S & NoNumericKeys<S>,
): MessageDef<N, S> {
  const fieldNames = Object.keys(fields)
  const bad = fieldNames.filter(isIntegerLikeKey)
  if (bad.length > 0) {
    throw new TypeError(
      `defineMessage("${name}"): integer-like field names ` +
        `${bad.map((key) => `"${key}"`).join(", ")} are not allowed ` +
        "(JS reorders them, which would change the wire order)",
    )
  }
  return Object.freeze({
    kind: "message",
    name,
    fields: Object.freeze(fields),
    fieldNames: Object.freeze(fieldNames),
  })
}

// ---------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------

export type MessageMap = { readonly [name: string]: MessageDef }

/** `client`: client → server messages. `server`: server → client messages. */
export interface Contract {
  readonly client: MessageMap
  readonly server: MessageMap
}

/** Default when a Room/IRoom binds no contract: no typed messages at all. */
export interface EmptyContract {
  readonly client: Record<never, never>
  readonly server: Record<never, never>
}

/** Messages the server sends (and the client receives). */
export type SendMap<C extends Contract> = C["server"]
/** Messages the server receives (and the client sends). */
export type RecvMap<C extends Contract> = C["client"]

/** Requires each map key to equal its message's `name`. */
type KeysMatchNames<M> = {
  [K in keyof M]: M[K] extends MessageDef<K & string>
    ? M[K]
    : MessageDef<K & string>
}

/**
 * Declares a contract. Keys must equal the message names, so the name used
 * at call sites is always the name on the wire:
 * `defineContract({ client: { playerMove: PlayerMove } })`.
 */
export function defineContract<const C extends Contract>(
  contract: C & {
    readonly client: KeysMatchNames<C["client"]>
    readonly server: KeysMatchNames<C["server"]>
  },
): C {
  return Object.freeze(contract)
}
