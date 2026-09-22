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

/**
 * A declared message, from `defineMessage`: its name and ordered fields.
 * Put it in a contract (`defineContract`) to send and receive it, and use
 * `Infer<typeof Message>` for its payload type.
 */
export interface MessageDef<
  N extends string = string,
  S extends FieldShape = FieldShape,
> {
  /** Always `"message"`: tells a declaration apart from a field. */
  readonly kind: "message"
  /** The name it is sent under; a contract's key for it must equal it. */
  readonly name: N
  /** The field builders it was declared with (`f.int8`, …), in order. */
  readonly fields: S
  /** `Object.keys(fields)`, precomputed: the positional wire order. */
  readonly fieldNames: readonly string[]
}

// ---------------------------------------------------------------------------
// Inference
// ---------------------------------------------------------------------------

/** Flattens an intersection into one object type (readable hovers). */
type Simplify<T> = { [K in keyof T]: T[K] }

/**
 * The TypeScript value type described by a field descriptor.
 *
 * The wide `Field` union (what an unresolved generic reduces to) infers as
 * `unknown`. Without that stop, `Field` → `ArrayField<Field>` →
 * `InferField<Field>[]` → … recurses forever, and generic code such as
 * `function send<M extends MessageDef>(m: M, p: Infer<M>)` fails with
 * TS2589. Concrete descriptors never reach it.
 */
export type InferField<F> = [Field] extends [F]
  ? unknown
  : F extends {
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

/**
 * Plain object type for a field shape; `f.optional` fields become `?:`.
 * The wide `FieldShape` (an unresolved generic) is an open record; see
 * {@link InferField}.
 */
export type InferShape<S extends FieldShape> = string extends keyof S
  ? { [key: string]: unknown }
  : Simplify<
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

/**
 * Field builders for `defineMessage`: `{ x: f.float32, name: f.string }`.
 * Scalars are constants; the rest are functions. Each field fixes both the
 * TypeScript type and the bytes on the wire, so pick the smallest that
 * fits (see docs/guides/messages.md#declaring-messages).
 *
 * Numbers are converted as they are sent, so the receiver gets the
 * converted value: integer fields drop the fraction (toward zero) and
 * saturate at their range, and there is no error for a value out of range.
 */
export const f = {
  /** A `number`, sent as an integer in −128…127. */
  int8: scalar("int8"),
  /** A `number`, sent as an integer in −32,768…32,767. */
  int16: scalar("int16"),
  /** A `number`, sent as a signed 32-bit integer. */
  int32: scalar("int32"),
  /** A `number`, sent as an integer in 0…255. */
  uint8: scalar("uint8"),
  /** A `number`, sent as an integer in 0…65,535. */
  uint16: scalar("uint16"),
  /** A `number`, sent as an integer in 0…4,294,967,295. */
  uint32: scalar("uint32"),
  /**
   * A `number`, rounded to single precision (about 7 significant digits).
   * NaN and ±Infinity pass through.
   */
  float32: scalar("float32"),
  /** A `number`, sent exactly (NaN, ±Infinity and −0 included). */
  float64: scalar("float64"),
  /**
   * A `string`, sent as UTF-8. A lone surrogate or U+0000 arrives as
   * U+FFFD, since some clients' strings can't hold them.
   */
  string: scalar("string"),
  /** A `boolean`. */
  bool: scalar("bool"),

  /**
   * Lossy fixed-point number with `decimals` places (0–9): sent as the
   * signed 32-bit integer `round(value * 10^decimals)`, rounding half
   * away from zero and saturating at the int32 range, so `f.fixed(2)`
   * holds up to ±21,474,836.47. Smaller than a float for values that need
   * only a few decimals (positions, angles).
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

  /** A list of `of` values: `f.array(f.uint8)` is a `number[]`. */
  array<E extends Field>(of: E): ArrayField<E> {
    return Object.freeze({ kind: "array", of })
  },

  /**
   * An object with **string** keys and `of` values:
   * `f.map(f.int32)` is `{ [key: string]: number }`. The key `__proto__`
   * is refused on receipt.
   */
  map<E extends Field>(of: E): MapField<E> {
    return Object.freeze({ kind: "map", of })
  },

  /**
   * A field that may be left out: its property becomes `?:`. Absent means
   * not present in the received object, never `null`. Can't wrap another
   * `optional`.
   */
  optional<E extends Field>(of: E): OptionalField<E> {
    return Object.freeze({ kind: "optional", of })
  },

  /** Another declared message, inline: its payload becomes this field. */
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
 * Declares a message: its name, and its fields built with {@link f}. The
 * fields' order is the order on the wire, where nothing names a field, so
 * reordering, renaming or retyping them changes the contract (a client
 * built against the old one fails its join with `CONTRACT_MISMATCH`).
 *
 * ```ts
 * const Move = defineMessage("move", { x: f.float32, y: f.float32 })
 * ```
 *
 * Field names should be identifiers (code generation emits them as class
 * members for other clients) and must not be integer-like, since JS would
 * reorder those keys and break the wire order. Integer-like names are
 * rejected at compile time and, once, at definition time: this throws a
 * `TypeError` while the module defining the message loads. That is a
 * deliberate exception to the framework's no-throw rule: it is a static
 * programming error, never a runtime condition.
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

/**
 * Typed join and create options (see docs/guides/options.md). Each is a
 * message declaration; one left out is the message with no fields.
 * Declaring neither keeps options untyped.
 */
export interface ContractOptions {
  /** Settings for a room a join creates (map, round count, …). */
  readonly create?: MessageDef
  /** What each joiner tells the room about itself (name, team, …). */
  readonly join?: MessageDef
}

/**
 * A room's typed messages, in both directions, from `defineContract`.
 * Server and client import the same object: it types `send`/`onMessage`
 * on both ends, and its hash, sent with every join, turns a stale client
 * into a `CONTRACT_MISMATCH` instead of a misread message.
 */
export interface Contract {
  /** Messages clients send and the room receives, by name. */
  readonly client: MessageMap
  /** Messages the room sends and clients receive, by name. */
  readonly server: MessageMap
  /** Typed join/create options, if any; without them options are untyped. */
  readonly options?: ContractOptions
}

/** Default when a Room/IRoom binds no contract: no typed messages at all. */
export interface EmptyContract {
  /** No client messages: only `sendRaw` works. */
  readonly client: Record<never, never>
  /** No server messages: only `onMessageRaw` receives anything. */
  readonly server: Record<never, never>
}

/** Messages the server sends (and the client receives). */
export type SendMap<C extends Contract> = C["server"]
/** Messages the server receives (and the client sends). */
export type RecvMap<C extends Contract> = C["client"]

// ---------------------------------------------------------------------------
// Options (spec §4.1.2)
// ---------------------------------------------------------------------------

/**
 * True when the contract declares typed options: a create-options message,
 * a join-options message, or both.
 */
export type HasTypedOptions<C> = C extends {
  readonly options: { readonly create: MessageDef }
}
  ? true
  : C extends { readonly options: { readonly join: MessageDef } }
    ? true
    : false

/** The declared options message of one kind, or `never`. */
type OptionsMessage<C, K extends keyof ContractOptions> = C extends {
  readonly options: { readonly [P in K]: infer M extends MessageDef }
}
  ? M
  : never

/** Options of a room type whose contract declares none: any object. */
export type UntypedOptions = { [key: string]: unknown }

/** The options of a kind the contract leaves out: the empty message. */
export type NoOptions = Record<never, never>

type InferOptions<C, K extends keyof ContractOptions> =
  HasTypedOptions<C> extends true
    ? [OptionsMessage<C, K>] extends [never]
      ? NoOptions
      : Infer<OptionsMessage<C, K>>
    : UntypedOptions

/**
 * The join options a room's `onAuth`/`onJoin` receive: the declared
 * message's payload, `{}` when only create options are declared, or an
 * untyped object when the contract declares none.
 */
export type InferJoinOptions<C> = InferOptions<C, "join">

/** The create options `onCreate` receives (see {@link InferJoinOptions}). */
export type InferCreateOptions<C> = InferOptions<C, "create">

/**
 * What a client passes to `create`/`joinOrCreate` for a contract with typed
 * options: the join options alone, or `{ create, join }` when the contract
 * declares create options (`join` may then be left out if it isn't
 * declared).
 */
export type CreateArg<C> = [OptionsMessage<C, "create">] extends [never]
  ? InferJoinOptions<C>
  : Simplify<
      { readonly create: InferCreateOptions<C> } & ([
        OptionsMessage<C, "join">,
      ] extends [never]
        ? { readonly join?: NoOptions }
        : { readonly join: InferJoinOptions<C> })
    >

/** A contract that declares typed options. */
export type TypedOptionsContract = Contract &
  (
    | { readonly options: { readonly create: MessageDef } }
    | { readonly options: { readonly join: MessageDef } }
  )

/** A contract that declares no options (untyped, as before options existed). */
export type UntypedOptionsContract = Contract & {
  readonly options?: { readonly create?: undefined; readonly join?: undefined }
}

/** Requires each map key to equal its message's `name`. */
type KeysMatchNames<M> = {
  [K in keyof M]: M[K] extends MessageDef<K & string>
    ? M[K]
    : MessageDef<K & string>
}

/**
 * Declares a contract. Keys must equal the message names, so the name used
 * at call sites is always the name on the wire:
 * `defineContract({ client: { playerMove: PlayerMove } })`. Typed join and
 * create options are messages too:
 * `options: { join: defineMessage("joinOptions", { name: f.string }) }`.
 */
export function defineContract<const C extends Contract>(
  contract: C & {
    readonly client: KeysMatchNames<C["client"]>
    readonly server: KeysMatchNames<C["server"]>
  },
): C {
  return Object.freeze(contract)
}
