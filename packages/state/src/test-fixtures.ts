/**
 * Shared fixtures for this package's tests (not exported from the package).
 */
import { expect } from "bun:test"
import { f, type WireOp } from "@bungohan/types"
import { ArrayBase, CollectionState, MapBase, SetBase } from "./collections"
import { applyDelta } from "./decoder"
import { clearChangeTrees, encodeSnapshot, generateDeltas } from "./encoder"
import {
  createArray,
  createBoolean,
  createFixedPoint,
  createFloat32,
  createMap,
  createNumber,
  createSchemaArray,
  createSchemaMap,
  createSchemaSet,
  createSet,
  createString,
} from "./factories"
import { FixedPointState, Float32State, PrimitiveState } from "./primitives"
import { fieldValue, Schema } from "./schema"

export class Vec extends Schema {
  public static override schemaName = "T.Vec"
  public x = createNumber()
  public y = createNumber()
}

export class Item extends Schema {
  public static override schemaName = "T.Item"
  public name = createString()
  public qty = createNumber()
}

export class Player extends Schema {
  public static override schemaName = "T.Player"
  public name = createString()
  public x = createFixedPoint(2)
  /** Non-zero initializer: receivers must still end up at server values. */
  public hp = createNumber(100)
  public alive = createBoolean(true)
  public pos = new Vec()
  public items = createSchemaArray(Item)
  public tags = createSet(f.string)
  /** Lossy values: quantized to 1 dp on the wire. */
  public scores = createMap(f.string, f.fixed(1))
}

export class GameRoom extends Schema {
  public static override schemaName = "T.GameRoom"
  public tick = createNumber()
  public title = createString()
  public speed = createFloat32()
  public players = createSchemaMap(f.string, Player)
  public log = createArray(f.string)
  public bag = createSchemaSet(Item)
  /** Lossy elements: sent at float32 precision. */
  public samples = createArray(f.float32)
  /** Integer keys. */
  public ranks = createMap(f.uint16, f.bool)
}

export function player(name: string, x = 0): Player {
  const p = new Player()
  p.name.set(name)
  p.x.set(x)
  return p
}

export function item(name: string, qty = 1): Item {
  const i = new Item()
  i.name.set(name)
  i.qty.set(qty)
  return i
}

/** Plain-data view of a schema tree, for deep equality between peers. */
export function plain(value: unknown): unknown {
  if (value instanceof Schema) {
    const out: Record<string, unknown> = {}
    for (const field of value._ensureInit().fields) {
      out[field.name] = plain(fieldValue(value, field.name))
    }
    return out
  }
  // Lossy fields differ between peers by design; compare what's on the wire.
  if (value instanceof FixedPointState || value instanceof Float32State) {
    return value._toWire()
  }
  if (value instanceof PrimitiveState) return value.get()
  if (value instanceof CollectionState) {
    // Elements, too, are compared as they go on the wire.
    const element = (v: unknown): unknown =>
      v instanceof Schema ? plain(v) : value._toWire(v)
    if (value instanceof MapBase) {
      const out: Record<string, unknown> = {}
      for (const [key, v] of value) out[`${typeof key}:${key}`] = element(v)
      return out
    }
    if (value instanceof SetBase) {
      return [...value]
        .map(element)
        .sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1))
    }
    if (value instanceof ArrayBase) return value.map(element)
    return "?"
  }
  return value
}

/**
 * Every refId held by a known instance or collection reachable from `root`,
 * as refId → holder. Fails on any duplicate.
 */
export function liveRefs(root: Schema): Map<number, object> {
  const refs = new Map<number, object>()
  const claim = (ref: number, holder: object, path: string): void => {
    const other = refs.get(ref)
    if (other !== undefined && other !== holder) {
      throw new Error(`refId ${ref} is held by two live objects (at ${path})`)
    }
    refs.set(ref, holder)
  }
  const walk = (instance: Schema, path: string): void => {
    if (instance._wireRef === -1) {
      throw new Error(`unsent instance in tree (at ${path})`)
    }
    claim(instance._wireRef, instance, path)
    for (const field of instance._ensureInit().fields) {
      const value = fieldValue(instance, field.name)
      const at = `${path}.${field.name}`
      if (value instanceof Schema) walk(value, at)
      else if (value instanceof CollectionState) {
        claim(value._wireRef, value, at)
        let index = 0
        for (const element of value._elements()) {
          if (element instanceof Schema) walk(element, `${at}[${index}]`)
          index++
        }
      }
    }
  }
  walk(root, "root")
  return refs
}

/** A server root and one client replica, synced like core would. */
export class Peer<T extends Schema> {
  public readonly server: T
  public readonly client: T

  public constructor(server: T, client: T) {
    this.server = server
    this.client = client
  }

  /** Snapshot → client (the join). */
  public join(): WireOp[] {
    const ops = encodeSnapshot(this.server).unwrap()
    const applied = applyDelta(this.client, ops)
    if (applied.isErr()) throw applied.error
    return ops
  }

  /** One sync tick: generate → apply → clear. Returns the ops sent. */
  public sync(): WireOp[] {
    const ops = generateDeltas(this.server)
    const applied = applyDelta(this.client, ops)
    if (applied.isErr()) throw applied.error
    clearChangeTrees(this.server)
    return ops
  }

  /** Same values, and every live server refId held by one object. */
  public expectInSync(): void {
    expect(plain(this.client)).toEqual(plain(this.server))
    liveRefs(this.server)
  }
}
