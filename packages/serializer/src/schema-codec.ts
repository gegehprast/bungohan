/**
 * The `schema` codec: tag-free binary state ops and contract messages.
 * PROTOCOL.md §13.1 is the authoritative byte layout; this file implements
 * it, and `conformance/v1/` checks it byte for byte.
 *
 * Browser-safe: no Bun/Node APIs (client-js uses this too).
 */
import { err, ok, type Result } from "@bungohan/result"
import {
  type Field,
  fromFixed,
  type INT_RANGE,
  type Infer,
  isCollectionField,
  isIntKind,
  isIntOf,
  type KeyFieldType,
  type MessageDef,
  type ParsedFieldType,
  parseFieldType,
  type SchemaTable,
  toFixed,
  toInt,
  type WireOp,
  type WireValue,
} from "@bungohan/types"
import { ByteReader, ByteWriter } from "./bytes"
import { SerializerError } from "./errors"
import {
  ClassTable,
  type IStateCodec,
  type IStateCodecSession,
  isWireOp,
} from "./state-codec"

// ===========================================================================
// State ops
// ===========================================================================

/** A class as the codec needs it: each field's parsed type. */
interface ClassLayout {
  readonly types: readonly ParsedFieldType[]
  /** Types of the collection fields, in field order (refIds R+1 … R+k). */
  readonly collections: readonly ParsedFieldType[]
}

/** What a refId denotes (PROTOCOL.md §13.1.2). */
type Target =
  | { readonly kind: "instance"; readonly layout: ClassLayout }
  | { readonly kind: "collection"; readonly type: ParsedFieldType }

type DefineOp = Extract<WireOp, readonly [4, ...unknown[]]>

const HEADER_S = 0x10
const F_ESCAPE = 15

function isUint32(value: unknown): value is number {
  return isIntOf(value, "uint32")
}

function isWireRef(value: unknown): value is [number, number] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    isUint32(value[0]) &&
    isUint32(value[1])
  )
}

function layoutOf(types: readonly string[]): ClassLayout | undefined {
  const parsed: ParsedFieldType[] = []
  for (const type of types) {
    const result = parseFieldType(type)
    if (result === undefined) return undefined
    parsed.push(result)
  }
  return {
    types: parsed,
    collections: parsed.filter(isCollectionField),
  }
}

/** Failure inside an encode or decode; carries the reason. */
class Fail {
  public readonly message: string

  public constructor(message: string) {
    this.message = message
  }
}

/**
 * The class and target tables of one stream, with an undo journal so a
 * failed encode or decode leaves the session as it was.
 */
class Tables {
  public readonly classes = new ClassTable()
  public readonly layouts: ClassLayout[] = []
  public readonly targets = new Map<number, Target>()
  private readonly _undo: [ref: number, previous: Target | undefined][] = []
  private _classMark = 0

  public begin(): void {
    this._undo.length = 0
    this._classMark = this.layouts.length
  }

  public rollback(): void {
    for (let i = this._undo.length - 1; i >= 0; i--) {
      const entry = this._undo[i]
      if (entry === undefined) continue
      const [ref, previous] = entry
      if (previous === undefined) this.targets.delete(ref)
      else this.targets.set(ref, previous)
    }
    this._undo.length = 0
    this.layouts.length = this._classMark
    this.classes.truncate(this._classMark)
  }

  /** Applies a DEFINE (shape-checked); a message if it's invalid. */
  public define(op: DefineOp): string | undefined {
    const known = this.classes.size
    const problem = this.classes.define(op)
    if (problem !== undefined) return problem
    if (this.classes.size === known) return undefined // a restatement
    const layout = layoutOf(op[4])
    if (layout === undefined) return `DEFINE ${op[1]}: unparseable type`
    this.layouts.push(layout)
    // The root is refId 0, an instance of classId 0 (PROTOCOL.md §11.3).
    if (op[1] === 0) this._bind(0, layout)
    return undefined
  }

  /** Binds `ref` (and its block) as an instance of `classId`. */
  public bindRef(classId: number, ref: number): string | undefined {
    const layout = this.layouts[classId]
    if (layout === undefined) return `ref to undefined classId ${classId}`
    if (ref + layout.collections.length > 0xffffffff) {
      return `refId block of ${ref} overflows`
    }
    this._bind(ref, layout)
    return undefined
  }

  private _bind(ref: number, layout: ClassLayout): void {
    this._set(ref, { kind: "instance", layout })
    let next = ref + 1
    for (const type of layout.collections) {
      this._set(next++, { kind: "collection", type })
    }
  }

  private _set(ref: number, target: Target): void {
    this._undo.push([ref, this.targets.get(ref)])
    this.targets.set(ref, target)
  }
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

/** Writes a primitive, integer or key value; a Fail if it doesn't fit. */
function writeScalar(
  out: ByteWriter,
  type: string,
  value: unknown,
): Fail | undefined {
  switch (type) {
    case "float64":
      if (typeof value !== "number") return new Fail("float64: not a number")
      out.float64(value)
      return undefined
    case "float32":
      if (typeof value !== "number") return new Fail("float32: not a number")
      out.float32(value)
      return undefined
    case "string":
      if (typeof value !== "string") return new Fail("string: not a string")
      out.string(value)
      return undefined
    case "bool":
      if (typeof value !== "boolean") return new Fail("bool: not a boolean")
      out.u8(value ? 1 : 0)
      return undefined
    default:
      if (type.startsWith("fixed:")) {
        if (!isIntOf(value, "int32")) return new Fail(`${type}: not an int32`)
        out.zigzag(value)
        return undefined
      }
      if (isIntKind(type)) {
        if (!isIntOf(value, type)) return new Fail(`${type}: out of range`)
        writeInt(out, type, value)
        return undefined
      }
      return new Fail(`unknown type ${type}`)
  }
}

function writeInt(out: ByteWriter, kind: string, value: number): void {
  switch (kind) {
    case "int8":
    case "uint8":
      out.u8(value & 0xff)
      return
    case "int16":
    case "int32":
      out.zigzag(value)
      return
    default:
      out.varint(value)
  }
}

/** Reads a primitive, integer or key value (range-checked). */
function readScalar(
  input: ByteReader,
  type: string,
): number | string | boolean {
  switch (type) {
    case "float64":
      return input.float64()
    case "float32":
      return input.float32()
    case "string":
      return input.string()
    case "bool": {
      const byte = input.u8()
      if (byte > 1) input.fail(`bool byte ${byte}`)
      return byte === 1
    }
    default:
      if (type.startsWith("fixed:")) return input.zigzag()
      if (isIntKind(type)) return readInt(input, type)
      input.fail(`unknown type ${type}`)
      return 0
  }
}

function readInt(input: ByteReader, kind: keyof typeof INT_RANGE): number {
  let value: number
  switch (kind) {
    case "int8":
      value = (input.u8() << 24) >> 24
      break
    case "uint8":
      value = input.u8()
      break
    case "int16":
    case "int32":
      value = input.zigzag()
      break
    default:
      value = input.varint()
  }
  if (!isIntOf(value, kind)) input.fail(`${kind} out of range: ${value}`)
  return value
}

// ---------------------------------------------------------------------------
// Op encoder
// ---------------------------------------------------------------------------

function encodeRef(
  out: ByteWriter,
  tables: Tables,
  value: unknown,
): Fail | number {
  if (!isWireRef(value)) return new Fail("expected a ref [classId, refId]")
  const problem = tables.bindRef(value[0], value[1])
  if (problem !== undefined) return new Fail(problem)
  out.varint(value[0])
  out.varint(value[1])
  return value[1]
}

/** Writes a field value; returns the ref it carried, if any. */
function encodeValue(
  out: ByteWriter,
  tables: Tables,
  type: ParsedFieldType,
  value: unknown,
): Fail | number | undefined {
  if (type.kind === "schema") return encodeRef(out, tables, value)
  if (type.kind === "primitive" || type.kind === "int") {
    return writeScalar(out, type.type, value)
  }
  return new Fail("a collection field has no value")
}

/** Writes a collection element; returns the ref it carried, if any. */
function encodeElement(
  out: ByteWriter,
  tables: Tables,
  type: ParsedFieldType,
  value: unknown,
): Fail | number | undefined {
  switch (type.kind) {
    case "map":
    case "array":
      return writeScalar(out, type.element, value)
    case "set":
      return writeScalar(out, type.element, value)
    case "schemaMap":
    case "schemaSet":
    case "schemaArray":
      return encodeRef(out, tables, value)
    default:
      return new Fail("not a collection")
  }
}

function encodeIndex(out: ByteWriter, index: unknown): Fail | undefined {
  if (!isUint32(index)) return new Fail("index must be a uint32")
  out.varint(index)
  return undefined
}

function keyType(type: ParsedFieldType): KeyFieldType | undefined {
  return type.kind === "map" || type.kind === "schemaMap" ? type.key : undefined
}

function isArray(type: ParsedFieldType): boolean {
  return type.kind === "array" || type.kind === "schemaArray"
}

function encodeDefine(
  out: ByteWriter,
  tables: Tables,
  op: WireOp,
): Fail | undefined {
  if (!isWireOp(op) || op[0] !== 4) return new Fail("malformed DEFINE")
  const problem = tables.define(op)
  if (problem !== undefined) return new Fail(problem)
  const [, classId, name, fields, types] = op
  out.u8(0x80)
  out.varint(classId)
  out.string(name)
  out.varint(fields.length)
  for (let i = 0; i < fields.length; i++) {
    out.string(fields[i] ?? "")
    out.string(types[i] ?? "")
  }
  return undefined
}

class OpEncoder {
  private readonly _out: ByteWriter
  private readonly _tables: Tables
  private _last = 0

  public constructor(out: ByteWriter, tables: Tables) {
    this._out = out
    this._tables = tables
  }

  public op(op: WireOp): Fail | undefined {
    const code: unknown = op[0]
    if (code === 4) return encodeDefine(this._out, this._tables, op)
    const ref: unknown = op[1]
    if (!isUint32(ref)) return new Fail("target must be a uint32 refId")
    const target = this._tables.targets.get(ref)
    if (target === undefined) return new Fail(`unknown target refId ${ref}`)
    const out = this._out
    const same = ref === this._last ? HEADER_S : 0

    // Header F: a SET on an instance carries its field index.
    let field = -1
    if (code === 0 && target.kind === "instance") {
      const index: unknown = op[2]
      if (!isUint32(index)) return new Fail("field index must be a uint32")
      if (index >= target.layout.types.length) {
        return new Fail(`field ${index} out of range`)
      }
      field = index
    }
    const f = field < 0 ? 0 : Math.min(field, F_ESCAPE)
    if (typeof code !== "number" || code < 0 || code > 3) {
      return new Fail(`unknown op code ${String(code)}`)
    }
    out.u8((code << 5) | same | f)
    if (same === 0) out.varint(ref)
    if (f === F_ESCAPE) out.varint(field - F_ESCAPE)

    const carried = this._payload(op, target, field)
    if (carried instanceof Fail) return carried
    this._last = carried ?? ref
    return undefined
  }

  /** Writes the op's payload; returns the ref it carried, if any. */
  private _payload(
    op: WireOp,
    target: Target,
    field: number,
  ): Fail | number | undefined {
    const out = this._out
    const tables = this._tables
    if (target.kind === "instance") {
      if (op[0] !== 0 || op.length !== 4) {
        return new Fail(`op ${op[0]} on a schema instance`)
      }
      const type = target.layout.types[field]
      if (type === undefined) return new Fail(`field ${field} out of range`)
      return encodeValue(out, tables, type, op[3])
    }

    const type = target.type
    switch (op[0]) {
      case 0: {
        if (!isArray(type) || op.length !== 4) {
          return new Fail("SET on a collection that isn't an array")
        }
        const bad = encodeIndex(out, op[2])
        return bad ?? encodeElement(out, tables, type, op[3])
      }
      case 1: {
        if (type.kind === "set" || type.kind === "schemaSet") {
          if (op.length !== 3) return new Fail("set ADD takes 3 elements")
          return encodeElement(out, tables, type, op[2])
        }
        if (op.length !== 4) return new Fail("ADD takes 4 elements")
        const key = keyType(type)
        const bad =
          key === undefined
            ? encodeIndex(out, op[2])
            : writeScalar(out, key, op[2])
        return bad ?? encodeElement(out, tables, type, op[3])
      }
      case 2: {
        if (op.length !== 3) return new Fail("REMOVE takes 3 elements")
        const key = keyType(type)
        if (key !== undefined) return writeScalar(out, key, op[2])
        if (isArray(type)) return encodeIndex(out, op[2])
        if (type.kind === "set") return writeScalar(out, type.element, op[2])
        // A schema set removes by element refId.
        return encodeIndex(out, op[2])
      }
      case 3:
        return op.length === 2 ? undefined : new Fail("CLEAR takes 2 elements")
      default:
        return new Fail(`unknown op code ${op[0]}`)
    }
  }
}

// ---------------------------------------------------------------------------
// Op decoder
// ---------------------------------------------------------------------------

class OpDecoder {
  private readonly _in: ByteReader
  private readonly _tables: Tables
  private _last = 0

  public constructor(input: ByteReader, tables: Tables) {
    this._in = input
    this._tables = tables
  }

  public op(): WireOp | undefined {
    const input = this._in
    const header = input.u8()
    const code = header >> 5
    const same = (header & HEADER_S) !== 0
    const f = header & 0x0f
    if (code === 4) {
      if (same || f !== 0) return this._fail("DEFINE with S or F set")
      return this._define()
    }
    if (code > 4) return this._fail(`unknown op code ${code}`)

    const ref = same ? this._last : input.varint()
    if (input.error !== undefined) return undefined
    const target = this._tables.targets.get(ref)
    if (target === undefined) return this._fail(`unknown target refId ${ref}`)

    if (target.kind === "instance") {
      if (code !== 0) return this._fail(`op ${code} on a schema instance`)
      const field = f === F_ESCAPE ? F_ESCAPE + input.varint() : f
      const type = target.layout.types[field]
      if (type === undefined) return this._fail(`field ${field} out of range`)
      const value = this._value(type)
      if (value === undefined) return undefined
      this._settle(ref, value)
      return [0, ref, field, value]
    }

    if (f !== 0) return this._fail("F must be 0 on a collection op")
    const type = target.type
    switch (code) {
      case 0: {
        if (!isArray(type)) return this._fail("SET on a non-array collection")
        const index = input.varint()
        const value = this._element(type)
        if (value === undefined) return undefined
        this._settle(ref, value)
        return [0, ref, index, value]
      }
      case 1: {
        if (type.kind === "set" || type.kind === "schemaSet") {
          const value = this._element(type)
          if (value === undefined) return undefined
          this._settle(ref, value)
          return [1, ref, value]
        }
        const key = keyType(type)
        const index =
          key === undefined ? input.varint() : readScalar(input, key)
        const value = this._element(type)
        if (value === undefined) return undefined
        this._settle(ref, value)
        return [1, ref, index, value]
      }
      case 2: {
        const key = keyType(type)
        let removed: number | string | boolean
        if (key !== undefined) removed = readScalar(input, key)
        else if (type.kind === "set") removed = readScalar(input, type.element)
        else removed = input.varint() // array index, or schema set refId
        if (input.error !== undefined) return undefined
        this._last = ref
        return [2, ref, removed]
      }
      default:
        this._last = ref
        return [3, ref]
    }
  }

  private _settle(ref: number, value: WireValue): void {
    this._last = Array.isArray(value) ? value[1] : ref
  }

  private _fail(message: string): undefined {
    this._in.fail(message)
    return undefined
  }

  private _ref(): WireValue | undefined {
    const input = this._in
    const classId = input.varint()
    const ref = input.varint()
    if (input.error !== undefined) return undefined
    const problem = this._tables.bindRef(classId, ref)
    if (problem !== undefined) return this._fail(problem)
    return [classId, ref]
  }

  private _value(type: ParsedFieldType): WireValue | undefined {
    if (type.kind === "schema") return this._ref()
    if (type.kind !== "primitive" && type.kind !== "int") {
      return this._fail("a collection field has no value")
    }
    const value = readScalar(this._in, type.type)
    return this._in.error === undefined ? value : undefined
  }

  private _element(type: ParsedFieldType): WireValue | undefined {
    switch (type.kind) {
      case "map":
      case "array":
      case "set": {
        const value = readScalar(this._in, type.element)
        return this._in.error === undefined ? value : undefined
      }
      case "schemaMap":
      case "schemaSet":
      case "schemaArray":
        return this._ref()
      default:
        return this._fail("not a collection")
    }
  }

  private _define(): WireOp | undefined {
    const input = this._in
    const classId = input.varint()
    const name = input.string()
    const count = input.count()
    const fields: string[] = []
    const types: string[] = []
    for (let i = 0; i < count && input.error === undefined; i++) {
      fields.push(input.string())
      types.push(input.string())
    }
    if (input.error !== undefined) return undefined
    const op: unknown = [4, classId, name, fields, types]
    if (!isWireOp(op) || op[0] !== 4) {
      return this._fail(`DEFINE ${classId}: a type outside the grammar`)
    }
    const problem = this._tables.define(op)
    return problem === undefined ? op : this._fail(problem)
  }
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

class SchemaSession implements IStateCodecSession {
  private readonly _tables = new Tables()
  private readonly _out: ByteWriter

  public constructor(out: ByteWriter) {
    this._out = out
  }

  public encodeOps(
    ops: readonly WireOp[],
  ): Result<Uint8Array<ArrayBuffer>, SerializerError> {
    const out = this._out
    out.reset()
    this._tables.begin()
    const encoder = new OpEncoder(out, this._tables)
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i]
      const failure: Fail | undefined = Array.isArray(op)
        ? encoder.op(op)
        : new Fail("not an op")
      if (failure !== undefined) {
        this._tables.rollback()
        return err(
          new SerializerError(
            "ENCODE_FAILED",
            `op #${i}: ${failure.message}`,
            op,
          ),
        )
      }
    }
    return ok(out.toBytes())
  }

  public decodeOps(data: Uint8Array): Result<WireOp[], SerializerError> {
    const input = new ByteReader(data)
    this._tables.begin()
    const decoder = new OpDecoder(input, this._tables)
    const ops: WireOp[] = []
    while (!input.done) {
      const op = decoder.op()
      if (op === undefined || input.error !== undefined) break
      ops.push(op)
    }
    if (input.error !== undefined) {
      this._tables.rollback()
      return err(
        new SerializerError(
          "DECODE_FAILED",
          `op #${ops.length}: ${input.error}`,
        ),
      )
    }
    return ok(ops)
  }

  public getTable(): SchemaTable {
    return this._tables.classes.toTable()
  }
}

// ===========================================================================
// Contract messages (PROTOCOL.md §13.1.6)
// ===========================================================================

/** Where a message field lives: flag bits and/or the value section. */
interface FieldPlan {
  readonly name: string
  readonly field: Field
  /** bool: its value bit. optional: its presence bit. Else -1. */
  readonly bit: number
  /** optional<bool>: its value bit. Else -1. */
  readonly valueBit: number
}

interface MessagePlan {
  readonly fields: readonly FieldPlan[]
  readonly flagBytes: number
  /** Mask of the used bits of the last flag byte (0xff if all). */
  readonly lastMask: number
}

const plans = new WeakMap<MessageDef, MessagePlan>()

function planOf(def: MessageDef): MessagePlan {
  const cached = plans.get(def)
  if (cached !== undefined) return cached
  const fields: FieldPlan[] = []
  let bits = 0
  for (const name of def.fieldNames) {
    const field = def.fields[name]
    if (field === undefined) continue
    if (field.kind === "bool") {
      fields.push({ name, field, bit: bits++, valueBit: -1 })
    } else if (field.kind === "optional") {
      const bit = bits++
      const valueBit = field.of.kind === "bool" ? bits++ : -1
      fields.push({ name, field, bit, valueBit })
    } else {
      fields.push({ name, field, bit: -1, valueBit: -1 })
    }
  }
  const used = bits % 8
  const plan: MessagePlan = {
    fields,
    flagBytes: Math.ceil(bits / 8),
    lastMask: used === 0 ? 0xff : (1 << used) - 1,
  }
  plans.set(def, plan)
  return plan
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isAbsent(value: unknown): boolean {
  return value === undefined || value === null
}

/** Writes one message value (not a message-level bool/optional). */
function writeField(
  out: ByteWriter,
  field: Field,
  value: unknown,
  path: string,
): Fail | undefined {
  switch (field.kind) {
    case "float64":
      if (typeof value !== "number") return new Fail(`${path}: not a number`)
      out.float64(value)
      return undefined
    case "float32":
      if (typeof value !== "number") return new Fail(`${path}: not a number`)
      out.float32(value)
      return undefined
    case "fixed":
      if (typeof value !== "number") return new Fail(`${path}: not a number`)
      out.zigzag(toFixed(value, field.decimals))
      return undefined
    case "string":
      if (typeof value !== "string") return new Fail(`${path}: not a string`)
      out.string(value)
      return undefined
    case "bool":
      if (typeof value !== "boolean") return new Fail(`${path}: not a bool`)
      out.u8(value ? 1 : 0)
      return undefined
    case "enum": {
      const index =
        typeof value === "string" || typeof value === "number"
          ? field.values.indexOf(value)
          : -1
      if (index < 0) return new Fail(`${path}: not one of the enum values`)
      out.varint(index)
      return undefined
    }
    case "array": {
      if (!Array.isArray(value)) return new Fail(`${path}: not an array`)
      out.varint(value.length)
      for (let i = 0; i < value.length; i++) {
        const bad = writeField(out, field.of, value[i], `${path}[${i}]`)
        if (bad !== undefined) return bad
      }
      return undefined
    }
    case "map": {
      if (!isRecord(value)) return new Fail(`${path}: not an object`)
      const keys = Object.keys(value)
      out.varint(keys.length)
      for (const key of keys) {
        out.string(key)
        const bad = writeField(out, field.of, value[key], `${path}.${key}`)
        if (bad !== undefined) return bad
      }
      return undefined
    }
    case "optional":
      // An array element or map value: a presence byte.
      if (isAbsent(value)) {
        out.u8(0)
        return undefined
      }
      out.u8(1)
      return writeField(out, field.of, value, path)
    case "nested":
      return writeMessage(out, field.message, value, path)
    default:
      if (isIntKind(field.kind)) {
        if (typeof value !== "number") return new Fail(`${path}: not a number`)
        writeInt(out, field.kind, toInt(value, field.kind))
        return undefined
      }
      return new Fail(`${path}: unknown field kind "${field.kind}"`)
  }
}

function writeMessage(
  out: ByteWriter,
  def: MessageDef,
  payload: unknown,
  path: string,
): Fail | undefined {
  if (!isRecord(payload)) return new Fail(`${path}: not an object`)
  const plan = planOf(def)
  const flagsAt = out.length
  for (let i = 0; i < plan.flagBytes; i++) out.u8(0)
  const flags = new Uint8Array(plan.flagBytes)
  const setBit = (bit: number): void => {
    const at = bit >> 3
    flags[at] = (flags[at] ?? 0) | (1 << (bit & 7))
  }
  for (const { name, field, bit, valueBit } of plan.fields) {
    const value = payload[name]
    const at = `${path}.${name}`
    if (field.kind === "bool") {
      if (typeof value !== "boolean") return new Fail(`${at}: not a bool`)
      if (value) setBit(bit)
      continue
    }
    if (field.kind === "optional") {
      if (isAbsent(value)) continue
      setBit(bit)
      if (valueBit >= 0) {
        if (typeof value !== "boolean") return new Fail(`${at}: not a bool`)
        if (value) setBit(valueBit)
        continue
      }
      const bad = writeField(out, field.of, value, at)
      if (bad !== undefined) return bad
      continue
    }
    const bad = writeField(out, field, value, at)
    if (bad !== undefined) return bad
  }
  for (let i = 0; i < plan.flagBytes; i++) out.patch(flagsAt + i, flags[i] ?? 0)
  return undefined
}

function readField(input: ByteReader, field: Field): unknown {
  switch (field.kind) {
    case "float64":
      return input.float64()
    case "float32":
      return input.float32()
    case "fixed":
      return fromFixed(input.zigzag(), field.decimals)
    case "string":
      return input.string()
    case "bool": {
      const byte = input.u8()
      if (byte > 1) input.fail(`bool byte ${byte}`)
      return byte === 1
    }
    case "enum": {
      const index = input.varint()
      const value = field.values[index]
      if (value === undefined) input.fail(`enum index ${index} out of range`)
      return value
    }
    case "array": {
      const count = input.count()
      const out: unknown[] = []
      for (let i = 0; i < count && input.error === undefined; i++) {
        out.push(readField(input, field.of))
      }
      return out
    }
    case "map": {
      const count = input.count()
      const out: Record<string, unknown> = {}
      for (let i = 0; i < count && input.error === undefined; i++) {
        const key = input.string()
        if (key === "__proto__") input.fail("forbidden map key __proto__")
        else if (Object.hasOwn(out, key)) input.fail(`duplicate map key`)
        const value = readField(input, field.of)
        if (input.error === undefined) out[key] = value
      }
      return out
    }
    case "optional": {
      const present = input.u8()
      if (present > 1) input.fail(`presence byte ${present}`)
      return present === 1 ? readField(input, field.of) : undefined
    }
    case "nested":
      return readMessage(input, field.message)
    default:
      if (isIntKind(field.kind)) return readInt(input, field.kind)
      input.fail(`unknown field kind "${field.kind}"`)
      return undefined
  }
}

function readMessage(
  input: ByteReader,
  def: MessageDef,
): Record<string, unknown> {
  const plan = planOf(def)
  const flags: number[] = []
  for (let i = 0; i < plan.flagBytes; i++) flags.push(input.u8())
  const last = flags[plan.flagBytes - 1]
  if (last !== undefined && (last & ~plan.lastMask) !== 0) {
    input.fail("flag padding bit set")
  }
  const bit = (index: number): boolean =>
    ((flags[index >> 3] ?? 0) & (1 << (index & 7))) !== 0
  const out: Record<string, unknown> = {}
  for (const { name, field, bit: flag, valueBit } of plan.fields) {
    if (input.error !== undefined) break
    if (field.kind === "bool") {
      out[name] = bit(flag)
    } else if (field.kind === "optional") {
      if (!bit(flag)) {
        if (valueBit >= 0 && bit(valueBit))
          input.fail("value bit of an absent optional")
        continue
      }
      out[name] = valueBit >= 0 ? bit(valueBit) : readField(input, field.of)
    } else {
      out[name] = readField(input, field)
    }
  }
  return out
}

// ===========================================================================
// Codec
// ===========================================================================

/**
 * The `schema` state codec (PROTOCOL.md §13.1), the default: tag-free
 * binary ops, and contract messages in the same layout family. Stateless;
 * each stream gets a session that owns its class and target tables.
 */
export class SchemaCodec implements IStateCodec {
  private readonly _out = new ByteWriter()

  public getName(): string {
    return "schema"
  }

  public createSession(): IStateCodecSession {
    // Sessions encode synchronously and copy out, so they can share one
    // scratch buffer.
    return new SchemaSession(this._out)
  }

  public encodeMessage(
    def: MessageDef,
    payload: unknown,
  ): Result<Uint8Array<ArrayBuffer>, SerializerError> {
    const out = this._out
    out.reset()
    const bad = writeMessage(out, def, payload, def.name)
    if (bad !== undefined) {
      return err(new SerializerError("ENCODE_FAILED", bad.message))
    }
    return ok(out.toBytes())
  }

  public decodeMessage<M extends MessageDef>(
    def: M,
    data: Uint8Array,
  ): Result<Infer<M>, SerializerError> {
    const input = new ByteReader(data)
    const message = readMessage(input, def)
    if (input.error === undefined && !input.done) {
      input.fail("trailing bytes after the message")
    }
    if (input.error !== undefined) {
      return err(
        new SerializerError("DECODE_FAILED", `${def.name}: ${input.error}`),
      )
    }
    // readMessage built exactly the shape Infer<M> describes (see
    // unpackMessage for why this goes through unknown).
    const payload: unknown = message
    return ok(payload as Infer<M>)
  }
}
