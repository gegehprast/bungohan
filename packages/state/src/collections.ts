import type { SchemaFieldType } from "@bungohan/types"
import type { PrimitiveWire } from "./primitives"
import type { Schema } from "./schema"
import { type EventQueue, enqueue, notify, State } from "./state-base"

/** `(value, key)` — maps: key; arrays: index; sets: the value again. */
export type AddListener<V, K> = (value: V, key: K) => void
export type RemoveListener<V, K> = (value: V, key: K) => void
/** An entry replaced in place (map key re-set, array index assigned). */
export type ReplaceListener<V, K> = (newValue: V, oldValue: V, key: K) => void

export type MapKey = string | number

/**
 * Shared listener plumbing and change-recording hooks. Mutators record their
 * specific ops (spec §5.7.4) only while the owner is known to clients.
 */
export abstract class CollectionState<V, K, T> extends State<T> {
  /** @internal Schema elements removed since the last clear. */
  public _removed: Schema[] | undefined = undefined
  protected _addListeners: Set<AddListener<V, K>> | undefined
  protected _removeListeners: Set<RemoveListener<V, K>> | undefined

  public onAdd(listener: AddListener<V, K>): () => void {
    if (this._addListeners === undefined) this._addListeners = new Set()
    this._addListeners.add(listener)
    return () => this.offAdd(listener)
  }

  public offAdd(listener: AddListener<V, K>): void {
    this._addListeners?.delete(listener)
  }

  public onRemove(listener: RemoveListener<V, K>): () => void {
    if (this._removeListeners === undefined) this._removeListeners = new Set()
    this._removeListeners.add(listener)
    return () => this.offRemove(listener)
  }

  public offRemove(listener: RemoveListener<V, K>): void {
    this._removeListeners?.delete(listener)
  }

  /** @internal Drops recorded ops after a sync tick. */
  public abstract _clearChanges(): void

  /** @internal Receiver: empties the collection silently. */
  public abstract _reset(): void

  /** @internal All current elements (for tree walks). */
  public abstract _elements(): Iterable<V>

  /** Links a newly inserted element (schema variants only). */
  protected _attach(_value: V): void {}

  /** Unlinks a removed element (schema variants only). */
  protected _detach(_value: V): void {}

  /** Unlinks a schema element and remembers it for end-of-tick cleanup. */
  protected _unlink(value: Schema): void {
    value._detachFrom(this)
    if (!this._isTracking()) return
    if (this._removed === undefined) this._removed = []
    this._removed.push(value)
  }

  protected _markDirty(): void {
    const owner = this._owner
    if (owner !== undefined && owner._wireRef !== -1) {
      owner._tree._markCollection(this)
    }
  }
}

/** Adds the in-place replace listener shared by maps and arrays. */
abstract class ReplaceableCollection<V, K, T> extends CollectionState<V, K, T> {
  protected _changeListeners: Set<ReplaceListener<V, K>> | undefined

  public onChange(listener: ReplaceListener<V, K>): () => void {
    if (this._changeListeners === undefined) this._changeListeners = new Set()
    this._changeListeners.add(listener)
    return () => this.offChange(listener)
  }

  public offChange(listener: ReplaceListener<V, K>): void {
    this._changeListeners?.delete(listener)
  }
}

function linkSchema(
  collection: State,
  value: Schema,
  owner: Schema | undefined,
): void {
  if (owner !== undefined) value._attachTo(owner, collection)
}

// ---------------------------------------------------------------------------
// Maps
// ---------------------------------------------------------------------------

/** @internal Presence of a key when first touched since the last sync. */
export interface KeyRecord<V> {
  readonly had: boolean
  readonly prev: V | undefined
}

/**
 * Map ops are coalesced per key: only each touched key's final state is
 * sent (upsert or remove), since keyed ops commute.
 */
export abstract class MapBase<
  K extends MapKey,
  V,
> extends ReplaceableCollection<V, K, ReadonlyMap<K, V>> {
  /** @internal */
  public _touched: Map<K, KeyRecord<V>> | undefined = undefined
  /** @internal */
  public _cleared = false
  protected readonly _map: Map<K, V>

  public constructor(initial?: Iterable<readonly [K, V]>) {
    super()
    this._map = new Map(initial)
  }

  public get value(): ReadonlyMap<K, V> {
    return this._map
  }

  public get size(): number {
    return this._map.size
  }

  public get(key: K): V | undefined {
    return this._map.get(key)
  }

  public has(key: K): boolean {
    return this._map.has(key)
  }

  public set(key: K, value: V): this {
    const had = this._map.has(key)
    const old = this._map.get(key)
    if (had && Object.is(old, value)) return this
    this._record(key)
    this._map.set(key, value)
    if (had && old !== undefined) this._detach(old)
    this._attach(value)
    this._markDirty()
    if (had && old !== undefined) notify(this._changeListeners, value, old, key)
    else notify(this._addListeners, value, key)
    return this
  }

  public delete(key: K): boolean {
    const old = this._map.get(key)
    if (old === undefined && !this._map.has(key)) return false
    this._record(key)
    this._map.delete(key)
    if (old !== undefined) {
      this._detach(old)
      this._markDirty()
      notify(this._removeListeners, old, key)
    }
    return true
  }

  public clear(): void {
    if (this._map.size === 0) return
    const entries = [...this._map]
    this._map.clear()
    if (this._isTracking()) {
      this._cleared = true
      this._touched = undefined
    }
    for (const [, value] of entries) this._detach(value)
    this._markDirty()
    for (const [key, value] of entries) {
      notify(this._removeListeners, value, key)
    }
  }

  public keys(): MapIterator<K> {
    return this._map.keys()
  }

  public values(): MapIterator<V> {
    return this._map.values()
  }

  public entries(): MapIterator<[K, V]> {
    return this._map.entries()
  }

  public forEach(fn: (value: V, key: K) => void): void {
    for (const [key, value] of this._map) fn(value, key)
  }

  public [Symbol.iterator](): MapIterator<[K, V]> {
    return this._map[Symbol.iterator]()
  }

  public _elements(): Iterable<V> {
    return this._map.values()
  }

  public _clearChanges(): void {
    this._touched = undefined
    this._cleared = false
    this._removed = undefined
  }

  public _reset(): void {
    this._map.clear()
  }

  /** @internal Receiver: insert or replace. Returns the replaced value. */
  public _rUpsert(key: K, value: V, queue: EventQueue): V | undefined {
    const old = this._map.get(key)
    this._map.set(key, value)
    if (old !== undefined)
      enqueue(queue, this._changeListeners, value, old, key)
    else enqueue(queue, this._addListeners, value, key)
    return old
  }

  /** @internal Receiver: returns the removed value, if any. */
  public _rDelete(key: K, queue: EventQueue): V | undefined {
    const old = this._map.get(key)
    if (old === undefined) return undefined
    this._map.delete(key)
    enqueue(queue, this._removeListeners, old, key)
    return old
  }

  /** @internal Receiver: returns the removed values. */
  public _rClear(queue: EventQueue): V[] {
    const entries = [...this._map]
    this._map.clear()
    for (const [key, value] of entries) {
      enqueue(queue, this._removeListeners, value, key)
    }
    return entries.map(([, value]) => value)
  }

  private _record(key: K): void {
    if (this._cleared || !this._isTracking()) return
    if (this._touched === undefined) this._touched = new Map()
    if (!this._touched.has(key)) {
      this._touched.set(key, {
        had: this._map.has(key),
        prev: this._map.get(key),
      })
    }
  }
}

export class MapState<
  K extends MapKey = string,
  V extends PrimitiveWire = PrimitiveWire,
> extends MapBase<K, V> {
  public readonly _type: SchemaFieldType = "map"
}

/** Map of Schema instances; each element is linked under the owner. */
export class SchemaMapState<
  K extends MapKey = string,
  V extends Schema = Schema,
> extends MapBase<K, V> {
  public readonly _type: SchemaFieldType = "schemaMap"

  public override _onBound(): void {
    for (const value of this._map.values()) this._attach(value)
  }

  protected override _attach(value: V): void {
    linkSchema(this, value, this._owner)
  }

  protected override _detach(value: V): void {
    this._unlink(value)
  }
}

// ---------------------------------------------------------------------------
// Sets
// ---------------------------------------------------------------------------

/** Set ops are coalesced per element, like map keys. */
export abstract class SetBase<T> extends CollectionState<T, T, ReadonlySet<T>> {
  /** @internal element → was it present when first touched */
  public _touched: Map<T, boolean> | undefined = undefined
  /** @internal */
  public _cleared = false
  protected readonly _set: Set<T>

  public constructor(initial?: Iterable<T>) {
    super()
    this._set = new Set(initial)
  }

  public get value(): ReadonlySet<T> {
    return this._set
  }

  public get size(): number {
    return this._set.size
  }

  public has(value: T): boolean {
    return this._set.has(value)
  }

  public add(value: T): this {
    if (this._set.has(value)) return this
    this._record(value)
    this._set.add(value)
    this._attach(value)
    this._markDirty()
    notify(this._addListeners, value, value)
    return this
  }

  public delete(value: T): boolean {
    if (!this._set.has(value)) return false
    this._record(value)
    this._set.delete(value)
    this._detach(value)
    this._markDirty()
    notify(this._removeListeners, value, value)
    return true
  }

  public clear(): void {
    if (this._set.size === 0) return
    const values = [...this._set]
    this._set.clear()
    if (this._isTracking()) {
      this._cleared = true
      this._touched = undefined
    }
    for (const value of values) this._detach(value)
    this._markDirty()
    for (const value of values) notify(this._removeListeners, value, value)
  }

  public values(): SetIterator<T> {
    return this._set.values()
  }

  public forEach(fn: (value: T) => void): void {
    for (const value of this._set) fn(value)
  }

  public [Symbol.iterator](): SetIterator<T> {
    return this._set[Symbol.iterator]()
  }

  public _elements(): Iterable<T> {
    return this._set
  }

  public _clearChanges(): void {
    this._touched = undefined
    this._cleared = false
    this._removed = undefined
  }

  public _reset(): void {
    this._set.clear()
  }

  /** @internal Receiver. Returns false if already present. */
  public _rAdd(value: T, queue: EventQueue): boolean {
    if (this._set.has(value)) return false
    this._set.add(value)
    enqueue(queue, this._addListeners, value, value)
    return true
  }

  /** @internal Receiver. Returns false if absent. */
  public _rDelete(value: T, queue: EventQueue): boolean {
    if (!this._set.delete(value)) return false
    enqueue(queue, this._removeListeners, value, value)
    return true
  }

  /** @internal Receiver: returns the removed values. */
  public _rClear(queue: EventQueue): T[] {
    const values = [...this._set]
    this._set.clear()
    for (const value of values) {
      enqueue(queue, this._removeListeners, value, value)
    }
    return values
  }

  private _record(value: T): void {
    if (this._cleared || !this._isTracking()) return
    if (this._touched === undefined) this._touched = new Map()
    if (!this._touched.has(value)) {
      this._touched.set(value, this._set.has(value))
    }
  }
}

export class SetState<
  T extends PrimitiveWire = PrimitiveWire,
> extends SetBase<T> {
  public readonly _type: SchemaFieldType = "set"
}

export class SchemaSetState<T extends Schema = Schema> extends SetBase<T> {
  public readonly _type: SchemaFieldType = "schemaSet"

  public override _onBound(): void {
    for (const value of this._set) this._attach(value)
  }

  protected override _attach(value: T): void {
    linkSchema(this, value, this._owner)
  }

  protected override _detach(value: T): void {
    this._unlink(value)
  }
}

// ---------------------------------------------------------------------------
// Arrays
// ---------------------------------------------------------------------------

/**
 * @internal Recorded array op. Arrays keep an ordered log (index ops don't
 * commute): replace-at, insert-at, remove-at, clear.
 */
export type ArrayOp<T> =
  | readonly [kind: 0, index: number, value: T]
  | readonly [kind: 1, index: number, value: T]
  | readonly [kind: 2, index: number]
  | readonly [kind: 3]

export abstract class ArrayBase<T> extends ReplaceableCollection<
  T,
  number,
  readonly T[]
> {
  /** @internal */
  public _ops: ArrayOp<T>[] | undefined = undefined
  protected readonly _items: T[]

  public constructor(initial?: Iterable<T>) {
    super()
    this._items = initial === undefined ? [] : [...initial]
  }

  public get value(): readonly T[] {
    return this._items
  }

  public get length(): number {
    return this._items.length
  }

  /** Element at `index` (negative counts from the end). */
  public at(index: number): T | undefined {
    return this._items.at(index)
  }

  public get(index: number): T | undefined {
    return this._items[index]
  }

  /** Replaces the element at an existing index; false if out of range. */
  public set(index: number, value: T): boolean {
    if (!Number.isInteger(index) || index < 0 || index >= this._items.length)
      return false
    const old = this._items[index]
    if (old === undefined || Object.is(old, value)) return true
    this._items[index] = value
    this._detach(old)
    this._attach(value)
    this._log([0, index, value])
    notify(this._changeListeners, value, old, index)
    return true
  }

  public push(...items: T[]): number {
    for (const item of items) this._insert(this._items.length, item)
    return this._items.length
  }

  public unshift(...items: T[]): number {
    items.forEach((item, offset) => {
      this._insert(offset, item)
    })
    return this._items.length
  }

  public pop(): T | undefined {
    return this._items.length === 0
      ? undefined
      : this._removeAt(this._items.length - 1)
  }

  public shift(): T | undefined {
    return this._items.length === 0 ? undefined : this._removeAt(0)
  }

  /** Native `splice` semantics (negative start, omitted deleteCount). */
  public splice(start: number, deleteCount?: number, ...items: T[]): T[] {
    const length = this._items.length
    const from =
      start < 0 ? Math.max(length + start, 0) : Math.min(start, length)
    const count = Math.min(
      Math.max(deleteCount ?? length - from, 0),
      length - from,
    )
    const removed: T[] = []
    for (let i = 0; i < count; i++) {
      const value = this._removeAt(from)
      if (value !== undefined) removed.push(value)
    }
    items.forEach((item, offset) => {
      this._insert(from + offset, item)
    })
    return removed
  }

  public clear(): void {
    if (this._items.length === 0) return
    const items = this._items.splice(0)
    for (const item of items) this._detach(item)
    if (this._isTracking()) this._ops = [[3]]
    this._markDirty()
    items.forEach((item, index) => {
      notify(this._removeListeners, item, index)
    })
  }

  public sort(compare?: (a: T, b: T) => number): this {
    return this._permute(() => this._items.sort(compare))
  }

  public reverse(): this {
    return this._permute(() => this._items.reverse())
  }

  public includes(value: T): boolean {
    return this._items.includes(value)
  }

  public indexOf(value: T): number {
    return this._items.indexOf(value)
  }

  public find(predicate: (value: T, index: number) => boolean): T | undefined {
    return this._items.find(predicate)
  }

  public findIndex(predicate: (value: T, index: number) => boolean): number {
    return this._items.findIndex(predicate)
  }

  public some(predicate: (value: T, index: number) => boolean): boolean {
    return this._items.some(predicate)
  }

  public every(predicate: (value: T, index: number) => boolean): boolean {
    return this._items.every(predicate)
  }

  public filter(predicate: (value: T, index: number) => boolean): T[] {
    return this._items.filter(predicate)
  }

  public map<U>(fn: (value: T, index: number) => U): U[] {
    return this._items.map(fn)
  }

  public reduce<U>(fn: (acc: U, value: T, index: number) => U, initial: U): U {
    return this._items.reduce(fn, initial)
  }

  public forEach(fn: (value: T, index: number) => void): void {
    this._items.forEach(fn)
  }

  public slice(start?: number, end?: number): T[] {
    return this._items.slice(start, end)
  }

  public join(separator?: string): string {
    return this._items.join(separator)
  }

  public [Symbol.iterator](): ArrayIterator<T> {
    return this._items[Symbol.iterator]()
  }

  public _elements(): Iterable<T> {
    return this._items
  }

  public _clearChanges(): void {
    this._ops = undefined
    this._removed = undefined
  }

  public _reset(): void {
    this._items.length = 0
  }

  /** @internal Receiver. False if `index` is out of range. */
  public _rInsert(index: number, value: T, queue: EventQueue): boolean {
    if (index < 0 || index > this._items.length) return false
    this._items.splice(index, 0, value)
    enqueue(queue, this._addListeners, value, index)
    return true
  }

  /** @internal Receiver: returns the removed value, if in range. */
  public _rRemove(index: number, queue: EventQueue): T | undefined {
    if (index < 0 || index >= this._items.length) return undefined
    const [value] = this._items.splice(index, 1)
    if (value !== undefined) enqueue(queue, this._removeListeners, value, index)
    return value
  }

  /** @internal Receiver: returns the replaced value, if in range. */
  public _rReplace(index: number, value: T, queue: EventQueue): T | undefined {
    const old = this._items[index]
    if (old === undefined) return undefined
    this._items[index] = value
    enqueue(queue, this._changeListeners, value, old, index)
    return old
  }

  /** @internal Receiver: returns the removed values. */
  public _rClear(queue: EventQueue): T[] {
    const items = this._items.splice(0)
    items.forEach((item, index) => {
      enqueue(queue, this._removeListeners, item, index)
    })
    return items
  }

  private _insert(index: number, value: T): void {
    this._items.splice(index, 0, value)
    this._attach(value)
    this._log([1, index, value])
    notify(this._addListeners, value, index)
  }

  private _removeAt(index: number): T | undefined {
    const [value] = this._items.splice(index, 1)
    if (value === undefined) return undefined
    this._detach(value)
    this._log([2, index])
    notify(this._removeListeners, value, index)
    return value
  }

  /** Reorders in place, recording a replace op per index that changed. */
  private _permute(reorder: () => void): this {
    const before = [...this._items]
    reorder()
    before.forEach((old, index) => {
      const value = this._items[index]
      if (value === undefined || Object.is(old, value)) return
      this._log([0, index, value])
      notify(this._changeListeners, value, old, index)
    })
    return this
  }

  private _log(op: ArrayOp<T>): void {
    if (!this._isTracking()) return
    if (this._ops === undefined) this._ops = []
    this._ops.push(op)
    this._markDirty()
  }
}

export class ArrayState<
  T extends PrimitiveWire = PrimitiveWire,
> extends ArrayBase<T> {
  public readonly _type: SchemaFieldType = "array"

  /** Native `fill` semantics; records a replace op per changed index. */
  public fill(value: T, start?: number, end?: number): this {
    const length = this._items.length
    const norm = (i: number): number =>
      i < 0 ? Math.max(length + i, 0) : Math.min(i, length)
    const from = norm(start ?? 0)
    const to = norm(end ?? length)
    for (let index = from; index < to; index++) this.set(index, value)
    return this
  }
}

/**
 * Array of Schema instances. `sort`/`reverse` send one replace op per moved
 * index; an instance must not appear twice.
 */
export class SchemaArrayState<T extends Schema = Schema> extends ArrayBase<T> {
  public readonly _type: SchemaFieldType = "schemaArray"

  public override _onBound(): void {
    for (const value of this._items) this._attach(value)
  }

  protected override _attach(value: T): void {
    linkSchema(this, value, this._owner)
  }

  protected override _detach(value: T): void {
    this._unlink(value)
  }
}
