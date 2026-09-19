/**
 * SchemaCodec beyond the conformance vectors: seeded random streams from the
 * real state layer (every field and collection type, filtering, late
 * joiners, refId reuse) must round-trip op for op, and a replica fed by the
 * schema codec must end up identical to one fed by MessagePack. Plus the
 * session's all-or-nothing frames, and the byte writer's growth paths.
 */
import { describe, expect, test } from "bun:test"
import {
  applyDelta,
  clearChangeTrees,
  createArray,
  createBoolean,
  createFiltered,
  createFixedPoint,
  createFloat32,
  createInt,
  createMap,
  createNumber,
  createSchemaArray,
  createSchemaMap,
  createSchemaSet,
  createSet,
  createString,
  encodeSnapshot,
  generateDeltas,
  Schema,
  SchemaRegistry,
  toPlain,
} from "@bungohan/state"
import { defineMessage, f, type WireOp } from "@bungohan/types"
import { ByteReader, ByteWriter } from "./bytes"
import { SchemaCodec } from "./schema-codec"
import { type IStateCodecSession, MessagePackStateCodec } from "./state-codec"

class Item extends Schema {
  public static override schemaName = "SCC.Item"
  public name = createString()
  public n = createInt(f.uint8)
  public tags = createSet(f.string)
}

/** A subclass: its refs carry their own classId. */
class Special extends Item {
  public static override schemaName = "SCC.Special"
  public power = createFloat32()
}

class Box extends Schema {
  public static override schemaName = "SCC.Box"
  public f64 = createNumber()
  public f32 = createFloat32()
  public fx = createFixedPoint(2)
  public s = createString()
  public b = createBoolean()
  public i8 = createInt(f.int8)
  public i32 = createInt(f.int32)
  public u32 = createInt(f.uint32)
  public nested = new Item()
  public m = createMap(f.string, f.fixed(1))
  public fk = createMap(f.float64, f.bool)
  public set = createSet(f.int16)
  public floats = createArray(f.float32)
  public words = createArray(f.string)
  public items = createSchemaMap(f.uint16, Item)
  public bag = createSchemaSet(Item)
  public list = createSchemaArray(Item)
  public owner = createString()
  public secret = createFiltered(createString(), function (this: Box, client) {
    return this.owner.get() === client.id
  })
  public a1 = createNumber()
  public a2 = createNumber()
  public a3 = createNumber()
  public a4 = createNumber() // field 22: past the header's F escape
}

SchemaRegistry.register(Item)
SchemaRegistry.register(Special)

/** mulberry32 */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface Viewer {
  readonly id: string
  readonly schema: IStateCodecSession
  readonly mp: IStateCodecSession
  readonly viaSchema: Box
  readonly viaMp: Box
}

const schema = new SchemaCodec()
const messagepack = new MessagePackStateCodec()

function run(seed: number, ticks: number): { ops: number; bytes: number } {
  const random = rng(seed)
  const int = (n: number): number => Math.floor(random() * n)
  const pick = <T>(xs: readonly T[]): T | undefined => xs[int(xs.length)]
  const item = (): Item => {
    const it = random() < 0.2 ? new Special() : new Item()
    it.name.set(pick(["", "a", "sword", "ドラゴン"]) ?? "")
    it.n.set(int(256))
    if (random() < 0.5) it.tags.add(`t${int(4)}`)
    if (it instanceof Special) it.power.set(random() * 100)
    return it
  }

  const server = new Box()
  server.owner.set("a")
  const serverSchema = schema.createSession()
  const serverMp = messagepack.createSession()
  const viewers: Viewer[] = []
  let opCount = 0
  let byteCount = 0

  /** Encodes once per distinct array, as core does; every viewer decodes. */
  const deliver = (frames: Map<Viewer, WireOp[]>): void => {
    const encoded = new Map<WireOp[], [Uint8Array, Uint8Array]>()
    for (const [viewer, ops] of frames) {
      if (ops.length === 0) continue
      let bytes = encoded.get(ops)
      if (bytes === undefined) {
        bytes = [
          serverSchema.encodeOps(ops).unwrap(),
          serverMp.encodeOps(ops).unwrap(),
        ]
        encoded.set(ops, bytes)
        opCount += ops.length
        byteCount += bytes[0].byteLength
      }
      const viaSchema = viewer.schema.decodeOps(bytes[0]).unwrap()
      const viaMp = viewer.mp.decodeOps(bytes[1]).unwrap()
      expect(viaSchema).toEqual(ops)
      expect(viaMp).toEqual(ops)
      applyDelta(viewer.viaSchema, viaSchema).unwrap()
      applyDelta(viewer.viaMp, viaMp).unwrap()
    }
  }

  const join = (id: string): void => {
    const viewer: Viewer = {
      id,
      schema: schema.createSession(),
      mp: messagepack.createSession(),
      viaSchema: new Box(),
      viaMp: new Box(),
    }
    viewers.push(viewer)
    deliver(new Map([[viewer, encodeSnapshot(server, viewer).unwrap()]]))
  }

  const mutations: Array<() => void> = [
    () => server.f64.set(random() < 0.1 ? Number.NaN : random() * 1e6 - 5e5),
    () => server.f32.set(random() * 10 - 5),
    () => server.fx.set(int(2_000_000) / 100 - 10_000),
    () => server.s.set(pick(["", "x", "héllo", "a".repeat(60)]) ?? ""),
    () => server.b.set(random() < 0.5),
    () => server.i8.set(int(256) - 128),
    () => server.i32.set(int(2 ** 32) - 2 ** 31),
    () => server.u32.set(int(2 ** 32)),
    () => server.nested.n.set(int(256)),
    () => server.nested.tags.add(`n${int(5)}`),
    () => server.m.set(`k${int(6)}`, int(1000) / 10),
    () => server.m.delete(`k${int(6)}`),
    () =>
      server.fk.set(pick([-1.5, 0.25, 1e300, Math.PI]) ?? 0, random() < 0.5),
    () => server.set.add(int(65536) - 32768),
    () => server.set.delete(pick([...server.set.value]) ?? 0),
    () => server.floats.push(random()),
    () => server.floats.splice(0, 1),
    () => server.words.push(`w${int(9)}`),
    () => {
      if (server.words.length > 0) server.words.set(0, `r${int(9)}`)
    },
    () => server.items.set(int(70000) % 65536, item()),
    () => server.items.delete(pick([...server.items.keys()]) ?? 0),
    () => pick([...server.items.values()])?.n.set(int(256)),
    () => server.bag.add(item()),
    () => {
      const gone = pick([...server.bag.value])
      if (gone !== undefined) server.bag.delete(gone)
    },
    () => server.list.push(item()),
    () => server.list.splice(int(Math.max(1, server.list.length)), 1),
    () => {
      // A move: from the map into the array, in one tick.
      const key = pick([...server.items.keys()])
      const moved = key === undefined ? undefined : server.items.get(key)
      if (key === undefined || moved === undefined) return
      server.items.delete(key)
      server.list.push(moved)
    },
    () => {
      if (random() < 0.05) server.items.clear()
    },
    () => server.secret.set(`s${int(9)}`),
    () => server.owner.set(pick(["a", "b", "c"]) ?? "a"),
    () => server.a4.set(int(100)),
  ]

  join("a")
  for (let t = 0; t < ticks; t++) {
    const changes = 1 + int(6)
    for (let i = 0; i < changes; i++) pick(mutations)?.()
    deliver(generateDeltas(server, viewers))
    clearChangeTrees(server)
    if (t % 40 === 20) join(`late${t}`)
    if (t === 10) join("b")
  }
  for (const viewer of viewers) {
    expect(toPlain(viewer.viaSchema)).toEqual(toPlain(viewer.viaMp))
  }
  return { ops: opCount, bytes: byteCount }
}

describe("SchemaCodec round trips real state streams", () => {
  for (const seed of [1, 2, 3, 42, 1337, 9001]) {
    test(`seed ${seed}`, () => {
      const { ops, bytes } = run(seed, 300)
      expect(ops).toBeGreaterThan(500)
      expect(bytes).toBeGreaterThan(0)
    })
  }
})

describe("a frame is all or nothing", () => {
  const define: WireOp = [4, 0, "R", ["v", "list"], ["uint8", "schemaArray<R>"]]

  test("a failed encode keeps nothing from the frame", () => {
    const session = schema.createSession()
    expect(session.encodeOps([define, [0, 0, 0, 300]]).isErr()).toBe(true)
    expect(session.getTable().classes).toEqual([])
    // The same DEFINE is new again, and encodes exactly as in a fresh one.
    const fresh = schema.createSession().encodeOps([define]).unwrap()
    expect(session.encodeOps([define]).unwrap()).toEqual(fresh)
  })

  test("a failed encode keeps no refIds it bound", () => {
    const session = schema.createSession()
    session.encodeOps([define]).unwrap()
    // Binds refId 5 (a new R at index 0), then fails.
    const bad = session.encodeOps([
      [1, 1, 0, [0, 5]],
      [0, 5, 0, 999],
    ])
    expect(bad.isErr()).toBe(true)
    expect(session.encodeOps([[0, 5, 0, 1]]).isErr()).toBe(true)
  })

  test("a failed decode keeps nothing either", () => {
    const encoder = schema.createSession()
    const good = encoder.encodeOps([define]).unwrap()
    const decoder = schema.createSession()
    const truncated = new Uint8Array([...good, 0x10])
    expect(decoder.decodeOps(truncated).isErr()).toBe(true)
    expect(decoder.getTable().classes).toEqual([])
    expect(decoder.decodeOps(good).unwrap()).toEqual([define])
  })
})

describe("byte writer", () => {
  test("strings of every length class round-trip", () => {
    const out = new ByteWriter()
    const samples = [
      "",
      "a".repeat(42),
      "a".repeat(43),
      "é".repeat(64),
      "☃".repeat(50),
      "𝄞".repeat(1000),
      "x".repeat(20_000),
    ]
    for (const text of samples) out.string(text)
    const input = new ByteReader(out.toBytes())
    for (const text of samples) expect(input.string()).toBe(text)
    expect(input.error).toBeUndefined()
    expect(input.done).toBe(true)
  })

  test("a lone surrogate is written as U+FFFD", () => {
    const out = new ByteWriter()
    out.string("a\ud800b")
    expect([...out.toBytes()]).toEqual([5, 0x61, 0xef, 0xbf, 0xbd, 0x62])
  })

  test("a leading byte-order mark is data, not stripped", () => {
    const out = new ByteWriter()
    out.string("﻿x")
    expect(new ByteReader(out.toBytes()).string()).toBe("﻿x")
  })

  test("large frames grow the buffer", () => {
    const session = schema.createSession()
    const ops: WireOp[] = [[4, 0, "L", ["a"], ["array<float64>"]]]
    for (let i = 0; i < 10_000; i++) ops.push([1, 1, i, i * 0.5])
    const bytes = session.encodeOps(ops).unwrap()
    expect(schema.createSession().decodeOps(bytes).unwrap()).toEqual(ops)
  })
})

describe("messages", () => {
  const Input = defineMessage("input", {
    up: f.bool,
    down: f.bool,
    left: f.bool,
    right: f.bool,
    rotation: f.fixed(2),
    shooting: f.bool,
  })
  const Row = defineMessage("row", {
    id: f.string,
    score: f.int32,
    rank: f.uint8,
    note: f.optional(f.string),
  })
  const Results = defineMessage("results", {
    rows: f.array(f.nested(Row)),
    by: f.map(f.optional(f.float64)),
    mode: f.enum("ffa", "teams"),
    ready: f.optional(f.bool),
  })

  test("random payloads decode to what MessagePack decodes", () => {
    const random = rng(7)
    for (let i = 0; i < 500; i++) {
      const input = {
        up: random() < 0.5,
        down: random() < 0.5,
        left: random() < 0.5,
        right: random() < 0.5,
        rotation: random() * 20 - 10,
        shooting: random() < 0.5,
      }
      const results = {
        rows: Array.from({ length: Math.floor(random() * 4) }, (_, n) => ({
          id: `p${n}`,
          score: Math.floor(random() * 1e6) - 5e5,
          rank: n + 1,
          ...(random() < 0.5 ? { note: "mvp" } : {}),
        })),
        by: { a: random(), b: undefined },
        mode: random() < 0.5 ? ("ffa" as const) : ("teams" as const),
        ...(random() < 0.5 ? { ready: random() < 0.5 } : {}),
      }
      for (const [def, payload] of [
        [Input, input],
        [Results, results],
      ] as const) {
        const viaSchema = schema.decodeMessage(
          def,
          schema.encodeMessage(def, payload).unwrap(),
        )
        const viaMp = messagepack.decodeMessage(
          def,
          messagepack.encodeMessage(def, payload).unwrap(),
        )
        expect(viaSchema.unwrap()).toEqual(viaMp.unwrap())
      }
    }
  })

  test("the input message is 3 bytes instead of 9", () => {
    const payload = {
      up: false,
      down: false,
      left: true,
      right: false,
      rotation: 3.14,
      shooting: true,
    }
    expect(schema.encodeMessage(Input, payload).unwrap().byteLength).toBe(3)
    expect(messagepack.encodeMessage(Input, payload).unwrap().byteLength).toBe(
      9,
    )
  })

  test("a payload that got past the types is ENCODE_FAILED", () => {
    const bad: unknown = { rows: [], by: {}, mode: "coop" }
    const result = schema.encodeMessage(Results, bad)
    expect(result.isErr() && result.error.code).toBe("ENCODE_FAILED")
  })
})
