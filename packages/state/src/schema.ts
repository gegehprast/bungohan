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
        value._attachTo(this, undefined)
      }
    }
    return info
  }

  /** @internal Links this instance under `parent` (and initializes it). */
  public _attachTo(parent: Schema, field: State | undefined): void {
    this._parent = parent
    this._parentField = field
    this._tree.setParent(parent._tree)
    this._ensureInit()
  }

  /** @internal Unlinks, if still held by `field` (a move may have won). */
  public _detachFrom(field: State): void {
    if (this._parentField !== field) return
    this._parent = undefined
    this._parentField = undefined
    this._tree.setParent(undefined)
  }
}
