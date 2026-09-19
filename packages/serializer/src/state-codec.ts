/**
 * State-sync codecs (spec §8.1.2–8.1.5). A codec encodes the `WireOp[]`
 * stream produced by `@bungohan/state`; Phase 1 (this file) is MessagePack,
 * Phase 2 will be the tag-free `SchemaCodec` behind the same interface.
 */
import { err, ok, type Result } from "@bungohan/result"
import {
  parseFieldType,
  type SchemaClassEntry,
  type SchemaFieldType,
  type SchemaTable,
  type WireOp,
} from "@bungohan/types"
import { SerializerError } from "./errors"
import { MessagePackSerializer } from "./messagepack"

/**
 * A state codec. Stateless itself: each stream (a room on the server, a
 * joined room on a client) gets its own {@link IStateCodecSession}, because
 * the class table grows during a session and a tag-free codec needs it to
 * decode.
 */
export interface IStateCodec {
  /** Named in the join handshake so the client picks the matching codec. */
  getName(): string
  createSession(): IStateCodecSession
}

/**
 * One op stream. The session keeps its class table up to date from the
 * `DEFINE` ops it encodes or decodes, in stream order, so no table is ever
 * passed in (spec §5.7.11). A snapshot restating classes the session
 * already knows is fine; a `DEFINE` that contradicts one is an error.
 */
export interface IStateCodecSession {
  encodeOps(ops: readonly WireOp[]): Result<Uint8Array, SerializerError>
  /**
   * Frame-level decode: the result is well-formed `WireOp`s (right arity
   * and value types). Whether refs and field indices make sense for the
   * receiving tree is `applyDelta`'s job.
   */
  decodeOps(data: Uint8Array): Result<WireOp[], SerializerError>
  /** The table so far (a copy). */
  getTable(): SchemaTable
}

// ---------------------------------------------------------------------------
// Op shape checks
// ---------------------------------------------------------------------------

function isInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value)
}

function isKey(value: unknown): boolean {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
}

function isValue(value: unknown): boolean {
  return (
    isKey(value) ||
    (Array.isArray(value) &&
      value.length === 2 &&
      isInt(value[0]) &&
      isInt(value[1]))
  )
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string")
}

/** Structural check of one op: code, arity and value types. */
export function isWireOp(op: unknown): op is WireOp {
  if (!Array.isArray(op) || !isInt(op[0]) || !isInt(op[1])) return false
  switch (op[0]) {
    case 0:
      return op.length === 4 && isInt(op[2]) && isValue(op[3])
    case 1:
      return op.length === 3
        ? isValue(op[2])
        : op.length === 4 && isKey(op[2]) && isValue(op[3])
    case 2:
      return op.length === 3 && isKey(op[2])
    case 3:
      return op.length === 2
    case 4:
      return (
        op.length === 5 &&
        typeof op[2] === "string" &&
        isStringArray(op[3]) &&
        isStringArray(op[4]) &&
        op[3].length === op[4].length &&
        op[4].every((type) => parseFieldType(type) !== undefined)
      )
    default:
      return false
  }
}

// ---------------------------------------------------------------------------
// Class table
// ---------------------------------------------------------------------------

function sameEntry(a: SchemaClassEntry, b: SchemaClassEntry): boolean {
  return (
    a.name === b.name &&
    a.fields.length === b.fields.length &&
    a.fields.every((field, i) => field === b.fields[i]) &&
    a.types.every((type, i) => type === b.types[i])
  )
}

/** A session's class table, maintained from the `DEFINE`s in the stream. */
export class ClassTable {
  private readonly _classes: SchemaClassEntry[] = []

  /** The entry for `classId`, if defined. */
  public get(classId: number): SchemaClassEntry | undefined {
    return this._classes[classId]
  }

  public get size(): number {
    return this._classes.length
  }

  /**
   * Applies one `DEFINE` (already shape-checked). Class ids are assigned in
   * order, so a new class must take the next id; an existing id must be
   * restated identically (snapshots replay the whole table).
   */
  public define(
    op: Extract<WireOp, readonly [4, ...unknown[]]>,
  ): string | undefined {
    const [, classId, name, fields, types] = op
    const entry: SchemaClassEntry = {
      classId,
      name,
      fields: [...fields],
      types: [...types],
    }
    const existing = this._classes[classId]
    if (existing !== undefined) {
      return sameEntry(existing, entry)
        ? undefined
        : `DEFINE ${classId} (${name}) contradicts the known ${existing.name}`
    }
    if (classId !== this._classes.length) {
      return `DEFINE ${classId} (${name}) skips ahead of class ${this._classes.length}`
    }
    this._classes.push(entry)
    return undefined
  }

  public toTable(): SchemaTable {
    return {
      classes: this._classes.map((entry) => ({
        classId: entry.classId,
        name: entry.name,
        fields: [...entry.fields],
        types: [...(entry.types as SchemaFieldType[])],
      })),
    }
  }
}

/** Runs every `DEFINE` in `ops` through `table`; the first error, if any. */
function applyDefines(
  table: ClassTable,
  ops: readonly WireOp[],
): string | undefined {
  for (const op of ops) {
    if (op[0] !== 4) continue
    const problem = table.define(op)
    if (problem !== undefined) return problem
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Phase 1: MessagePack
// ---------------------------------------------------------------------------

/**
 * Phase 1 state codec (spec §8.1.3): the `WireOp[]` array encoded as-is with
 * MessagePack, so its output is byte-identical to `encode(ops)` and the
 * §11.1 bandwidth baselines apply to it directly. Inspectable without the
 * schema table, which is why it stays selectable permanently for debugging.
 */
export class MessagePackStateCodec implements IStateCodec {
  private readonly _serializer: MessagePackSerializer

  public constructor(serializer = new MessagePackSerializer()) {
    this._serializer = serializer
  }

  public getName(): string {
    return "messagepack"
  }

  public createSession(): IStateCodecSession {
    return new MessagePackStateSession(this._serializer)
  }
}

class MessagePackStateSession implements IStateCodecSession {
  private readonly _serializer: MessagePackSerializer
  private readonly _table = new ClassTable()

  public constructor(serializer: MessagePackSerializer) {
    this._serializer = serializer
  }

  public encodeOps(
    ops: readonly WireOp[],
  ): Result<Uint8Array, SerializerError> {
    // DEFINEs are rare (once per class per room); checking them keeps the
    // table honest without costing anything on ordinary ticks.
    for (const op of ops) {
      if (op[0] === 4 && !isWireOp(op)) {
        return err(new SerializerError("ENCODE_FAILED", "malformed DEFINE", op))
      }
    }
    const problem = applyDefines(this._table, ops)
    if (problem !== undefined) {
      return err(new SerializerError("ENCODE_FAILED", problem))
    }
    return this._serializer.encode(ops)
  }

  public decodeOps(data: Uint8Array): Result<WireOp[], SerializerError> {
    const decoded = this._serializer.decode(data)
    if (decoded.isErr()) return decoded
    const ops = decoded.value
    if (!Array.isArray(ops)) {
      return err(new SerializerError("DECODE_FAILED", "frame is not an array"))
    }
    for (let i = 0; i < ops.length; i++) {
      if (!isWireOp(ops[i])) {
        return err(
          new SerializerError("DECODE_FAILED", `malformed op #${i}`, ops[i]),
        )
      }
    }
    // Every element passed isWireOp above.
    const checked = ops as WireOp[]
    const problem = applyDefines(this._table, checked)
    if (problem !== undefined) {
      return err(new SerializerError("DECODE_FAILED", problem))
    }
    return ok(checked)
  }

  public getTable(): SchemaTable {
    return this._table.toTable()
  }
}
