/**
 * Positional encoding of contract messages (spec §4.1, §8.1.1), Phase 1.
 *
 * `packMessage` turns a payload into a plain array in `fieldNames` order
 * (no key strings on the wire); `unpackMessage` turns it back. The arrays
 * are then encoded by the active `ISerializer` inside the envelope, so the
 * same code serves MessagePack and JSON.
 *
 * Decoding is *type-directed*: every value is read as its declared kind, so
 * a handler typed `{ x: number }` can only ever receive a number. That is
 * frame integrity, not payload validation: range and game-logic checks stay
 * in handlers (spec §4.1).
 */
import { err, ok, type Result } from "@bungohan/result"
import {
  type Field,
  fromFixed,
  type Infer,
  isIntKind,
  isIntOf,
  type MessageDef,
  toFixed,
  toInt,
} from "@bungohan/types"
import { SerializerError } from "./errors"

/**
 * Per-field wire form:
 *
 * | Field               | Wire value                                        |
 * |---------------------|---------------------------------------------------|
 * | `f.int8`…`f.uint32` | integer, truncated and saturated to the range     |
 * | `f.float32`         | `Math.fround(value)`                              |
 * | `f.float64`         | the number                                        |
 * | `f.fixed(n)`        | int32 per spec §5.7.6.1                           |
 * | `f.string`/`f.bool` | the value                                         |
 * | `f.enum(...)`       | index into `values`                               |
 * | `f.array(X)`        | array of X                                        |
 * | `f.map(X)`          | string-keyed map of X                             |
 * | `f.optional(X)`     | X, or `null` when absent                          |
 * | `f.nested(M)`       | M's own positional array                          |
 *
 * At message level, trailing absent optionals are trimmed, so a message
 * whose optional tail is unset costs nothing for it.
 */
type Packed = unknown

/** Sentinel for a failed pack/unpack; carries where and why. */
class Bad {
  public readonly path: string
  public readonly message: string

  public constructor(path: string, message: string) {
    this.path = path
    this.message = message
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function packField(field: Field, value: unknown, path: string): Packed | Bad {
  switch (field.kind) {
    case "float64":
      return typeof value === "number" ? value : new Bad(path, "not a number")
    case "float32":
      return typeof value === "number"
        ? Math.fround(value)
        : new Bad(path, "not a number")
    case "fixed":
      return typeof value === "number"
        ? toFixed(value, field.decimals)
        : new Bad(path, "not a number")
    case "string":
      return typeof value === "string" ? value : new Bad(path, "not a string")
    case "bool":
      return typeof value === "boolean" ? value : new Bad(path, "not a bool")
    case "enum": {
      const index =
        typeof value === "string" || typeof value === "number"
          ? field.values.indexOf(value)
          : -1
      return index < 0 ? new Bad(path, "not one of the enum values") : index
    }
    case "array": {
      if (!Array.isArray(value)) return new Bad(path, "not an array")
      const out: Packed[] = []
      for (let i = 0; i < value.length; i++) {
        const item = packField(field.of, value[i], `${path}[${i}]`)
        if (item instanceof Bad) return item
        out.push(item)
      }
      return out
    }
    case "map": {
      if (!isRecord(value)) return new Bad(path, "not an object")
      const out: Record<string, Packed> = {}
      for (const key of Object.keys(value)) {
        const item = packField(field.of, value[key], `${path}.${key}`)
        if (item instanceof Bad) return item
        out[key] = item
      }
      return out
    }
    case "optional":
      return value === undefined || value === null
        ? null
        : packField(field.of, value, path)
    case "nested":
      return packFields(field.message, value, path)
    default:
      if (isIntKind(field.kind)) {
        return typeof value === "number"
          ? toInt(value, field.kind)
          : new Bad(path, "not a number")
      }
      return new Bad(path, `unknown field kind "${field.kind}"`)
  }
}

function packFields(
  def: MessageDef,
  payload: unknown,
  path: string,
): Packed[] | Bad {
  if (!isRecord(payload)) return new Bad(path, "not an object")
  const out: Packed[] = []
  for (const name of def.fieldNames) {
    const field = def.fields[name]
    if (field === undefined) continue
    const value = packField(field, payload[name], `${path}.${name}`)
    if (value instanceof Bad) return value
    out.push(value)
  }
  // Trim the trailing absent optionals.
  let length = out.length
  while (length > 0 && out[length - 1] === null) {
    const name = def.fieldNames[length - 1]
    if (name === undefined || def.fields[name]?.kind !== "optional") break
    length--
  }
  out.length = length
  return out
}

/**
 * Encodes a contract message positionally. Fails only on a payload that got
 * past the types, e.g. an enum value not in the list.
 */
export function packMessage<M extends MessageDef>(
  def: M,
  // Infer M from the descriptor only, never backwards through the payload.
  payload: NoInfer<Infer<M>>,
): Result<Packed[], SerializerError> {
  const input: unknown = payload
  return packAny(def, input)
}

/**
 * {@link packMessage} for callers holding a payload the types have already
 * checked elsewhere (core's `Room.send`, whose signature is the typed one).
 * Same encoding; a payload that doesn't match is `ENCODE_FAILED`.
 */
export function packUnknownMessage(
  def: MessageDef,
  payload: unknown,
): Result<Packed[], SerializerError> {
  return packAny(def, payload)
}

function packAny(
  def: MessageDef,
  payload: unknown,
): Result<Packed[], SerializerError> {
  const packed = packFields(def, payload, def.name)
  return packed instanceof Bad
    ? err(
        new SerializerError(
          "ENCODE_FAILED",
          `${packed.path}: ${packed.message}`,
          packed.path,
        ),
      )
    : ok(packed)
}

// ---------------------------------------------------------------------------

function unpackField(field: Field, wire: unknown, path: string): unknown {
  switch (field.kind) {
    case "float64":
      return typeof wire === "number" ? wire : new Bad(path, "expected number")
    case "float32":
      return typeof wire === "number"
        ? Math.fround(wire)
        : new Bad(path, "expected number")
    case "fixed":
      return isIntOf(wire, "int32")
        ? fromFixed(wire, field.decimals)
        : new Bad(path, "expected an int32")
    case "string":
      return typeof wire === "string" ? wire : new Bad(path, "expected string")
    case "bool":
      return typeof wire === "boolean" ? wire : new Bad(path, "expected bool")
    case "enum": {
      const value =
        typeof wire === "number" && Number.isInteger(wire)
          ? field.values[wire]
          : undefined
      return value === undefined ? new Bad(path, "bad enum index") : value
    }
    case "array": {
      if (!Array.isArray(wire)) return new Bad(path, "expected array")
      const out: unknown[] = []
      for (let i = 0; i < wire.length; i++) {
        const item = unpackField(field.of, wire[i], `${path}[${i}]`)
        if (item instanceof Bad) return item
        out.push(item)
      }
      return out
    }
    case "map": {
      if (!isRecord(wire)) return new Bad(path, "expected map")
      const out: Record<string, unknown> = {}
      for (const key of Object.keys(wire)) {
        // Assigning it would replace `out`'s prototype (JSON.parse creates
        // it as an own key; MessagePack already refuses it).
        if (key === "__proto__") return new Bad(path, "forbidden key")
        const item = unpackField(field.of, wire[key], `${path}.${key}`)
        if (item instanceof Bad) return item
        out[key] = item
      }
      return out
    }
    case "optional":
      return wire === null || wire === undefined
        ? undefined
        : unpackField(field.of, wire, path)
    case "nested":
      return unpackFields(field.message, wire, path)
    default:
      if (isIntKind(field.kind)) {
        return isIntOf(wire, field.kind)
          ? wire
          : new Bad(path, `expected ${field.kind}`)
      }
      return new Bad(path, `unknown field kind "${field.kind}"`)
  }
}

function unpackFields(
  def: MessageDef,
  wire: unknown,
  path: string,
): Record<string, unknown> | Bad {
  if (!Array.isArray(wire)) return new Bad(path, "expected positional array")
  const names = def.fieldNames
  if (wire.length > names.length) return new Bad(path, "too many fields")
  const out: Record<string, unknown> = {}
  for (let i = 0; i < names.length; i++) {
    const name = names[i]
    const field = name === undefined ? undefined : def.fields[name]
    if (name === undefined || field === undefined) continue
    // Past the end of the array: only a trimmed optional may be missing.
    const value = unpackField(field, wire[i], `${path}.${name}`)
    if (value instanceof Bad) return value
    if (value !== undefined) out[name] = value
  }
  return out
}

/**
 * Decodes a positional message. Every field is read as its declared kind;
 * anything else is `DECODE_FAILED` and must never reach a handler.
 * Absent optionals are left out of the result (`key?:`).
 */
export function unpackMessage<M extends MessageDef>(
  def: M,
  wire: unknown,
): Result<Infer<M>, SerializerError> {
  const result = unpackFields(def, wire, def.name)
  if (result instanceof Bad) {
    return err(
      new SerializerError(
        "DECODE_FAILED",
        `${result.path}: ${result.message}`,
        result.path,
      ),
    )
  }
  // The type-directed walk above built exactly the shape `Infer<M>`
  // describes. TypeScript can't follow a descriptor walk, and relating a
  // plain object to `Infer<M>` for an unresolved `M` recurses without end
  // (TS2589), so the value goes through `unknown`.
  const payload: unknown = result
  return ok(payload as Infer<M>)
}
