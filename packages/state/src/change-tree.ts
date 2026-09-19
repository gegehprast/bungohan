import type { Schema, Unsent } from "./schema"
import type { State } from "./state-base"

/**
 * Per-Schema-instance change record (spec §5.4). Holds changed primitive
 * fields and the set of collections with recorded ops; the ops themselves
 * live on each collection (§5.7.4).
 *
 * Dirtiness propagates upward as a chain of `dirtyChildren` sets, so delta
 * generation walks only the dirty paths instead of the whole tree. An
 * instance shared by several collections has one parent per holder, and
 * propagates to all of them: whichever is still in the room carries the
 * change, even if another holder left the tree this tick.
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
  private _parents: readonly ChangeTree[] = []
  private _changes: Map<string, unknown> | undefined

  public constructor(owner?: Schema) {
    this.owner = owner
  }

  /** The first parent (the only one unless the instance is shared). */
  public get parent(): ChangeTree | undefined {
    return this._parents[0]
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
    this.setParents(parent === undefined ? [] : [parent])
  }

  /** @internal Re-links to every holder; carries pending dirtiness. */
  public setParents(parents: readonly ChangeTree[]): void {
    const old = this._parents
    if (old.length === parents.length && old.every((p, i) => p === parents[i]))
      return
    for (const parent of old) {
      if (!parents.includes(parent)) parent._dirtyChildren?.delete(this)
    }
    this._parents = parents
    if (parents.length > 0 && this.isDirty()) this._propagate()
  }

  private _propagate(): void {
    for (const parent of this._parents) {
      if (parent._dirtyChildren === undefined) parent._dirtyChildren = new Set()
      else if (parent._dirtyChildren.has(this)) continue
      parent._dirtyChildren.add(this)
      parent._propagate()
    }
  }
}
