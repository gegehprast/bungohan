/**
 * Receiver side of state sync: applies snapshot/delta ops to a local schema
 * tree and fires listeners. Runs in browsers (client-js) — no Bun/Node APIs.
 */
import { err, ok, type Result } from "@bungohan/result"
import {
  isCollectionField,
  type ParsedFieldType,
  parseFieldType,
  type SchemaClassEntry,
  type SchemaFieldType,
  type WireOp,
} from "@bungohan/types"
import { ArrayBase, CollectionState, MapBase, SetBase } from "./collections"
import { StateError } from "./errors"
import { PrimitiveState } from "./primitives"
import { type ClassInfo, fieldValue, Schema } from "./schema"
import { type SchemaConstructor, SchemaRegistry } from "./schema-registry"
import type { EventQueue, State } from "./state-base"

interface ClassBinding {
  readonly entry: SchemaClassEntry
  /** Per server field: owns a collection refId (parsed once, at DEFINE). */
  readonly collections: readonly boolean[]
  /** Per server field: is a directly nested Schema. */
  readonly nested: readonly boolean[]
  /** Undefined if no local class has this name: instances are ignored. */
  readonly ctor: SchemaConstructor | undefined
  /** Server field index → local field name; computed on first instance. */
  local: (string | undefined)[] | undefined
}

class DecodeContext {
  public readonly refs = new Map<number, Schema | State>()
  /** Refs of instances/collections with no local counterpart. */
  public readonly ignored = new Set<number>()
  public readonly classes = new Map<number, ClassBinding>()
  public readonly refOf = new Map<Schema, number>()
  public readonly bindingOf = new Map<Schema, ClassBinding>()
  /** Number of places (fields, collection slots) holding each instance. */
  public readonly holders = new Map<Schema, number>()
  public rootBound = false
}

/** Per-`applyDelta` call state. */
interface Frame {
  readonly queue: Array<() => void>
  /** Instances created in this frame: their own listeners stay silent. */
  readonly created: Set<Schema>
  /** Instances that lost a holder; dropped at frame end if none remain. */
  readonly released: Schema[]
}

const IGNORED = Symbol("ignored")

type Decoded = Schema | number | string | boolean | typeof IGNORED

const contexts = new WeakMap<Schema, DecodeContext>()

function malformed(message: string, op?: unknown): Err {
  return err(new StateError("MALFORMED_OP", message, op))
}

type Err = Result<never, StateError>

function isInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value)
}

function isWireRef(value: unknown): value is [number, number] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    isInt(value[0]) &&
    isInt(value[1])
  )
}

/** Parses every field type of a DEFINE; `undefined` if any is malformed. */
function parseTypes(types: unknown[]): ParsedFieldType[] | undefined {
  const parsed: ParsedFieldType[] = []
  for (const type of types) {
    const result = typeof type === "string" ? parseFieldType(type) : undefined
    if (result === undefined) return undefined
    parsed.push(result)
  }
  return parsed
}

class Decoder {
  private readonly _ctx: DecodeContext
  private readonly _root: Schema
  private readonly _frame: Frame

  public constructor(ctx: DecodeContext, root: Schema, frame: Frame) {
    this._ctx = ctx
    this._root = root
    this._frame = frame
  }

  public apply(op: unknown): Result<void, StateError> {
    if (!Array.isArray(op) || !isInt(op[0]) || !isInt(op[1])) {
      return malformed("op must start with [code, id]", op)
    }
    switch (op[0]) {
      case 4:
        return this._define(op)
      case 0:
        return this._set(op)
      case 1:
        return this._add(op)
      case 2:
        return this._remove(op)
      case 3:
        return this._clear(op)
      default:
        return malformed(`unknown op code ${op[0]}`, op)
    }
  }

  public collect(): void {
    for (const instance of this._frame.released) {
      if ((this._ctx.holders.get(instance) ?? 0) <= 0) this._drop(instance)
    }
  }

  // --- ops -----------------------------------------------------------------

  private _define(op: unknown[]): Result<void, StateError> {
    const [, classId, name, fields, types] = op
    const parsed = Array.isArray(types) ? parseTypes(types) : undefined
    if (
      op.length !== 5 ||
      !isInt(classId) ||
      typeof name !== "string" ||
      !Array.isArray(fields) ||
      !Array.isArray(types) ||
      parsed === undefined ||
      fields.length !== types.length ||
      !fields.every((field) => typeof field === "string")
    ) {
      return malformed("bad DEFINE", op)
    }
    const binding: ClassBinding = {
      // parseTypes accepted every entry, so they are all SchemaFieldTypes.
      entry: { classId, name, fields, types: types as SchemaFieldType[] },
      collections: parsed.map(isCollectionField),
      nested: parsed.map((type) => type.kind === "schema"),
      ctor: SchemaRegistry.get(name),
      local: undefined,
    }
    this._ctx.classes.set(classId, binding)

    const root = this._root
    if (!this._ctx.rootBound && root._ensureInit().name === name) {
      const bound = this._bind(root, binding, 0)
      if (bound.isErr()) return bound
      this._ctx.holders.set(root, Number.POSITIVE_INFINITY)
      this._frame.created.delete(root) // the root's listeners always fire
      this._ctx.rootBound = true
    }
    return ok(undefined)
  }

  private _set(op: unknown[]): Result<void, StateError> {
    const [, ref, index, value] = op
    if (op.length !== 4 || !isInt(ref) || !isInt(index)) {
      return malformed("bad SET", op)
    }
    if (this._ctx.ignored.has(ref)) return this._ignoreValue(value)
    const target = this._ctx.refs.get(ref)
    if (target === undefined) return this._unknownRef(ref, op)

    if (target instanceof Schema) {
      const binding = this._ctx.bindingOf.get(target)
      const type = binding?.entry.types[index]
      if (binding === undefined || type === undefined) {
        return malformed(`field ${index} out of range`, op)
      }
      const name = binding.local?.[index]
      if (binding.nested[index] === true) {
        if (!isWireRef(value)) return malformed("schema field needs a ref", op)
        if (name === undefined) return this._ignoreValue(value)
        const child = fieldValue(target, name)
        if (!(child instanceof Schema)) return this._ignoreValue(value)
        if (this._ctx.refOf.get(child) === value[1]) return ok(undefined)
        const classBinding = this._ctx.classes.get(value[0])
        if (classBinding === undefined) return this._unknownClass(value[0], op)
        const bound = this._bind(child, classBinding, value[1])
        if (bound.isErr()) return bound
        this._retain(child)
        return ok(undefined)
      }
      if (name === undefined) return ok(undefined)
      const state = fieldValue(target, name)
      if (!(state instanceof PrimitiveState)) return ok(undefined)
      if (!state._applyWire(value, this._queueFor(target))) {
        return malformed(`bad value for ${type} field "${name}"`, op)
      }
      return ok(undefined)
    }

    if (target instanceof ArrayBase) {
      const decoded = this._decode(target, value, op)
      if (decoded.isErr()) return decoded
      if (decoded.value === IGNORED) return ok(undefined)
      const old = target._rReplace(index, decoded.value, this._queueOf(target))
      if (old === undefined) return malformed("replace out of range", op)
      this._release(old)
      this._retain(decoded.value)
      return ok(undefined)
    }
    return malformed("SET target is not a schema or array", op)
  }

  private _add(op: unknown[]): Result<void, StateError> {
    const ref = op[1]
    if (!isInt(ref)) return malformed("bad ADD", op)
    const value = op.length === 3 ? op[2] : op[3]
    if (this._ctx.ignored.has(ref)) return this._ignoreValue(value)
    const target = this._ctx.refs.get(ref)
    if (target === undefined) return this._unknownRef(ref, op)
    if (target instanceof Schema) return malformed("ADD on a schema", op)

    const decoded = this._decode(target, value, op)
    if (decoded.isErr()) return decoded
    const element = decoded.value
    const queue = this._queueOf(target)

    if (target instanceof SetBase) {
      if (op.length !== 3) return malformed("set ADD takes 3 elements", op)
      if (element === IGNORED) return ok(undefined)
      if (target._rAdd(element, queue)) this._retain(element)
      return ok(undefined)
    }
    if (op.length !== 4) return malformed("ADD takes 4 elements", op)
    const key = op[2]

    if (target instanceof MapBase) {
      const mapKey = target._keyCodec.decode(key)
      if (mapKey === undefined) return malformed("bad map key", op)
      if (element === IGNORED) return ok(undefined)
      const old = target._rUpsert(mapKey, element, queue)
      if (old !== element) {
        this._release(old)
        this._retain(element)
      }
      return ok(undefined)
    }
    if (target instanceof ArrayBase) {
      if (!isInt(key)) return malformed("bad array index", op)
      if (element === IGNORED) {
        // Skipping would shift every later index out of sync.
        return err(
          new StateError(
            "UNKNOWN_CLASS",
            "array element of a class unknown to this client",
            op,
          ),
        )
      }
      if (!target._rInsert(key, element, queue)) {
        return malformed("insert out of range", op)
      }
      this._retain(element)
      return ok(undefined)
    }
    return malformed("unsupported ADD target", op)
  }

  private _remove(op: unknown[]): Result<void, StateError> {
    const [, ref, key] = op
    if (op.length !== 3 || !isInt(ref)) return malformed("bad REMOVE", op)
    if (this._ctx.ignored.has(ref)) return ok(undefined)
    const target = this._ctx.refs.get(ref)
    if (target === undefined) return this._unknownRef(ref, op)
    if (target instanceof Schema) return malformed("REMOVE on a schema", op)
    const queue = this._queueOf(target)

    if (target instanceof MapBase) {
      const mapKey = target._keyCodec.decode(key)
      if (mapKey === undefined) return malformed("bad map key", op)
      this._release(target._rDelete(mapKey, queue))
    } else if (target instanceof ArrayBase) {
      if (!isInt(key)) return malformed("bad array index", op)
      const removed = target._rRemove(key, queue)
      if (removed === undefined) return malformed("remove out of range", op)
      this._release(removed)
    } else if (target instanceof SetBase) {
      const codec = target._codec
      if (codec === undefined) {
        if (!isInt(key)) return malformed("schema set REMOVE takes a refId", op)
        const element = this._ctx.refs.get(key)
        if (element instanceof Schema && target._rDelete(element, queue)) {
          this._release(element)
        }
      } else {
        const element = codec.decode(key)
        if (element === undefined) return malformed("bad set element", op)
        target._rDelete(element, queue)
      }
    }
    return ok(undefined)
  }

  private _clear(op: unknown[]): Result<void, StateError> {
    const ref = op[1]
    if (op.length !== 2 || !isInt(ref)) return malformed("bad CLEAR", op)
    if (this._ctx.ignored.has(ref)) return ok(undefined)
    const target = this._ctx.refs.get(ref)
    if (target === undefined) return this._unknownRef(ref, op)
    if (target instanceof Schema) return malformed("CLEAR on a schema", op)
    for (const removed of this._rClear(target)) this._release(removed)
    return ok(undefined)
  }

  // --- helpers -------------------------------------------------------------

  private _rClear(target: State): unknown[] {
    const queue = this._queueOf(target)
    if (target instanceof MapBase || target instanceof SetBase) {
      return target._rClear(queue)
    }
    if (target instanceof ArrayBase) return target._rClear(queue)
    return []
  }

  /** Decodes a collection element (primitive, or ref → instance). */
  private _decode(
    target: State,
    value: unknown,
    op: unknown,
  ): Result<Decoded, StateError> {
    const codec = target instanceof CollectionState ? target._codec : undefined
    if (codec !== undefined) {
      // Type-directed: e.g. a fixed:2 element must be an integer on the wire.
      const element = codec.decode(value)
      return element === undefined
        ? malformed(`bad ${codec.type} element`, op)
        : ok(element)
    }
    if (!isWireRef(value)) return malformed("expected [classId, refId]", op)
    const [classId, ref] = value
    const existing = this._ctx.refs.get(ref)
    if (existing instanceof Schema) return ok(existing)
    if (existing !== undefined) return malformed("ref is a collection", op)

    // An ignored ref is only IGNORED if its class is unknown here. Server
    // refIds are reused (spec §5.7.9), so a block last used by, say, a known
    // class inside an ignored subtree may now name a visible instance.
    const binding = this._ctx.classes.get(classId)
    if (binding === undefined) return this._unknownClass(classId, op)
    if (binding.ctor === undefined) {
      this._ignore(binding, ref)
      return ok(IGNORED)
    }
    const instance = new binding.ctor()
    const bound = this._bind(instance, binding, ref)
    if (bound.isErr()) return bound
    return ok(instance)
  }

  /**
   * Registers `instance` as `ref` (collections: ref+1.. in server field
   * order) and resets it to zero values, since the server omits zeros.
   */
  private _bind(
    instance: Schema,
    binding: ClassBinding,
    ref: number,
  ): Result<void, StateError> {
    const info = instance._ensureInit()
    const local = this._localFields(binding, info)
    if (local.isErr()) return local

    const ctx = this._ctx
    ctx.ignored.delete(ref) // stale mark from a previous use of this block
    ctx.refs.set(ref, instance)
    ctx.refOf.set(instance, ref)
    ctx.bindingOf.set(instance, binding)
    if (!ctx.holders.has(instance)) ctx.holders.set(instance, 0)
    this._frame.created.add(instance)

    for (const field of info.fields) {
      const value = fieldValue(instance, field.name)
      if (value instanceof PrimitiveState || value instanceof CollectionState) {
        value._reset()
      }
    }

    let next = ref + 1
    binding.collections.forEach((isCollection, index) => {
      if (!isCollection) return
      const collectionRef = next++
      const name = local.value[index]
      const value = name === undefined ? undefined : fieldValue(instance, name)
      if (value instanceof CollectionState) {
        ctx.refs.set(collectionRef, value)
        ctx.ignored.delete(collectionRef)
      } else {
        ctx.refs.delete(collectionRef)
        ctx.ignored.add(collectionRef)
      }
    })
    return ok(undefined)
  }

  /** Maps server field indices to local names, checking type agreement. */
  private _localFields(
    binding: ClassBinding,
    info: ClassInfo,
  ): Result<(string | undefined)[], StateError> {
    if (binding.local !== undefined) return ok(binding.local)
    const { entry } = binding
    const local: (string | undefined)[] = []
    for (let i = 0; i < entry.fields.length; i++) {
      const name = entry.fields[i]
      const field = name === undefined ? undefined : info.byName.get(name)
      if (field !== undefined && field.type !== entry.types[i]) {
        return err(
          new StateError(
            "SCHEMA_MISMATCH",
            `${entry.name}.${name}: server sends ${entry.types[i]}, ` +
              `local field is ${field.type}`,
          ),
        )
      }
      local.push(field?.name)
    }
    binding.local = local
    return ok(local)
  }

  /** Marks an unknown-class instance's refs as ignored. */
  private _ignore(binding: ClassBinding, ref: number): void {
    this._ctx.ignored.add(ref)
    let next = ref + 1
    for (const isCollection of binding.collections) {
      if (isCollection) this._ctx.ignored.add(next++)
    }
  }

  /** A value placed into an ignored target: ignore any new ref it creates. */
  private _ignoreValue(value: unknown): Result<void, StateError> {
    if (!isWireRef(value)) return ok(undefined)
    const [classId, ref] = value
    if (this._ctx.refs.has(ref) || this._ctx.ignored.has(ref)) {
      return ok(undefined)
    }
    const binding = this._ctx.classes.get(classId)
    if (binding === undefined) return this._unknownClass(classId, value)
    this._ignore(binding, ref)
    return ok(undefined)
  }

  private _retain(value: unknown): void {
    if (!(value instanceof Schema)) return
    const holders = this._ctx.holders
    holders.set(value, (holders.get(value) ?? 0) + 1)
  }

  private _release(value: unknown): void {
    if (!(value instanceof Schema)) return
    const holders = this._ctx.holders
    const count = (holders.get(value) ?? 0) - 1
    holders.set(value, count)
    if (count <= 0) this._frame.released.push(value)
  }

  /** Unregisters an instance and releases everything it holds. */
  private _drop(instance: Schema): void {
    const ctx = this._ctx
    const ref = ctx.refOf.get(instance)
    const binding = ctx.bindingOf.get(instance)
    if (ref === undefined || binding === undefined) return
    ctx.refs.delete(ref)
    ctx.refOf.delete(instance)
    ctx.bindingOf.delete(instance)
    ctx.holders.delete(instance)

    let next = ref + 1
    for (const isCollection of binding.collections) {
      if (!isCollection) continue
      ctx.refs.delete(next)
      ctx.ignored.delete(next)
      next++
    }

    const children: Schema[] = []
    for (const name of binding.local ?? []) {
      if (name === undefined) continue
      const value = fieldValue(instance, name)
      if (value instanceof Schema) children.push(value)
      else if (value instanceof CollectionState) {
        for (const element of value._elements()) {
          if (element instanceof Schema) children.push(element)
        }
      }
    }
    for (const child of children) {
      const count = (ctx.holders.get(child) ?? 0) - 1
      ctx.holders.set(child, count)
      if (count <= 0) this._drop(child)
    }
  }

  private _queueFor(instance: Schema): EventQueue {
    return this._frame.created.has(instance) ? undefined : this._frame.queue
  }

  private _queueOf(collection: State): EventQueue {
    const owner = collection._owner
    return owner === undefined ? this._frame.queue : this._queueFor(owner)
  }

  private _unknownRef(ref: number, op: unknown): Err {
    return err(new StateError("UNKNOWN_REF", `unknown refId ${ref}`, op))
  }

  private _unknownClass(classId: number, op: unknown): Err {
    return err(
      new StateError("UNKNOWN_CLASS", `classId ${classId} not defined`, op),
    )
  }
}

/**
 * Applies ops (a snapshot or a delta) to `root`. Listener callbacks are
 * deferred until the whole frame is applied, then fired in op order; an
 * instance created by this frame fires no listeners of its own (its parent
 * collection's `onAdd` sees it fully populated).
 *
 * On error, ops before the failing one stay applied; the caller should treat
 * the connection as desynchronized.
 */
export function applyDelta(
  root: Schema,
  ops: readonly WireOp[],
): Result<void, StateError> {
  root._ensureInit()
  let ctx = contexts.get(root)
  if (ctx === undefined) {
    ctx = new DecodeContext()
    contexts.set(root, ctx)
  }
  const frame: Frame = { queue: [], created: new Set(), released: [] }
  const decoder = new Decoder(ctx, root, frame)

  let result: Result<void, StateError> = ok(undefined)
  for (const op of ops) {
    result = decoder.apply(op)
    if (result.isErr()) break
  }
  decoder.collect()

  for (const fire of frame.queue) {
    try {
      fire()
    } catch (error) {
      console.error("[bungohan/state] state listener threw", error)
    }
  }
  return result
}
