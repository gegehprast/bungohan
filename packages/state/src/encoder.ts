/**
 * Server side of state sync (spec §5.5–5.7): snapshots, delta generation,
 * per-client filtering and end-of-tick cleanup. The exact semantics these
 * functions implement are written down in REBUILD_SPEC.md §5.7.9–5.7.11.
 */
import { err, ok, type Result } from "@bungohan/result"
import type {
  SchemaClassEntry,
  SchemaTable,
  WireOp,
  WireRef,
  WireValue,
} from "@bungohan/types"
import { ArrayBase, CollectionState, MapBase, SetBase } from "./collections"
import { StateError } from "./errors"
import { PrimitiveState } from "./primitives"
import { type ClassInfo, fieldValue, Schema } from "./schema"
import type { State } from "./state-base"

/**
 * When a guarded op reaches a client, relative to the filtered field's
 * visibility for that client last tick (`prev`) and now (`cur`):
 * normal = prev && cur, reveal = !prev && cur, hide = prev && !cur,
 * full = cur (content of instances new this tick, and snapshots).
 */
type GuardKind = "normal" | "reveal" | "hide" | "full"

interface Guard {
  readonly state: State
  readonly kind: GuardKind
  readonly parent: Guard | undefined
}

/** Per-room encoding state, keyed by the root schema. */
class EncodeContext {
  public readonly root: Schema
  public nextRef = 0
  public gen = 0
  public readonly classIds = new Map<ClassInfo, number>()
  public readonly table: SchemaClassEntry[] = []
  /** Filtered fields of every instance currently known to clients. */
  public readonly filtered = new Set<State>()
  /**
   * Freed refId blocks per class (base refIds; LIFO). A block is freed by
   * `clearChangeTrees`, i.e. only after the removal has been generated and
   * sent, so it is first reused in the next tick's frame (spec §5.7.9).
   * Blocks are only reused by the same class, so a block always has exactly
   * the `1 + k` ids that class needs.
   */
  public readonly free = new Map<ClassInfo, number[]>()

  public constructor(root: Schema) {
    this.root = root
  }

  /** A block of `1 + collections` consecutive refIds for `info`. */
  public allocate(info: ClassInfo): number {
    const reused = this.free.get(info)?.pop()
    if (reused !== undefined) return reused
    const base = this.nextRef
    this.nextRef += 1 + info.collectionCount
    return base
  }

  public release(info: ClassInfo, base: number): void {
    let blocks = this.free.get(info)
    if (blocks === undefined) {
      blocks = []
      this.free.set(info, blocks)
    }
    blocks.push(base)
  }
}

const contexts = new WeakMap<Schema, EncodeContext>()

/** Filtered field → client → was it visible after the last sync. */
const visibility = new WeakMap<State, WeakMap<object, boolean>>()

function prevVisible(state: State, client: object): boolean {
  return visibility.get(state)?.get(client) ?? false
}

function setVisible(state: State, client: object, visible: boolean): void {
  let perClient = visibility.get(state)
  if (perClient === undefined) {
    perClient = new WeakMap()
    visibility.set(state, perClient)
  }
  perClient.set(client, visible)
}

function defineOp(entry: SchemaClassEntry): WireOp {
  return [4, entry.classId, entry.name, [...entry.fields], [...entry.types]]
}

function isZeroWire(wire: WireValue): boolean {
  return wire === 0 || wire === "" || wire === false
}

/** Memoizes filter results for one generation. */
class FilterEvaluator {
  private readonly _results = new Map<State, Map<object, boolean>>()

  public visible(state: State, client: object): boolean {
    let perClient = this._results.get(state)
    if (perClient === undefined) {
      perClient = new Map()
      this._results.set(state, perClient)
    }
    let result = perClient.get(client)
    if (result === undefined) {
      result = evaluateFilter(state, client)
      perClient.set(client, result)
    }
    return result
  }

  public passes(
    guard: Guard | undefined,
    client: object,
    memo: Map<Guard, boolean>,
  ): boolean {
    if (guard === undefined) return true
    const cached = memo.get(guard)
    if (cached !== undefined) return cached
    let result = this.passes(guard.parent, client, memo)
    if (result) {
      const cur = this.visible(guard.state, client)
      if (guard.kind === "full") result = cur
      else {
        const prev = prevVisible(guard.state, client)
        if (guard.kind === "normal") result = prev && cur
        else if (guard.kind === "reveal") result = !prev && cur
        else result = prev && !cur
      }
    }
    memo.set(guard, result)
    return result
  }
}

function evaluateFilter(state: State, client: object): boolean {
  const filter = state._filter
  const owner = state._owner
  if (filter === undefined || owner === undefined) return true
  try {
    return filter.call(owner, client) === true
  } catch (error) {
    console.error(
      `[bungohan/state] filter on "${state._fieldName}" threw; hiding it`,
      error,
    )
    return false
  }
}

/** Collects the ops of one snapshot or delta, each with its guard. */
class Emitter {
  public readonly ops: WireOp[] = []
  public readonly guards: (Guard | undefined)[] = []
  /** Distinct guards, in first-use order (per-client grouping key). */
  public readonly distinctGuards: Guard[] = []
  /** Filtered fields that became known during this emission. */
  public readonly newFiltered = new Set<State>()
  private readonly _ctx: EncodeContext
  private readonly _inlineDefines: boolean
  private readonly _guardCache = new Map<State, Guard[]>()

  public constructor(ctx: EncodeContext, inlineDefines: boolean) {
    this._ctx = ctx
    this._inlineDefines = inlineDefines
  }

  public emit(op: WireOp, guard: Guard | undefined): void {
    this.ops.push(op)
    this.guards.push(guard)
  }

  /** Interned guard node, so identical chains share one object. */
  public guard(
    state: State,
    kind: GuardKind,
    parent: Guard | undefined,
  ): Guard {
    let candidates = this._guardCache.get(state)
    if (candidates === undefined) {
      candidates = []
      this._guardCache.set(state, candidates)
    }
    for (const candidate of candidates) {
      if (candidate.kind === kind && candidate.parent === parent)
        return candidate
    }
    const created: Guard = { state, kind, parent }
    candidates.push(created)
    this.distinctGuards.push(created)
    return created
  }

  /** Guard for a field: adds a link only if the field is filtered. */
  public fieldGuard(
    state: State,
    kind: GuardKind,
    parent: Guard | undefined,
  ): Guard | undefined {
    return state._filter === undefined
      ? parent
      : this.guard(state, kind, parent)
  }

  /** Class id for `info`, appending to the table (and a DEFINE) if new. */
  public classId(info: ClassInfo): number {
    const existing = this._ctx.classIds.get(info)
    if (existing !== undefined) return existing
    const classId = this._ctx.table.length
    const entry: SchemaClassEntry = {
      classId,
      name: info.name,
      fields: info.fields.map((field) => field.name),
      types: info.fields.map((field) => field.type),
    }
    this._ctx.table.push(entry)
    this._ctx.classIds.set(info, classId)
    // DEFINEs are never guarded: every client must be able to decode refs.
    if (this._inlineDefines) this.emit(defineOp(entry), undefined)
    return classId
  }

  /**
   * Wire reference for `instance`, assigning refIds if it is unknown:
   * the instance gets R, its collection fields R+1..R+k in field order.
   */
  public ref(instance: Schema): [ref: WireRef, isNew: boolean] {
    const info = instance._ensureInit()
    const classId = this.classId(info)
    if (instance._wireRef !== -1) return [[classId, instance._wireRef], false]
    const ctx = this._ctx
    const base = ctx.allocate(info)
    instance._wireRef = base
    instance._visitedGen = ctx.gen
    let next = base + 1
    for (const field of info.fields) {
      const value = fieldValue(instance, field.name)
      if (field.isCollection) {
        const ref = next++
        if (value instanceof CollectionState) value._wireRef = ref
      }
      if (value instanceof PrimitiveState || value instanceof CollectionState) {
        if (value._filter !== undefined) {
          ctx.filtered.add(value)
          this.newFiltered.add(value)
        }
      }
    }
    return [[classId, instance._wireRef], true]
  }

  /**
   * Emits the op placing `value` somewhere. A Schema value that is new (or
   * any Schema, when `deep`) is followed by its full content.
   */
  public attach(
    makeOp: (wire: WireValue) => WireOp,
    value: unknown,
    guard: Guard | undefined,
    deep: boolean,
  ): void {
    if (value instanceof Schema) {
      const [wire, isNew] = this.ref(value)
      this.emit(makeOp(wire), guard)
      if (isNew || deep) this.content(value, guard, deep)
      else this.visit(value, guard)
    } else if (
      typeof value === "number" ||
      typeof value === "string" ||
      typeof value === "boolean"
    ) {
      this.emit(makeOp(value), guard)
    }
  }

  /**
   * Full content of an instance: every non-zero primitive and every
   * collection entry. Receivers start instances at zero values.
   */
  public content(instance: Schema, guard: Guard | undefined, deep: boolean) {
    const info = instance._ensureInit()
    const ref = instance._wireRef
    for (const field of info.fields) {
      const value = fieldValue(instance, field.name)
      if (value instanceof Schema) {
        const index = field.index
        this.attach((wire) => [0, ref, index, wire], value, guard, deep)
      } else if (value instanceof PrimitiveState) {
        const wire = value._toWire()
        if (!isZeroWire(wire)) {
          this.emit(
            [0, ref, field.index, wire],
            this.fieldGuard(value, "full", guard),
          )
        }
      } else if (value instanceof CollectionState) {
        this.collectionContent(
          value,
          this.fieldGuard(value, "full", guard),
          deep,
        )
      }
    }
  }

  public collectionContent(
    collection: CollectionState<unknown, unknown, unknown>,
    guard: Guard | undefined,
    deep: boolean,
  ): void {
    const ref = collection._wireRef
    const wire = (value: unknown): unknown => collection._toWire(value)
    if (collection instanceof MapBase) {
      for (const [key, value] of collection) {
        this.attach((w) => [1, ref, key, w], wire(value), guard, deep)
      }
    } else if (collection instanceof SetBase) {
      for (const value of collection) {
        this.attach((w) => [1, ref, w], wire(value), guard, deep)
      }
    } else if (collection instanceof ArrayBase) {
      collection.forEach((value, index) => {
        this.attach((w) => [1, ref, index, w], wire(value), guard, deep)
      })
    }
  }

  /** Emits the recorded changes of a known instance and its dirty subtree. */
  public visit(instance: Schema, guard: Guard | undefined): void {
    const ctx = this._ctx
    if (instance._wireRef === -1 || instance._visitedGen === ctx.gen) return
    instance._visitedGen = ctx.gen
    const info = instance._ensureInit()
    const tree = instance._tree
    const ref = instance._wireRef

    for (const name of tree._changedKeys()) {
      const field = info.byName.get(name)
      const value = fieldValue(instance, name)
      if (field === undefined || !(value instanceof PrimitiveState)) continue
      this.emit(
        [0, ref, field.index, value._toWire()],
        this.fieldGuard(value, "normal", guard),
      )
    }

    if (tree._dirtyCollections !== undefined) {
      for (const collection of tree._dirtyCollections) {
        if (collection instanceof CollectionState) {
          this.collectionOps(
            collection,
            this.fieldGuard(collection, "normal", guard),
          )
        }
      }
    }

    if (tree._dirtyChildren !== undefined) {
      for (const childTree of tree._dirtyChildren) {
        const child = childTree.owner
        if (child === undefined || child._parent !== instance) continue
        const holder = child._parentField
        this.visit(
          child,
          holder === undefined
            ? guard
            : this.fieldGuard(holder, "normal", guard),
        )
      }
    }
  }

  /** Translates a collection's recorded changes into ops. */
  public collectionOps(
    collection: CollectionState<unknown, unknown, unknown>,
    guard: Guard | undefined,
  ): void {
    const ref = collection._wireRef
    const wire = (value: unknown): unknown => collection._toWire(value)
    if (collection instanceof MapBase) {
      if (collection._cleared) {
        this.emit([3, ref], guard)
        this.collectionContent(collection, guard, false)
        return
      }
      if (collection._touched === undefined) return
      for (const [key, record] of collection._touched) {
        if (!collection.has(key)) {
          if (record.had) this.emit([2, ref, key], guard)
          continue
        }
        const value = collection.get(key)
        // Coalesced: send the key's final value, unless receivers already
        // have it (same element, or same quantized wire value).
        if (!record.had || !collection._sameWire(record.prev, value)) {
          this.attach((w) => [1, ref, key, w], wire(value), guard, false)
        }
      }
    } else if (collection instanceof SetBase) {
      if (collection._cleared) {
        this.emit([3, ref], guard)
        this.collectionContent(collection, guard, false)
        return
      }
      if (collection._touched === undefined) return
      for (const [value, had] of collection._touched) {
        if (collection.has(value)) {
          if (!had) this.attach((w) => [1, ref, w], wire(value), guard, false)
        } else if (had) {
          if (value instanceof Schema) {
            if (value._wireRef !== -1)
              this.emit([2, ref, value._wireRef], guard)
          } else if (
            typeof value === "number" ||
            typeof value === "string" ||
            typeof value === "boolean"
          ) {
            this.emit([2, ref, value], guard)
          }
        }
      }
    } else if (collection instanceof ArrayBase) {
      if (collection._ops === undefined) return
      for (const op of collection._ops) {
        if (op[0] === 0) {
          const [, index, value] = op
          this.attach((w) => [0, ref, index, w], wire(value), guard, false)
        } else if (op[0] === 1) {
          const [, index, value] = op
          this.attach((w) => [1, ref, index, w], wire(value), guard, false)
        } else if (op[0] === 2) {
          this.emit([2, ref, op[1]], guard)
        } else {
          this.emit([3, ref], guard)
        }
      }
    }
  }

  /**
   * Appends reveal/hide ops for filtered fields whose visibility flipped
   * for some client since the last sync.
   */
  public transitions(clients: readonly object[], filters: FilterEvaluator) {
    for (const state of this._ctx.filtered) {
      if (this.newFiltered.has(state)) continue
      const owner = state._owner
      if (owner === undefined || owner._wireRef === -1) continue
      let reveal = false
      let hide = false
      for (const client of clients) {
        const prev = prevVisible(state, client)
        const cur = filters.visible(state, client)
        if (!prev && cur) reveal = true
        else if (prev && !cur) hide = true
      }
      if (!reveal && !hide) continue

      const base = this.ancestorGuard(owner)
      const ref = owner._wireRef
      if (reveal) {
        const guard = this.guard(state, "reveal", base)
        if (state instanceof PrimitiveState) {
          this.emit([0, ref, state._fieldIndex, state._toWire()], guard)
        } else if (state instanceof CollectionState) {
          this.collectionContent(state, guard, true)
        }
      }
      if (hide) {
        const guard = this.guard(state, "hide", base)
        if (state instanceof PrimitiveState) {
          this.emit([0, ref, state._fieldIndex, state._zeroWire()], guard)
        } else if (state instanceof CollectionState) {
          this.emit([3, state._wireRef], guard)
        }
      }
    }
  }

  /** Guard chain requiring every filtered ancestor to be steadily visible. */
  private ancestorGuard(instance: Schema): Guard | undefined {
    const holders: State[] = []
    let current: Schema | undefined = instance
    while (current !== undefined) {
      const holder: State | undefined = current._parentField
      if (holder?._filter !== undefined) holders.push(holder)
      current = current._parent
    }
    let guard: Guard | undefined
    for (let i = holders.length - 1; i >= 0; i--) {
      const holder = holders[i]
      if (holder !== undefined) guard = this.guard(holder, "normal", guard)
    }
    return guard
  }

  /** Ops visible to `client`. */
  public select(
    client: object | undefined,
    filters: FilterEvaluator,
    memo: Map<Guard, boolean>,
  ): WireOp[] {
    return this.ops.filter((_, i) => {
      const guard = this.guards[i]
      if (guard === undefined) return true
      return client !== undefined && filters.passes(guard, client, memo)
    })
  }

  /** Ops with no guard at all (what an unfiltered view receives). */
  public shared(): WireOp[] {
    return this.distinctGuards.length === 0
      ? this.ops
      : this.ops.filter((_, i) => this.guards[i] === undefined)
  }
}

/**
 * Full state for one joining client: DEFINE ops for the whole class table
 * (the §5.7.2 handshake, in-band), then the content of every instance.
 * Filtered fields are included only if `client` passes their filter.
 *
 * Refuses (`SNAPSHOT_DIRTY`) while changes are pending: existing clients
 * haven't received them yet, so the joiner must be added at a sync boundary
 * (generate + send + `clearChangeTrees` first).
 */
export function encodeSnapshot(
  root: Schema,
  client?: object,
): Result<WireOp[], StateError> {
  root._ensureInit()
  let ctx = contexts.get(root)
  if (ctx !== undefined && root._tree.isDirty()) {
    return err(
      new StateError(
        "SNAPSHOT_DIRTY",
        "encodeSnapshot requires a clean tree; flush pending deltas first",
      ),
    )
  }
  if (ctx === undefined) {
    ctx = new EncodeContext(root)
    contexts.set(root, ctx)
  }
  ctx.gen++
  const emitter = new Emitter(ctx, false)
  emitter.ref(root)
  emitter.content(root, undefined, true)

  const filters = new FilterEvaluator()
  const body = emitter.select(client, filters, new Map())
  if (client !== undefined) {
    for (const state of ctx.filtered) {
      setVisible(state, client, filters.visible(state, client))
    }
  }
  return ok([...ctx.table.map(defineOp), ...body])
}

/**
 * Ops for everything that changed since the last `clearChangeTrees`.
 * Returns `[]` on an idle tick (and before the first snapshot) — send
 * nothing in that case.
 *
 * Without `clients`, filtered fields are omitted entirely. With `clients`,
 * returns each client's ops; clients with identical visibility share the
 * same array instance, so callers can encode once per distinct array.
 * Pass every connected client on every call.
 */
export function generateDeltas(root: Schema): WireOp[]
export function generateDeltas<C extends object>(
  root: Schema,
  clients: Iterable<C>,
): Map<C, WireOp[]>
export function generateDeltas<C extends object>(
  root: Schema,
  clients?: Iterable<C>,
): WireOp[] | Map<C, WireOp[]> {
  const ctx = contexts.get(root)
  const list = clients === undefined ? undefined : [...clients]
  if (ctx === undefined) {
    if (list === undefined) return []
    const empty: WireOp[] = []
    return new Map(list.map((client) => [client, empty]))
  }

  ctx.gen++
  const emitter = new Emitter(ctx, true)
  if (root._tree.isDirty()) emitter.visit(root, undefined)
  if (list === undefined) return emitter.shared()

  const filters = new FilterEvaluator()
  if (list.length > 0 && ctx.filtered.size > 0) {
    emitter.transitions(list, filters)
  }

  const result = new Map<C, WireOp[]>()
  if (emitter.distinctGuards.length === 0) {
    for (const client of list) result.set(client, emitter.ops)
  } else {
    const bySignature = new Map<string, WireOp[]>()
    for (const client of list) {
      const memo = new Map<Guard, boolean>()
      let signature = ""
      for (const guard of emitter.distinctGuards) {
        signature += filters.passes(guard, client, memo) ? "1" : "0"
      }
      let ops = bySignature.get(signature)
      if (ops === undefined) {
        ops = emitter.select(client, filters, memo)
        bySignature.set(signature, ops)
      }
      result.set(client, ops)
    }
  }

  for (const state of ctx.filtered) {
    for (const client of list) {
      setVisible(state, client, filters.visible(state, client))
    }
  }
  return result
}

/**
 * Commits a sync tick: resets every change record and forgets instances
 * removed this tick that were not re-attached. A forgotten instance is sent
 * in full, under new refIds, if it is ever attached again.
 */
export function clearChangeTrees(root: Schema): void {
  clearTree(root, contexts.get(root))
}

function clearTree(instance: Schema, ctx: EncodeContext | undefined): void {
  const tree = instance._tree
  if (tree._dirtyCollections !== undefined) {
    for (const collection of tree._dirtyCollections) {
      if (!(collection instanceof CollectionState)) continue
      if (collection._removed !== undefined) {
        for (const removed of collection._removed) {
          if (removed._parent === undefined && removed._wireRef !== -1) {
            forget(removed, ctx)
          }
        }
      }
      collection._clearChanges()
    }
  }
  if (tree._dirtyChildren !== undefined) {
    for (const childTree of tree._dirtyChildren) {
      if (childTree.owner !== undefined) clearTree(childTree.owner, ctx)
    }
  }
  tree.clear()
}

function forget(instance: Schema, ctx: EncodeContext | undefined): void {
  // Never sent (e.g. added to an instance removed in the same tick): it
  // holds no block, and neither does anything under it.
  if (instance._wireRef === -1) return
  const info = instance._info
  if (info !== undefined && ctx !== undefined && instance !== ctx.root) {
    ctx.release(info, instance._wireRef)
  }
  instance._wireRef = -1
  if (info !== undefined) {
    for (const field of info.fields) {
      const value = fieldValue(instance, field.name)
      if (value instanceof Schema) {
        if (value._parent === instance) forget(value, ctx)
        continue
      }
      if (
        !(value instanceof PrimitiveState || value instanceof CollectionState)
      )
        continue
      if (value._filter !== undefined) {
        ctx?.filtered.delete(value)
        visibility.delete(value)
      }
      if (value instanceof CollectionState) {
        value._wireRef = -1
        value._clearChanges()
        for (const element of value._elements()) {
          if (element instanceof Schema && element._parent === instance) {
            forget(element, ctx)
          }
        }
      }
    }
  }
  instance._tree.clear()
}

/** The room's class table so far (the §5.7.2 handshake contents). */
export function getSchemaTable(root: Schema): SchemaTable {
  const table = contexts.get(root)?.table ?? []
  return {
    classes: table.map((entry) => ({
      classId: entry.classId,
      name: entry.name,
      fields: [...entry.fields],
      types: [...entry.types],
    })),
  }
}
