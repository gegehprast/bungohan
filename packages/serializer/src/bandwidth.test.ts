/**
 * Bandwidth regression suite (spec §11.1), run against both state codecs:
 * the default tag-free `schema` codec (PROTOCOL.md §13.1) and `messagepack`
 * (§13.2). Measured sizes are recorded in the test names and in
 * REBUILD_SPEC.md §11.1; the ceilings are those numbers plus ~5%, so a
 * refactor that silently fattens the wire fails CI. Sizes are op bodies
 * (what a codec returns); a frame adds its 2-byte header (type, roomRef).
 */
import { describe, expect, test } from "bun:test"
import {
  applyDelta,
  clearChangeTrees,
  createBoolean,
  createFixedPoint,
  createNumber,
  createSchemaMap,
  createString,
  encodeSnapshot,
  generateDeltas,
  Schema,
} from "@bungohan/state"
import { f, type WireOp } from "@bungohan/types"
import { SchemaCodec } from "./schema-codec"
import {
  type IStateCodec,
  type IStateCodecSession,
  MessagePackStateCodec,
} from "./state-codec"

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
  public entities = createSchemaMap(f.uint32, Entity)
}

function entity(i: number): Entity {
  const e = new Entity()
  e.x.set(i * 3.25)
  e.y.set(i * 1.5)
  return e
}

/**
 * A world of `n` entities whose snapshot went through `session`, as it would
 * on a live server, so deltas are live and the session knows every refId.
 */
function world(session: IStateCodecSession, n: number): World {
  const w = new World()
  for (let i = 0; i < n; i++) w.entities.set(i, entity(i))
  session.encodeOps(encodeSnapshot(w).unwrap()).unwrap()
  return w
}

function size(session: IStateCodecSession, ops: WireOp[]): number {
  return ops.length === 0 ? 0 : session.encodeOps(ops).unwrap().byteLength
}

function tick(session: IStateCodecSession, w: World): number {
  const bytes = size(session, generateDeltas(w))
  clearChangeTrees(w)
  return bytes
}

interface Scenario {
  /** Measured bytes per codec. */
  readonly measured: { readonly schema: number; readonly messagepack: number }
  run(codec: IStateCodec): number
}

const scenarios: Record<string, Scenario> = {
  "idle tick": {
    measured: { schema: 0, messagepack: 0 },
    run(codec) {
      const session = codec.createSession()
      const w = world(session, 100)
      return tick(session, w) + tick(session, w)
    },
  },
  "one position update in a 100-entity room": {
    // schema: SET header (field 0) 1 + refId 1 + zigzag(14550) 3.
    // messagepack: [[0, ref, 0, 14550]]: 2 array headers, code, ref,
    // field, uint16 3. (A float64 value alone would be 9 bytes.)
    measured: { schema: 5, messagepack: 8 },
    run(codec) {
      const session = codec.createSession()
      const w = world(session, 100)
      w.entities.get(57)?.x.set(145.5)
      return tick(session, w)
    },
  },
  "one entity moves on both axes": {
    // schema: 5 for x, then 3 for y: the second SET reuses the target
    // (S bit), so it is the header and zigzag(-325) only.
    measured: { schema: 8, messagepack: 15 },
    run(codec) {
      const session = codec.createSession()
      const w = world(session, 100)
      const e = w.entities.get(57)
      e?.x.set(145.5)
      e?.y.set(-3.25)
      return tick(session, w)
    },
  },
  "all 100 entities move (worst-case tick)": {
    measured: { schema: 811, messagepack: 1396 },
    run(codec) {
      const session = codec.createSession()
      const w = world(session, 100)
      let t = 1
      for (const e of w.entities.values()) {
        e.x.set(e.x.get() + 0.37 * t)
        e.y.set(e.y.get() - 0.21 * t)
        t++
      }
      return tick(session, w)
    },
  },
  "entity churn: spawn 10 + despawn 10 in one tick": {
    measured: { schema: 310, messagepack: 433 },
    run(codec) {
      const session = codec.createSession()
      const w = world(session, 100)
      for (let i = 0; i < 10; i++) w.entities.delete(i)
      for (let i = 100; i < 110; i++) w.entities.set(i, entity(i))
      return tick(session, w)
    },
  },
  "initial join snapshot of 100 entities": {
    // ~40 B/entity in MessagePack, ~29 B in schema: non-zero defaults
    // (hp=100 as a float64, alive, kind) are sent, since receivers start
    // instances at zero values (PROTOCOL.md §11.5). The leading DEFINEs
    // are 145 B (messagepack) / 140 B (schema).
    measured: { schema: 2953, messagepack: 4032 },
    run(codec) {
      const w = new World()
      for (let i = 0; i < 100; i++) w.entities.set(i, entity(i))
      return size(codec.createSession(), encodeSnapshot(w).unwrap())
    },
  },
}

const codecs: [name: "schema" | "messagepack", codec: IStateCodec][] = [
  ["schema", new SchemaCodec()],
  ["messagepack", new MessagePackStateCodec()],
]

describe("bandwidth: schema vs messagepack", () => {
  for (const [label, scenario] of Object.entries(scenarios)) {
    const { schema, messagepack } = scenario.measured
    test(`${label}: schema ${schema} B, messagepack ${messagepack} B`, () => {
      for (const [name, codec] of codecs) {
        const bytes = scenario.run(codec)
        const ceiling = Math.ceil(scenario.measured[name] * 1.05)
        expect({ codec: name, bytes: Math.min(bytes, ceiling) }).toEqual({
          codec: name,
          bytes,
        })
      }
      expect(schema).toBeLessThanOrEqual(messagepack)
    })
  }

  test("§8.1.2's example op [SET, refId 12, field 3, 145.5 at 2 dp]: 5 bytes, not the predicted 4", () => {
    // 1 header (F = 3) + 1 refId + 3 value: zigzag(14550) = 29100 needs a
    // 3-byte varint. The prediction counted 2, which holds for |value| up
    // to 81.91 at 2 dp (zigzag ≤ 16383), or 145.5 at 1 dp (zigzag 2910).
    const session = new SchemaCodec().createSession()
    session
      .encodeOps([
        [4, 0, "R", ["ps"], ["schemaMap<uint32,P>"]],
        [
          4,
          1,
          "P",
          ["a", "b", "c", "x"],
          ["float64", "float64", "float64", "fixed:2"],
        ],
        [1, 1, 0, [1, 12]], // binds refId 12 to a P
      ])
      .unwrap()
    expect(session.encodeOps([[0, 12, 3, 14550]]).unwrap()).toEqual(
      new Uint8Array([0x03, 0x0c, 0xac, 0xe3, 0x01]),
    )
  })
})

describe("30,000 ticks of churn stay flat (refId reuse, spec §5.7.9)", () => {
  /**
   * Without reuse the refIds here would climb to ~90,000, and every refId
   * occurrence in a spawn (its placement plus one per content SET) would
   * widen from 1 to 3–5 bytes.
   */
  for (const [name, codec, steady] of [
    // schema, per spawn: ADD 5–6 + content 22 (x 3, y 3, hp 9, alive 2,
    // kind 5); per despawn: REMOVE 4.
    ["schema", new SchemaCodec(), 94],
    ["messagepack", new MessagePackStateCodec(), 138],
  ] as const) {
    test(`${name}: ${steady} bytes per tick`, () => {
      const SPAWN = 3
      const LIFETIME = 30
      const TICKS = 30_000
      // Keys of one width (2 bytes in schema, 3 in messagepack), so only
      // refIds could drift.
      const keyOf = (serial: number): number => 1000 + (serial % 1000)
      const spawn = (): Entity => {
        const e = new Entity()
        e.x.set(1.5)
        e.y.set(2.5)
        return e
      }

      const w = new World()
      const client = new World()
      const server = codec.createSession()
      const receiver = codec.createSession()
      const snapshot = server.encodeOps(encodeSnapshot(w).unwrap()).unwrap()
      applyDelta(client, receiver.decodeOps(snapshot).unwrap()).unwrap()

      const sizes: number[] = []
      for (let t = 0; t < TICKS; t++) {
        for (let j = 0; j < SPAWN; j++) {
          w.entities.set(keyOf(t * SPAWN + j), spawn())
          if (t >= LIFETIME) {
            w.entities.delete(keyOf((t - LIFETIME) * SPAWN + j))
          }
        }
        const bytes = server.encodeOps(generateDeltas(w)).unwrap()
        sizes.push(bytes.byteLength)
        const applied = applyDelta(client, receiver.decodeOps(bytes).unwrap())
        if (applied.isErr()) throw applied.error
        clearChangeTrees(w)
      }

      // Steady state begins once the first entities start dying.
      const early = sizes.slice(LIFETIME, LIFETIME + 100)
      const late = sizes.slice(-100)
      expect(sizes[LIFETIME]).toBe(steady)
      expect(new Set(early)).toEqual(new Set([steady]))
      expect(late).toEqual(early)
      expect(Math.max(...sizes.slice(LIFETIME))).toBe(steady)
      expect(client.entities.size).toBe(SPAWN * LIFETIME)
    })
  }
})
