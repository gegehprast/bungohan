/**
 * Bandwidth regression suite (spec §11.1). Encodes representative ticks with
 * MessagePack — the Phase 1 state codec (§8.1.3) — and asserts byte
 * ceilings, so a refactor that silently reverts to fat encoding fails CI.
 * Measured sizes are recorded in the test names; ceilings leave ~10% slack.
 */
import { describe, expect, test } from "bun:test"
import type { WireOp } from "@bungohan/types"
import { encode } from "@msgpack/msgpack"
import { clearChangeTrees, encodeSnapshot, generateDeltas } from "./encoder"
import {
  createBoolean,
  createFixedPoint,
  createNumber,
  createSchemaMap,
  createString,
} from "./factories"
import { Schema } from "./schema"

class Entity extends Schema {
  public static override schemaName = "B.Entity"
  public x = createFixedPoint(2)
  public y = createFixedPoint(2)
  public angle = createFixedPoint(3)
  public hp = createNumber(100)
  public alive = createBoolean(true)
  public kind = createString("npc")
}

class World extends Schema {
  public static override schemaName = "B.World"
  public tick = createNumber()
  public entities = createSchemaMap<number, Entity>()
}

function bytes(ops: WireOp[]): number {
  return ops.length === 0 ? 0 : encode(ops).byteLength
}

/** A world of `n` entities, already snapshotted (so deltas are live). */
function world(n: number): World {
  const w = new World()
  for (let i = 0; i < n; i++) w.entities.set(i, entity(i))
  encodeSnapshot(w).unwrap()
  return w
}

function entity(i: number): Entity {
  const e = new Entity()
  e.x.set(i * 3.25)
  e.y.set(i * 1.5)
  return e
}

function tick(w: World): number {
  const size = bytes(generateDeltas(w))
  clearChangeTrees(w)
  return size
}

describe("bandwidth (MessagePack, Phase 1)", () => {
  test("idle tick: 0 bytes", () => {
    const w = world(100)
    expect(tick(w)).toBe(0)
    expect(tick(w)).toBe(0)
  })

  test("one position update in a 100-entity room: 8 bytes", () => {
    const w = world(100)
    w.entities.get(57)?.x.set(145.5)
    // [[0, ref, 0, 14550]]: outer array 1 + op array 1 + code 1 + ref 1 +
    // field 1 + uint16 value 3. (A float64 value alone would be 9 bytes.)
    expect(tick(w)).toBeLessThanOrEqual(8)
  })

  test("all 100 entities move (worst-case tick): 1396 bytes", () => {
    const w = world(100)
    let t = 1
    for (const e of w.entities.values()) {
      e.x.set(e.x.get() + 0.37 * t)
      e.y.set(e.y.get() - 0.21 * t)
      t++
    }
    const size = tick(w)
    expect(size).toBeLessThanOrEqual(1540)
    // ~14 bytes per entity for two fixed-point coordinates.
    expect(size / 100).toBeLessThan(15)
  })

  test("entity churn: spawn 10 + despawn 10 in one tick: 433 bytes", () => {
    const w = world(100)
    for (let i = 0; i < 10; i++) w.entities.delete(i)
    for (let i = 100; i < 110; i++) w.entities.set(i, entity(i))
    expect(tick(w)).toBeLessThanOrEqual(480)
  })

  test("initial join snapshot of 100 entities: 4006 bytes", () => {
    const w = new World()
    for (let i = 0; i < 100; i++) w.entities.set(i, entity(i))
    // ~40 B/entity: non-zero defaults (hp=100, alive, kind) are sent, since
    // receivers start instances at type zero values (spec §5.7.9).
    const size = bytes(encodeSnapshot(w).unwrap())
    expect(size).toBeLessThanOrEqual(4400)
  })
})
