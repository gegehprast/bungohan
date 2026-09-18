import {
  type FixedDecimals,
  fromFixed,
  type SchemaFieldType,
  toFixed,
} from "@bungohan/types"
import { type EventQueue, enqueue, notify, State } from "./state-base"

export type ChangeListener<T> = (newValue: T, oldValue: T) => void

/** Wire representation of a primitive field value. */
export type PrimitiveWire = number | string | boolean

/** Base for single-value wrappers: `get()`/`set()` plus a `value` alias. */
export abstract class PrimitiveState<T extends PrimitiveWire> extends State<T> {
  protected _value: T
  private _listeners: Set<ChangeListener<T>> | undefined

  public constructor(initial: T) {
    super()
    this._value = initial
  }

  public get(): T {
    return this._value
  }

  public set(value: T): void {
    const old = this._value
    if (Object.is(old, value)) return
    this._value = value
    const owner = this._owner
    if (
      owner !== undefined &&
      owner._wireRef !== -1 &&
      !Object.is(this._encode(old), this._encode(value))
    ) {
      owner._tree.markChanged(this._fieldName, value)
    }
    notify(this._listeners, value, old)
  }

  public get value(): T {
    return this._value
  }

  public set value(value: T) {
    this.set(value)
  }

  /** Subscribes to changes; returns an unsubscribe function. */
  public onChange(listener: ChangeListener<T>): () => void {
    if (this._listeners === undefined) this._listeners = new Set()
    this._listeners.add(listener)
    return () => this.offChange(listener)
  }

  public offChange(listener: ChangeListener<T>): void {
    this._listeners?.delete(listener)
  }

  /** @internal Current value as it goes on the wire. */
  public _toWire(): PrimitiveWire {
    return this._encode(this._value)
  }

  /** @internal Wire value to hide this field (type's zero value). */
  public abstract _zeroWire(): PrimitiveWire

  /**
   * @internal Receiver: applies a wire value without change tracking.
   * Returns false if the wire value has the wrong type.
   */
  public _applyWire(wire: unknown, queue: EventQueue): boolean {
    const value = this._decode(wire)
    if (value === undefined) return false
    const old = this._value
    if (Object.is(old, value)) return true
    this._value = value
    enqueue(queue, this._listeners, value, old)
    return true
  }

  /** @internal Receiver: resets to the zero value, silently. */
  public _reset(): void {
    const zero = this._decode(this._zeroWire())
    if (zero !== undefined) this._value = zero
  }

  protected abstract _encode(value: T): PrimitiveWire
  protected abstract _decode(wire: unknown): T | undefined
}

/** Full-precision (float64) number. The default numeric field. */
export class NumberState extends PrimitiveState<number> {
  public readonly _type: SchemaFieldType = "float64"

  public _zeroWire(): number {
    return 0
  }

  protected _encode(value: number): number {
    return value
  }

  protected _decode(wire: unknown): number | undefined {
    return typeof wire === "number" ? wire : undefined
  }
}

/**
 * **Lossy.** Sent at 32-bit float precision (`Math.fround`). The server keeps
 * full precision; clients see the rounded value. A write marks the field
 * dirty only if its float32 value changes.
 */
export class Float32State extends PrimitiveState<number> {
  public readonly _type: SchemaFieldType = "float32"

  public _zeroWire(): number {
    return 0
  }

  protected _encode(value: number): number {
    return Math.fround(value)
  }

  protected _decode(wire: unknown): number | undefined {
    return typeof wire === "number" ? Math.fround(wire) : undefined
  }
}

/**
 * **Lossy.** Sent as the signed 32-bit integer
 * `round(value * 10^decimals)` (half away from zero, saturating at the int32
 * range, NaN → 0). The server keeps full precision, so accumulating small
 * increments still works; clients see the quantized value. A write marks the
 * field dirty only if its quantized value changes. See spec §5.7.6.1.
 */
export class FixedPointState extends PrimitiveState<number> {
  public readonly _type: SchemaFieldType
  public readonly decimals: FixedDecimals

  public constructor(decimals: FixedDecimals, initial: number) {
    super(initial)
    this.decimals = decimals
    this._type = `fixed:${decimals}`
  }

  public _zeroWire(): number {
    return 0
  }

  protected _encode(value: number): number {
    return toFixed(value, this.decimals)
  }

  protected _decode(wire: unknown): number | undefined {
    return typeof wire === "number" && Number.isInteger(wire)
      ? fromFixed(wire, this.decimals)
      : undefined
  }
}

export class StringState<T extends string = string> extends PrimitiveState<T> {
  public readonly _type: SchemaFieldType = "string"

  public _zeroWire(): string {
    return ""
  }

  protected _encode(value: T): string {
    return value
  }

  protected _decode(wire: unknown): T | undefined {
    // The receiver trusts the server for literal-union membership.
    return typeof wire === "string" ? (wire as T) : undefined
  }
}

export class BooleanState extends PrimitiveState<boolean> {
  public readonly _type: SchemaFieldType = "bool"

  public _zeroWire(): boolean {
    return false
  }

  protected _encode(value: boolean): boolean {
    return value
  }

  protected _decode(wire: unknown): boolean | undefined {
    return typeof wire === "boolean" ? wire : undefined
  }
}
