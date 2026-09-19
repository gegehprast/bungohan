import {
  isCollectionField,
  parseFieldType,
  type SchemaFieldType,
} from "@bungohan/types"
import { nanoid } from "nanoid"
import { ChangeTree } from "./change-tree"
import {
  type SchemaConstructor,
  SchemaRegistry,
  schemaNameOf,
} from "./schema-registry"
import { State } from "./state-base"

export interface FieldInfo {
  readonly name: string
  readonly index: number
  readonly type: SchemaFieldType
  readonly isCollection: boolean
}

/** Per-class field table, captured from the first initialized instance. */
export interface ClassInfo {
  readonly ctor: SchemaConstructor
  /** Own `schemaName`, falling back to the JS class name. */
  readonly name: string
  readonly fields: readonly FieldInfo[]
  readonly byName: ReadonlyMap<string, FieldInfo>
  /** Collection fields; an instance's refId block is `1 + collectionCount`. */
  readonly collectionCount: number
}

const classInfos = new WeakMap<SchemaConstructor, ClassInfo>()

/**
 * @internal Wire identities dropped from the tree: blocks to free and
 * filtered fields to stop tracking, applied when the tick is committed.
 */
export interface Unsent {
  readonly blocks: [ClassInfo, number][]
  readonly filtered: State[]
}

/** @internal */
export function emptyUnsent(): Unsent {
  return { blocks: [], filtered: [] }
}

/**
 * @internal Clears the wire identity of `instance` and of everything it
 * holds (or removed this tick and still holds nowhere else), collecting
 * their blocks into `into`. If any of them is attached again, it is sent in
 * full under a new block.
 */
export function unsend(instance: Schema, into: Unsent): void {
  if (instance._wireRef === -1) return
  const info = instance._info
  if (info === undefined) {
    instance._wireRef = -1
    return
  }
  into.blocks.push([info, instance._wireRef])
  instance._wireRef = -1
  const pending = instance._tree._unsent
  if (pending !== undefined) {
    into.blocks.push(...pending.blocks)
    into.filtered.push(...pending.filtered)
    instance._tree._unsent = undefined
  }
  for (const field of info.fields) {
    const value = fieldValue(instance, field.name)
    if (value instanceof Schema) {
      if (value._parent === instance) unsend(value, into)
      continue
    }
    if (!(value instanceof State)) continue
    if (value._filter !== undefined) into.filtered.push(value)
    for (const element of value._unsend()) {
      if (!(element instanceof Schema)) continue
      // A shared element stays on the wire while another holder is.
      element._relink()
      if (!isOnWire(element._parent)) unsend(element, into)
    }
  }
  instance._tree.clear()
}

/** @internal True if `instance` is known to clients (has a refId). */
export function isOnWire(instance: Schema | undefined): boolean {
  return instance !== undefined && instance._wireRef !== -1
}

/** Name of the nested field of `parent` that holds `child`. */
function nestedFieldName(parent: Schema, child: Schema): string {
  for (const field of parent._info?.fields ?? []) {
    if (fieldValue(parent, field.name) === child) {
      return `${parent.constructor.name}.${field.name}`
    }
  }
  return `a nested field of ${parent.constructor.name}`
}

/** Where `instance` is held, for error messages. */
function heldBy(instance: Schema): string {
  const parent = instance._parent
  if (parent === undefined) return "nothing"
  const field = instance._parentField
  return field === undefined
    ? nestedFieldName(parent, instance)
    : `${parent.constructor.name}.${field._fieldName}`
}

/** True if `instance` is held by a nested field (which owns it alone). */
function inNestedField(instance: Schema): boolean {
  return instance._parent !== undefined && instance._parentField === undefined
}

/** True if `instance` is `owner` or one of its ancestors (a cycle). */
function isAncestor(instance: Schema, owner: Schema | undefined): boolean {
  for (let at = owner; at !== undefined; at = at._parent) {
    if (at === instance) return true
  }
  return false
}

/**
 * @internal Why a collection must refuse to hold `value`, if it must: a
 * nested field owns its instance exclusively (receivers rebind a nested
 * object rather than adopt one, so sharing it would orphan their copy),
 * and a collection can't hold its own owner or an ancestor of it.
 * Collections may share instances among themselves.
 */
export function collectionRefusal(
  value: Schema,
  owner: Schema | undefined,
): string | undefined {
  if (inNestedField(value)) {
    return (
      `is held by the nested field ${heldBy(value)}; a nested field owns ` +
      "its instance exclusively (collections may share one). To move it, " +
      "first assign something else to that field, then add it"
    )
  }
  if (isAncestor(value, owner)) {
    return "contains this collection (it would hold itself)"
  }
  return undefined
}

/**
 * @internal Lazy init linked an element that a nested field already
 * holds. Too late to refuse (the collection was filled before it was
 * initialized, when nothing could be checked), so it is only reported.
 */
export function reportSharedElement(collection: State, value: Schema): void {
  if (!inNestedField(value)) return
  console.error(
    `[bungohan/state] ${collection._owner?.constructor.name}.` +
      `${collection._fieldName} holds a ${value.constructor.name} that is ` +
      `also held by the nested field ${heldBy(value)}. It was added before ` +
      "the collection was initialized, so it couldn't be refused; clients " +
      "will desync when that field is replaced. A nested field owns its " +
      "instance exclusively: remove it from one of the two.",
  )
}

/** Reads a field off a schema instance by name. */
export function fieldValue(schema: Schema, name: string): unknown {
  return (schema as unknown as Record<string, unknown>)[name]
}

/**
 * Field table of `instance`'s class. Runs once per class, so declaration
 * checks cost nothing per instance. A malformed declaration (only reachable
 * by getting past the types) is logged and the field left unsynchronized:
 * this runs when a class is first used, which may be mid-game, so it must
 * not throw (CLAUDE.md, architecture rule 1).
 */
function buildClassInfo(instance: Schema): ClassInfo {
  const ctor = instance.constructor as SchemaConstructor
  const fields: FieldInfo[] = []
  for (const name of Object.keys(instance)) {
    if (name.startsWith("_")) continue
    const value = fieldValue(instance, name)
    let type: SchemaFieldType
    if (value instanceof State) {
      const problem = value._declarationError()
      if (problem !== undefined) {
        console.error(
          `[bungohan/state] ${ctor.name}.${name}: ${problem}; ` +
            "the field will not be synchronized.",
        )
        continue
      }
      type = value._type
    } else if (value instanceof Schema) {
      const nested = value.constructor as SchemaConstructor
      type = `schema<${schemaNameOf(nested) ?? nested.name}>`
    } else continue
    const parsed = parseFieldType(type)
    fields.push({
      name,
      index: fields.length,
      type,
      isCollection: parsed !== undefined && isCollectionField(parsed),
    })
  }
  let name = schemaNameOf(ctor)
  if (name === undefined) {
    name = ctor.name
    console.error(
      `[bungohan/state] ${ctor.name} has no own static schemaName; ` +
        "falling back to the class name, which breaks under minification.",
    )
  }
  return {
    ctor,
    name,
    fields,
    byName: new Map(fields.map((field) => [field.name, field])),
    collectionCount: fields.filter((field) => field.isCollection).length,
  }
}

/**
 * Base class for synchronized state. Declare fields as plain class fields
 * holding factory-created wrappers (`createNumber()`, …) or nested Schema
 * instances; nothing needs to be called after `new`.
 *
 * Initialization is lazy (spec §5.1): a base constructor cannot see subclass
 * fields, so the field table is built by `_ensureInit()` on first attach to a
 * parent, first snapshot/delta, or first `applyDelta`. Mutations before that
 * point are not recorded, which is correct: nothing has observed the
 * instance yet, and it is serialized in full the first time it is sent.
 *
 * Only wrapper fields (from the `create*` factories) and nested Schema
 * instances are synchronized. A plain field (`public vx = 0`, an array, a
 * Map, any non-wrapper value) is local to the object it lives on: never
 * sent, never in the class table, never touched by a receiver. That makes
 * plain fields the place for server-only data (velocities, cooldowns) on
 * a class both sides share:
 *
 * ```ts
 * class Bullet extends Schema {
 *   public static override schemaName = "Bullet"
 *   public x = createFixedPoint(1) // synchronized
 *   public vx = 0                   // server-only, never sent
 * }
 * ```
 *
 * Field names starting with `_` are reserved for the framework and never
 * synchronized; don't use them for your own fields.
 */
export class Schema {
  /** Required on every concrete subclass; identifies the class on the wire. */
  public static schemaName: string

  public readonly _id: string
  public readonly _tree: ChangeTree
  /** @internal Wire refId, assigned per room on first send; -1 if unsent. */
  public _wireRef = -1
  /** @internal Schema holding this instance (tree structure). */
  public _parent: Schema | undefined = undefined
  /** @internal Collection holding this instance; undefined for a direct field. */
  public _parentField: State | undefined = undefined
  /**
   * @internal Every bound collection holding this instance → how many of
   * its slots do. Collections may share an instance; `_parent` is one of
   * them (on the wire, if any is), so removing it from one doesn't drop it
   * from the tree while another still holds it.
   */
  public _holders: Map<State, number> | undefined = undefined
  /** @internal Set by `_ensureInit`; doubles as the "initialized" flag. */
  public _info: ClassInfo | undefined = undefined
  /** @internal Delta-generation stamp, to visit each instance once. */
  public _visitedGen = 0

  public constructor() {
    this._id = nanoid()
    this._tree = new ChangeTree(this)
    SchemaRegistry._autoRegister(this.constructor as SchemaConstructor)
  }

  /** Constructs and eagerly initializes (surfaces schema errors early). */
  public static create<T extends Schema>(ctor: SchemaConstructor<T>): T {
    const instance = new ctor()
    instance._ensureInit()
    return instance
  }

  /**
   * @internal Builds the field table (once per class), binds every field
   * wrapper to this instance and links nested schemas. Idempotent.
   */
  public _ensureInit(): ClassInfo {
    if (this._info !== undefined) return this._info
    const ctor = this.constructor as SchemaConstructor
    let info = classInfos.get(ctor)
    if (info === undefined) {
      info = buildClassInfo(this)
      classInfos.set(ctor, info)
    }
    this._info = info
    for (const field of info.fields) {
      const value = fieldValue(this, field.name)
      if (value instanceof State) {
        value._bind(this, field.name, field.index)
        value._onBound()
      } else if (value instanceof Schema) {
        // Assigned before init, when the field had no setter to refuse it.
        const held = attachment(value, this)
        if (held !== undefined) {
          console.error(
            `[bungohan/state] ${ctor.name}.${field.name} holds a ` +
              `${value.constructor.name} that ${held}. It was assigned ` +
              "before the instance was initialized, so it couldn't be " +
              "refused; clients will desync. A nested field owns its " +
              "instance exclusively.",
          )
        }
        value._attachTo(this, undefined)
        observeNested(this, field.name, value)
      }
    }
    return info
  }

  /**
   * @internal Links this instance under `parent` (and initializes it):
   * `field` is the collection holding it, `undefined` for a nested field.
   * A collection becomes `_parent` unless the current one is on the wire
   * and it isn't.
   */
  public _attachTo(parent: Schema, field: State | undefined): void {
    if (field === undefined) this._link(parent, undefined)
    else {
      if (this._holders === undefined) this._holders = new Map()
      this._holders.set(field, (this._holders.get(field) ?? 0) + 1)
      if (!isOnWire(this._parent) || isOnWire(parent)) this._link(parent, field)
      else this._linkTrees()
    }
    this._ensureInit()
  }

  /** @internal `field` released one of its slots holding this instance. */
  public _detachFrom(field: State): void {
    const count = this._holders?.get(field)
    if (count === undefined) return
    if (count > 1) {
      this._holders?.set(field, count - 1)
      return
    }
    this._holders?.delete(field)
    if (this._parentField === field) this._relink(true)
    else this._linkTrees()
  }

  /**
   * @internal Points `_parent` at a holder on the wire if the current one
   * isn't. With `lost`, the current parent no longer holds it: falls back
   * to any remaining holder, or unlinks.
   */
  public _relink(lost = false): void {
    if (!lost && isOnWire(this._parent)) return
    let fallback: State | undefined
    for (const holder of this._holders?.keys() ?? []) {
      if (isOnWire(holder._owner)) {
        this._link(holder._owner, holder)
        return
      }
      fallback ??= holder
    }
    if (lost) this._link(fallback?._owner, fallback)
  }

  /** @internal `field` (a holder) just went on the wire: prefer it. */
  public _preferHolder(field: State): void {
    if (isOnWire(this._parent) || !this._holders?.has(field)) return
    this._link(field._owner, field)
  }

  /** @internal */
  public _link(parent: Schema | undefined, field: State | undefined): void {
    this._parent = parent
    this._parentField = field
    this._linkTrees()
  }

  /**
   * @internal How `owner` holds this instance: the collection, `null` for
   * a nested field, `undefined` if it doesn't.
   */
  public _heldBy(owner: Schema): State | null | undefined {
    if (this._parent === owner) return this._parentField ?? null
    for (const holder of this._holders?.keys() ?? []) {
      if (holder._owner === owner) return holder
    }
    return undefined
  }

  /**
   * @internal Change-tree parents: the nested field's owner and every
   * holder's, so a change reaches whichever holder is still in the room.
   */
  public _linkTrees(): void {
    const parents: ChangeTree[] = []
    if (this._parent !== undefined && this._parentField === undefined) {
      parents.push(this._parent._tree)
    }
    for (const holder of this._holders?.keys() ?? []) {
      const tree = holder._owner?._tree
      if (tree !== undefined && !parents.includes(tree)) parents.push(tree)
    }
    this._tree.setParents(parents)
  }
}

/**
 * Turns a nested Schema field into an accessor, so assigning it
 * (`holder.bag = new Bag()`) is recorded. A class field is an own data
 * property, which a prototype setter would never see, so `_ensureInit`
 * converts it, as it binds the wrappers.
 */
function observeNested(owner: Schema, name: string, initial: Schema): void {
  let current = initial
  Object.defineProperty(owner, name, {
    configurable: true,
    enumerable: true,
    get: () => current,
    set: (next: unknown) => {
      if (next === current) return
      if (!(next instanceof Schema)) {
        console.error(
          `[bungohan/state] ${owner.constructor.name}.${name} holds a ` +
            "Schema instance; ignoring the assignment of a non-Schema value.",
        )
        return
      }
      const held = attachment(next, owner)
      if (held !== undefined) {
        console.error(
          `[bungohan/state] ${owner.constructor.name}.${name}: refusing to ` +
            `assign a ${next.constructor.name} that ${held}; the field keeps ` +
            "its current value. An instance has one parent at a time: to " +
            "move it, remove it first (delete it from its collection, or " +
            "assign something else to the field holding it), then assign it.",
        )
        return
      }
      const old = current
      current = next
      replaceNested(owner, name, old, next)
    },
  })
}

/**
 * Where `next` is already attached, if it is: in a collection, in another
 * nested field, or as a room's state (a root is the only server instance
 * with refId 0). Receivers rebind a nested field to a new object, so taking
 * an instance from elsewhere would orphan the receivers' copy of it there.
 * Refusing keeps both sides on the old value. Also refuses `owner` or one
 * of its ancestors, which would make the tree a cycle.
 */
function attachment(next: Schema, owner: Schema): string | undefined {
  if (next._parent !== undefined) {
    return `is already attached (held by ${heldBy(next)})`
  }
  if (next._wireRef === 0) return "is a room's state"
  if (isAncestor(next, owner)) {
    return "contains this field (it would hold itself)"
  }
  return undefined
}

/**
 * Receivers keep their own nested object and rebind it to whatever refId
 * the field names, so an instance can't keep its wire identity through a
 * nested field: the old one leaves the wire (its block is freed at the
 * commit), and the new one is sent in full under a new block, even if it
 * was known elsewhere and removed this tick (PROTOCOL.md §11.5). That is
 * why `attachment` refuses one that is still attached.
 */
function replaceNested(
  owner: Schema,
  name: string,
  old: Schema,
  next: Schema,
): void {
  if (old._parent === owner && old._parentField === undefined) {
    old._relink(true)
  }
  const tree = owner._tree
  if (owner._wireRef !== -1) {
    if (tree._unsent === undefined) tree._unsent = emptyUnsent()
    unsend(old, tree._unsent)
    unsend(next, tree._unsent)
    tree.markChanged(name, next)
  }
  next._attachTo(owner, undefined)
}
