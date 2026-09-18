/**
 * Bandwidth regression suite (spec §11.1). Encodes representative ticks with
 * MessagePack — the Phase 1 state codec (§8.1.3) — and asserts byte
 * ceilings, so a refactor that silently reverts to fat encoding fails CI.
 * Measured sizes are recorded in the test names; ceilings leave ~10% slack.
 */
import { describe, expect, test } from "bun:test"
import type { WireOp } from "@bungohan/types"
import { encode } from "@msgpack/msgpack"
import { applyDelta } from "./decoder"
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
  /**
   * Long-running churn: refIds are reused (spec §5.7.9), so they stay small
   * and a tick's size never grows with room age. Without reuse the refIds
   * here would climb to ~90,000, and every refId occurrence in a spawn (its
   * placement plus one per content SET) would widen from 1 to 3–5 bytes.
   */
  test("30,000 ticks of churn: flat at 138 bytes per tick", () => {
    const SPAWN = 3
    const LIFETIME = 30
    const TICKS = 30_000
    // Fixed-width keys (all encode as uint16), so only refIds could drift.
    const keyOf = (serial: number): number => 1000 + (serial % 1000)
    const spawn = (): Entity => {
      const e = new Entity()
      e.x.set(1.5)
      e.y.set(2.5)
      return e
    }

    const w = new World()
    const client = new World()
    expect(applyDelta(client, encodeSnapshot(w).unwrap()).isOk()).toBe(true)

    const sizes: number[] = []
    for (let t = 0; t < TICKS; t++) {
      for (let j = 0; j < SPAWN; j++) {
        w.entities.set(keyOf(t * SPAWN + j), spawn())
        if (t >= LIFETIME) w.entities.delete(keyOf((t - LIFETIME) * SPAWN + j))
      }
      const ops = generateDeltas(w)
      sizes.push(bytes(ops))
      const applied = applyDelta(client, ops)
      if (applied.isErr()) throw applied.error
      clearChangeTrees(w)
    }

    // Steady state begins once the first entities start dying.
    const early = sizes.slice(LIFETIME, LIFETIME + 100)
    const late = sizes.slice(-100)
    const steady = 138
    expect(sizes[LIFETIME]).toBe(steady)
    expect(new Set(early)).toEqual(new Set([steady]))
    expect(late).toEqual(early)
    expect(Math.max(...sizes.slice(LIFETIME))).toBe(steady)

    // The receiver kept up and holds only the live entities.
    expect(client.entities.size).toBe(SPAWN * LIFETIME)
    expect(w.entities.size).toBe(SPAWN * LIFETIME)
  })
})
