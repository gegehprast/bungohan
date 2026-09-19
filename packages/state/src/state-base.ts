import type { SchemaFieldType } from "@bungohan/types"
import type { Schema } from "./schema"

/** Visibility predicate stored by `createFiltered`, type-erased. */
export type FilterFn = (this: Schema, client: unknown) => boolean

/**
 * Receiver-side listener queue: `applyDelta` defers every listener call until
 * the whole frame is applied, so callbacks observe consistent state.
 * `undefined` means "apply silently" (instance created in this frame).
 */
export type EventQueue = Array<() => void> | undefined

/** Base of every field wrapper (primitives and collections). */
export abstract class State<T = unknown> {
  /** @internal Owning schema; set when the owner initializes. */
  public _owner: Schema | undefined = undefined
  /** @internal */
  public _fieldName = ""
  /** @internal Position in the owner's class field table. */
  public _fieldIndex = -1
  /** @internal Collection refId on the wire; -1 until assigned. */
  public _wireRef = -1
  /** @internal Set by `createFiltered`. */
  public _filter: FilterFn | undefined = undefined

  /** @internal Field type as listed in the class table. */
  public abstract readonly _type: SchemaFieldType

  /** Current value (collections: a read-only view of the contents). */
  public abstract get value(): T

  /** @internal */
  public _bind(owner: Schema, name: string, index: number): void {
    this._owner = owner
    this._fieldName = name
    this._fieldIndex = index
  }

  /**
   * @internal Why this field can't be synchronized (a malformed declaration
   * that got past the types), or `undefined`. Checked once per class.
   */
  public _declarationError(): string | undefined {
    return undefined
  }

  /** @internal Hook run right after `_bind` (links schema elements). */
  public _onBound(): void {}

  /**
   * @internal Mutations are recorded only once the owner is known to
   * clients (has a refId). Before that, the owner will be serialized in
   * full when first sent, so there is nothing to diff against.
   */
  public _isTracking(): boolean {
    return this._owner !== undefined && this._owner._wireRef !== -1
  }
}

/** Calls each listener; used by server-side (synchronous) notifications. */
export function notify<A extends unknown[]>(
  listeners: Set<(...args: A) => void> | undefined,
  ...args: A
): void {
  if (listeners === undefined) return
  for (const listener of listeners) listener(...args)
}

/** Defers listener calls into a receiver queue (no-op if suppressed). */
export function enqueue<A extends unknown[]>(
  queue: EventQueue,
  listeners: Set<(...args: A) => void> | undefined,
  ...args: A
): void {
  if (queue === undefined || listeners === undefined || listeners.size === 0)
    return
  queue.push(() => {
    for (const listener of listeners) listener(...args)
  })
}
