/**
 * Canonical layout strings, contract hashes and definition-time checks for
 * message contracts (spec §6.7.4). Hashes are computed in TypeScript only
 * (by the server and by codegen); other clients compare them as strings.
 */
import type { Contract, Field, MessageDef, MessageMap } from "./contract"
import { isIntegerLikeKey } from "./contract"
import { isIntKind } from "./ints"

/** Canonical type token of a field (see the grammar in spec §6.7.4). */
function fieldLayout(field: Field): string {
  switch (field.kind) {
    case "fixed":
      return `fixed:${field.decimals}`
    case "enum":
      return `enum[${field.values.map((v) => JSON.stringify(v)).join("|")}]`
    case "array":
    case "map":
    case "optional":
      return `${field.kind}<${fieldLayout(field.of)}>`
    case "nested":
      return `nested<${messageLayout(field.message)}>`
    default:
      return field.kind
  }
}

/** `name(field:type,…)`, fields in wire order. */
export function messageLayout(def: MessageDef): string {
  const fields: string[] = []
  for (const name of def.fieldNames) {
    const field = def.fields[name]
    if (field !== undefined) fields.push(`${name}:${fieldLayout(field)}`)
  }
  return `${def.name}(${fields.join(",")})`
}

function mapLayout(map: MessageMap): string {
  return Object.values(map)
    .map(messageLayout)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .join(";")
}

/**
 * `client{…}server{…}`, messages sorted, so the hash doesn't depend on the
 * contract's key order (ids do, but ids are resolved by name).
 */
export function contractLayout(contract: Contract): string {
  return `client{${mapLayout(contract.client)}}server{${mapLayout(contract.server)}}`
}

const encoder = new TextEncoder()

/** FNV-1a 32-bit over the UTF-8 bytes of `text`, as 8 lowercase hex digits. */
export function fnv1a32(text: string): string {
  let hash = 0x811c9dc5
  for (const byte of encoder.encode(text)) {
    hash ^= byte
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, "0")
}

/** The contract hash carried by `JOIN` and `JOIN_SUCCESS`. */
export function contractHash(contract: Contract): string {
  return fnv1a32(contractLayout(contract))
}

// ---------------------------------------------------------------------------
// Definition-time validation
// ---------------------------------------------------------------------------

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function fieldProblems(
  field: unknown,
  path: string,
  seen: Set<unknown>,
  parentOptional: boolean,
): string[] {
  if (!isRecord(field)) return [`${path}: not a field descriptor`]
  const kind = field["kind"]
  if (typeof kind !== "string") return [`${path}: not a field descriptor`]
  switch (kind) {
    case "float32":
    case "float64":
    case "string":
    case "bool":
      return []
    case "fixed": {
      const d = field["decimals"]
      return typeof d === "number" && Number.isInteger(d) && d >= 0 && d <= 9
        ? []
        : [`${path}: fixed decimals must be an integer 0..9`]
    }
    case "enum": {
      const values = field["values"]
      if (!Array.isArray(values) || values.length === 0) {
        return [`${path}: enum needs at least one value`]
      }
      const ok = values.every(
        (v) =>
          typeof v === "string" ||
          (typeof v === "number" && Number.isFinite(v)),
      )
      if (!ok) return [`${path}: enum values must be strings or finite numbers`]
      return new Set(values).size === values.length
        ? []
        : [`${path}: enum values must be distinct`]
    }
    case "array":
    case "map":
      return fieldProblems(field["of"], `${path}<${kind}>`, seen, false)
    case "optional":
      if (parentOptional) return [`${path}: optional inside optional`]
      return fieldProblems(field["of"], path, seen, true)
    case "nested":
      return messageProblems(field["message"], path, seen)
    default:
      return isIntKind(kind) ? [] : [`${path}: unknown field kind "${kind}"`]
  }
}

function messageProblems(
  def: unknown,
  path: string,
  seen: Set<unknown>,
): string[] {
  if (!isRecord(def) || def["kind"] !== "message") {
    return [`${path}: not a message (use defineMessage)`]
  }
  if (seen.has(def)) return []
  seen.add(def)
  const problems: string[] = []
  const name = def["name"]
  if (typeof name !== "string" || name === "") {
    problems.push(`${path}: message name must be a non-empty string`)
  }
  const fields = def["fields"]
  const fieldNames = def["fieldNames"]
  if (!isRecord(fields) || !Array.isArray(fieldNames)) {
    return [...problems, `${path}: malformed message (use defineMessage)`]
  }
  const keys = Object.keys(fields)
  if (
    keys.length !== fieldNames.length ||
    keys.some((key, i) => key !== fieldNames[i])
  ) {
    problems.push(`${path}: fieldNames don't match fields`)
  }
  for (const key of keys) {
    const at = `${path}.${key}`
    if (!IDENTIFIER.test(key) || isIntegerLikeKey(key)) {
      problems.push(`${at}: field names must be identifiers`)
    }
    problems.push(...fieldProblems(fields[key], at, seen, false))
  }
  return problems
}

/**
 * Everything wrong with a contract, or `[]`. Checks what the types can't
 * (anything built with casts or from plain JS): each entry is a message
 * whose name equals its key, every field descriptor is well formed, field
 * names are identifiers. Core runs this once per room type, at definition.
 */
export function validateContract(contract: unknown): string[] {
  if (!isRecord(contract)) return ["contract: not an object"]
  const problems: string[] = []
  for (const side of ["client", "server"] as const) {
    const map = contract[side]
    if (!isRecord(map)) {
      problems.push(`contract.${side}: missing message map`)
      continue
    }
    for (const key of Object.keys(map)) {
      const def = map[key]
      const path = `${side}.${key}`
      problems.push(...messageProblems(def, path, new Set()))
      if (isRecord(def) && def["name"] !== key) {
        problems.push(`${path}: key must equal the message name`)
      }
    }
  }
  return problems
}
