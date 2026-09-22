/**
 * State-sync codecs (spec §8.1.2–8.1.5). A codec encodes the `WireOp[]`
 * stream produced by `@bungohan/state`, and the room's contract messages;
 * PROTOCOL.md §13 is the byte layout. This file holds the interface and the
 * `messagepack` codec; `schema-codec.ts` holds the default `schema` codec.
 */
import { err, ok, type Result } from "@bungohan/result"
import {
  type Infer,
  type MessageDef,
  parseFieldType,
  type SchemaClassEntry,
  type SchemaFieldType,
  type SchemaTable,
  type WireOp,
} from "@bungohan/types"
import { SerializerError } from "./errors"
import { packUnknownMessage, unpackMessage } from "./message-codec"
import { MessagePackSerializer } from "./messagepack"

/**
 * A room's codec: it encodes the state op stream and the room's contract
 * messages, so a room has exactly one codec, named in the join handshake.
 * Raw messages and control bodies are not its business (they use the
 * connection's `ISerializer`). Choose it with `ServerOptions.stateCodec`:
 * `SchemaCodec` (the default, compact and tag-free) or
 * `MessagePackStateCodec` (self-describing, easier to inspect).
 *
 * Stateless itself: each state stream (a room on the server, a joined room
 * on a client) gets its own {@link IStateCodecSession}, because the class
 * table grows during a stream and a tag-free codec needs it to decode.
 * Messages need no session: their declarations are the whole layout.
 *
 * What an implementation must do:
 *
 * - Be deterministic and match the client's codec of the same name byte
 *   for byte. A client picks its decoder by `getName()`, and one without
 *   that name fails the join with `CODEC_MISMATCH`, so a custom codec
 *   needs a counterpart in every client.
 * - Treat decode input as untrusted and return an `err` for anything that
 *   isn't an exact encoding. No method may throw: they run on every frame.
 * - Return arrays the caller owns (they are queued and broadcast).
 */
export interface IStateCodec {
  /** Named in the join handshake so the client picks the matching codec. */
  getName(): string
  /**
   * A fresh session for one state stream, with an empty class table. Core
   * starts a new one whenever it sends a room's full snapshot from
   * scratch; a client, for each join.
   */
  createSession(): IStateCodecSession
  /**
   * Encodes a contract message. Numbers are converted to the field's type
   * as they are encoded (integers truncate toward zero and saturate at
   * their type's range, `fixed:n` rounds half away from zero, `float32`
   * rounds to single precision), exactly as the receiver will hold them.
   * A payload that got past the types (a string in a number field) is
   * `ENCODE_FAILED`.
   */
  encodeMessage(
    def: MessageDef,
    payload: unknown,
  ): Result<Uint8Array, SerializerError>
  /**
   * Decodes a contract message, type-directed and strict: anything but an
   * exact encoding is `DECODE_FAILED` and must never reach a handler.
   */
  decodeMessage<M extends MessageDef>(
    def: M,
    data: Uint8Array,
  ): Result<Infer<M>, SerializerError>
}

/**
 * One op stream. The session keeps its class table up to date from the
 * `DEFINE` ops it encodes or decodes, in stream order, so no table is ever
 * passed in. A snapshot restating classes the session already knows is
 * fine; a `DEFINE` that contradicts one is an error.
 *
 * The server encodes a room's frames through one session and every client
 * decodes through its own, in the order they were encoded, from the
 * snapshot it joined with onward (a snapshot `DEFINE`s every class it
 * uses, so a late joiner's table catches up).
 */
export interface IStateCodecSession {
  /**
   * Encodes the ops of one frame, learning any class they `DEFINE`. A
   * malformed or contradicting `DEFINE`, or an op the codec can't encode
   * against the table, is `ENCODE_FAILED`.
   */
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

  /** Forgets every class from `size` on (rolls back a failed frame). */
  public truncate(size: number): void {
    if (size < this._classes.length) this._classes.length = size
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

  /** Positional MessagePack array (PROTOCOL.md §13.2.2). */
  public encodeMessage(
    def: MessageDef,
    payload: unknown,
  ): Result<Uint8Array, SerializerError> {
    const packed = packUnknownMessage(def, payload)
    return packed.isErr() ? packed : this._serializer.encode(packed.value)
  }

  public decodeMessage<M extends MessageDef>(
    def: M,
    data: Uint8Array,
  ): Result<Infer<M>, SerializerError> {
    const decoded = this._serializer.decode(data)
    return decoded.isErr() ? decoded : unpackMessage(def, decoded.value)
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
