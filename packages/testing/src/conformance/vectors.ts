/**
 * Reading and writing the language-neutral conformance vectors
 * (`conformance/v1/*.json`, PROTOCOL.md §14): the JSON conventions for
 * numbers JSON can't hold, message declarations, and value comparison.
 * Shared by the runner (`conformance.test.ts`) and the generator
 * (`generate.ts`).
 */
import {
  defineMessage,
  type Field,
  type FixedDecimals,
  f,
  type MessageDef,
} from "@bungohan/types"

export const VECTOR_DIR = new URL(
  "../../../../conformance/v1/",
  import.meta.url,
)

export interface VectorFile {
  readonly name: string
  readonly description: string
  readonly generated: boolean
  readonly cases: readonly Record<string, unknown>[]
}

// ---------------------------------------------------------------------------
// Numbers: {"f64": "<16 hex digits>"} for NaN, ±Infinity and -0
// ---------------------------------------------------------------------------

function isF64(value: unknown): value is { f64: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    typeof Reflect.get(value, "f64") === "string"
  )
}

function fromBits(hex: string): number {
  const view = new DataView(new ArrayBuffer(8))
  view.setBigUint64(0, BigInt(`0x${hex}`))
  return view.getFloat64(0)
}

function toBits(value: number): string {
  const view = new DataView(new ArrayBuffer(8))
  view.setFloat64(0, value)
  return view.getBigUint64(0).toString(16).padStart(16, "0")
}

/** JSON.parse reviver: `{"f64": …}` → the number. */
export function revive(_key: string, value: unknown): unknown {
  return isF64(value) ? fromBits(value.f64) : value
}

/** Replaces numbers JSON can't hold with `{"f64": …}` (for writing). */
export function toJson(value: unknown): unknown {
  if (typeof value === "number") {
    return Number.isFinite(value) && !Object.is(value, -0)
      ? value
      : { f64: toBits(value) }
  }
  if (Array.isArray(value)) return value.map(toJson)
  if (value instanceof Uint8Array) return Array.from(value)
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) {
      if (entry !== undefined) out[key] = toJson(entry)
    }
    return out
  }
  return value
}

// ---------------------------------------------------------------------------
// Hex
// ---------------------------------------------------------------------------

export function fromHex(hex: string): Uint8Array<ArrayBuffer> {
  const clean = hex.replace(/\s+/g, "")
  if (!/^(?:[0-9a-f]{2})*$/.test(clean)) throw new Error(`bad hex "${hex}"`)
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
}

/** Normalizes a hex string for comparison (drops the spaces). */
export function hexOf(hex: string): string {
  return hex.replace(/\s+/g, "")
}

// ---------------------------------------------------------------------------
// Message declarations
// ---------------------------------------------------------------------------

const SCALARS: Readonly<Record<string, Field>> = {
  int8: f.int8,
  int16: f.int16,
  int32: f.int32,
  uint8: f.uint8,
  uint16: f.uint16,
  uint32: f.uint32,
  float32: f.float32,
  float64: f.float64,
  string: f.string,
  bool: f.bool,
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isDecimals(value: number): value is FixedDecimals {
  return Number.isInteger(value) && value >= 0 && value <= 9
}

/** A field type of a declaration (PROTOCOL.md §14) → a descriptor. */
export function fieldOf(type: unknown): Field {
  if (typeof type === "string") {
    if (type.startsWith("fixed:")) {
      const decimals = Number(type.slice(6))
      if (!isDecimals(decimals)) throw new Error(`bad type ${type}`)
      return f.fixed(decimals)
    }
    const scalar = SCALARS[type]
    if (scalar === undefined) throw new Error(`unknown type ${type}`)
    return scalar
  }
  if (!isRecord(type)) throw new Error(`bad type ${JSON.stringify(type)}`)
  const values = type["enum"]
  if (Array.isArray(values)) {
    return f.enum(
      ...values.filter(
        (v): v is string | number =>
          typeof v === "string" || typeof v === "number",
      ),
    )
  }
  if ("array" in type) return f.array(fieldOf(type["array"]))
  if ("map" in type) return f.map(fieldOf(type["map"]))
  if ("optional" in type) return f.optional(fieldOf(type["optional"]))
  if ("nested" in type) return f.nested(messageOf(type["nested"]))
  throw new Error(`bad type ${JSON.stringify(type)}`)
}

/** `{ name, fields: [[name, type], …] }` → a message descriptor. */
export function messageOf(decl: unknown): MessageDef {
  if (!isRecord(decl) || typeof decl["name"] !== "string") {
    throw new Error("bad message declaration")
  }
  const fields: Record<string, Field> = {}
  const list = decl["fields"]
  if (!Array.isArray(list)) throw new Error("bad message fields")
  for (const entry of list) {
    if (!Array.isArray(entry) || typeof entry[0] !== "string") {
      throw new Error("bad message field")
    }
    fields[entry[0]] = fieldOf(entry[1])
  }
  return defineMessage(decl["name"], fields)
}

/** A descriptor → its declaration (for the generator). */
export function declarationOf(def: MessageDef): unknown {
  return {
    name: def.name,
    fields: def.fieldNames.map((name) => {
      const field = def.fields[name]
      if (field === undefined) throw new Error("missing field")
      return [name, typeOf(field)]
    }),
  }
}

function typeOf(field: Field): unknown {
  switch (field.kind) {
    case "fixed":
      return `fixed:${field.decimals}`
    case "enum":
      return { enum: [...field.values] }
    case "array":
      return { array: typeOf(field.of) }
    case "map":
      return { map: typeOf(field.of) }
    case "optional":
      return { optional: typeOf(field.of) }
    case "nested":
      return { nested: declarationOf(field.message) }
    default:
      return field.kind
  }
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

/**
 * JSON view of a decoded value: `undefined` array elements (absent
 * optionals) become `null`, `undefined` properties are dropped.
 */
export function normalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((v) => (v === undefined ? null : normalize(v)))
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) {
      if (entry !== undefined) out[key] = normalize(entry)
    }
    return out
  }
  return value
}

/**
 * Deep equality where numbers compare with `Object.is` (NaN equals NaN,
 * -0 differs from 0). Returns a path to the first difference, or undefined.
 */
export function difference(
  actual: unknown,
  expected: unknown,
  path = "$",
): string | undefined {
  if (typeof expected === "number" || typeof actual === "number") {
    return Object.is(actual, expected)
      ? undefined
      : `${path}: ${String(actual)} ≠ ${String(expected)}`
  }
  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual)) {
      return `${path}: array vs non-array`
    }
    if (actual.length !== expected.length) {
      return `${path}: length ${actual.length} ≠ ${expected.length}`
    }
    for (let i = 0; i < expected.length; i++) {
      const diff = difference(actual[i], expected[i], `${path}[${i}]`)
      if (diff !== undefined) return diff
    }
    return undefined
  }
  if (isRecord(expected) || isRecord(actual)) {
    if (!isRecord(expected) || !isRecord(actual)) {
      return `${path}: object vs non-object`
    }
    const keys = new Set([...Object.keys(actual), ...Object.keys(expected)])
    for (const key of keys) {
      const diff = difference(actual[key], expected[key], `${path}.${key}`)
      if (diff !== undefined) return diff
    }
    return undefined
  }
  return actual === expected
    ? undefined
    : `${path}: ${JSON.stringify(actual)} ≠ ${JSON.stringify(expected)}`
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/** Every vector file, in name order. */
export async function loadVectors(): Promise<VectorFile[]> {
  const glob = new Bun.Glob("*.json")
  const names = [...glob.scanSync({ cwd: VECTOR_DIR.pathname })].sort()
  const files: VectorFile[] = []
  for (const name of names) {
    const text = await Bun.file(new URL(name, VECTOR_DIR)).text()
    const parsed: unknown = JSON.parse(text, revive)
    if (!isRecord(parsed) || !Array.isArray(parsed["cases"])) {
      throw new Error(`${name}: not a vector file`)
    }
    files.push({
      name,
      description: String(parsed["description"] ?? ""),
      generated: parsed["generated"] === true,
      cases: parsed["cases"].filter(isRecord),
    })
  }
  return files
}
