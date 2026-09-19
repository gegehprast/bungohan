import type { Schema, Unsent } from "./schema"
import type { State } from "./state-base"

/**
 * Per-Schema-instance change record (spec §5.4). Holds changed primitive
 * fields and the set of collections with recorded ops; the ops themselves
 * live on each collection (§5.7.4).
 *
 * Dirtiness propagates upward as a chain of `dirtyChildren` sets, so delta
 * generation walks only the dirty paths instead of the whole tree.
 */
export class ChangeTree {
  /** The Schema instance this tree belongs to. */
  public readonly owner: Schema | undefined
  /** @internal */
  public _dirtyCollections: Set<State> | undefined
  /** @internal */
  public _dirtyChildren: Set<ChangeTree> | undefined
  /**
   * @internal Wire identities this instance dropped during the tick (a
   * replaced nested field); their blocks are freed by the commit.
   */
  public _unsent: Unsent | undefined
  private _parent: ChangeTree | undefined
  private _changes: Map<string, unknown> | undefined

  public constructor(owner?: Schema) {
    this.owner = owner
  }

  public get parent(): ChangeTree | undefined {
    return this._parent
  }

  /** Records a changed field (last write wins) and dirties ancestors. */
  public markChanged(key: string, value: unknown): void {
    if (this._changes === undefined) this._changes = new Map()
    this._changes.set(key, value)
    this._propagate()
  }

  /** @internal Records that `collection` has ops pending. */
  public _markCollection(collection: State): void {
    if (this._dirtyCollections === undefined) this._dirtyCollections = new Set()
    this._dirtyCollections.add(collection)
    this._propagate()
  }

  /** True if this instance or any descendant has pending changes. */
  public isDirty(): boolean {
    return (
      (this._changes !== undefined && this._changes.size > 0) ||
      (this._dirtyCollections !== undefined &&
        this._dirtyCollections.size > 0) ||
      (this._dirtyChildren !== undefined && this._dirtyChildren.size > 0)
    )
  }

  /** Changed fields of this instance only, as `fieldName → value`. */
  public getChanges(): Map<string, unknown> {
    return new Map(this._changes)
  }

  /** @internal Changed field names, without copying. */
  public _changedKeys(): Iterable<string> {
    return this._changes?.keys() ?? []
  }

  /** Resets this node (not descendants — see `clearChangeTrees`). */
  public clear(): void {
    this._changes?.clear()
    this._dirtyCollections?.clear()
    this._dirtyChildren?.clear()
  }

  /** Re-links this tree; carries pending dirtiness to the new parent. */
  public setParent(parent: ChangeTree | undefined): void {
    if (this._parent === parent) return
    this._parent?._dirtyChildren?.delete(this)
    this._parent = parent
    if (parent !== undefined && this.isDirty()) this._propagate()
  }

  private _propagate(): void {
    let child: ChangeTree = this
    let parent = this._parent
    while (parent !== undefined) {
      if (parent._dirtyChildren === undefined) parent._dirtyChildren = new Set()
      else if (parent._dirtyChildren.has(child)) return
      parent._dirtyChildren.add(child)
      child = parent
      parent = parent._parent
    }
  }
}
