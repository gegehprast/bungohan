import { describe, expect, test } from "bun:test"
import { defineMessage, f } from "@bungohan/types"
import { JsonSerializer } from "./json"
import { packMessage, unpackMessage } from "./message-codec"
import { MessagePackSerializer } from "./messagepack"

const PlayerMove = defineMessage("playerMove", { x: f.fixed(2), y: f.fixed(2) })

const Point = defineMessage("point", { x: f.int16, y: f.int16 })

const Everything = defineMessage("everything", {
  i8: f.int8,
  u32: f.uint32,
  f32: f.float32,
  f64: f.float64,
  fx: f.fixed(3),
  s: f.string,
  b: f.bool,
  color: f.enum("red", "green", "blue"),
  list: f.array(f.string),
  scores: f.map(f.float64),
  at: f.nested(Point),
  maybeList: f.array(f.optional(f.int32)),
  note: f.optional(f.string),
  tag: f.optional(f.enum(1, 2, 3)),
})

const msgpack = new MessagePackSerializer()

describe("packMessage", () => {
  test("is positional, in declaration order", () => {
    expect(packMessage(PlayerMove, { x: 10, y: 20.5 }).unwrap()).toEqual([
      1000, 2050,
    ])
  })

  test("a keyed object would cost more than twice as much", () => {
    const positional = msgpack.encode(
      packMessage(PlayerMove, { x: 145.5, y: -3.25 }).unwrap(),
    )
    const keyed = msgpack.encode({ x: 145.5, y: -3.25 })
    // fixarray 1 + uint16 3 + int16 3 = 7; map 1 + ("x" 2 + float64 9) * 2 = 23
    expect(positional.unwrap().byteLength).toBe(7)
    expect(keyed.unwrap().byteLength).toBe(23)
  })

  test("applies each field kind's wire rules", () => {
    const packed = packMessage(Everything, {
      i8: 300, // saturates
      u32: -5.7, // saturates at 0
      f32: 0.1,
      f64: 0.1,
      fx: -2.0005, // half away from zero
      s: "hi",
      b: true,
      color: "blue",
      list: ["a"],
      scores: { k: 1.5 },
      at: { x: 1.9, y: -1.9 }, // truncates
      maybeList: [1, undefined, 3],
    }).unwrap()
    expect(packed).toEqual([
      127,
      0,
      Math.fround(0.1),
      0.1,
      -2001,
      "hi",
      true,
      2,
      ["a"],
      { k: 1.5 },
      [1, -1],
      [1, null, 3],
      // note and tag: trailing absent optionals are trimmed
    ])
  })

  test("only *trailing* absent optionals are trimmed", () => {
    const M = defineMessage("m", {
      a: f.optional(f.int8),
      b: f.int8,
      c: f.optional(f.int8),
    })
    expect(packMessage(M, { b: 1 }).unwrap()).toEqual([null, 1])
    expect(packMessage(M, { b: 1, c: 2 }).unwrap()).toEqual([null, 1, 2])
  })

  test("a payload that got past the types is an error, not a throw", () => {
    const payload: unknown = { color: "purple" }
    // @ts-expect-error — only reachable by getting past the types
    const bad = packMessage(Everything, payload)
    expect(bad.isErr() && bad.error.code).toBe("ENCODE_FAILED")
    expect(bad.isErr() && bad.error.message).toContain("everything.i8")
  })
})

describe("unpackMessage", () => {
  test("round-trips through MessagePack and JSON", () => {
    const payload = {
      i8: -5,
      u32: 4000000000,
      f32: Math.fround(1.5),
      f64: 0.1,
      fx: 12.345,
      s: "héllo",
      b: false,
      color: "green" as const,
      list: ["a", "b"],
      scores: { alice: 3, bob: -1.25 },
      at: { x: 7, y: -8 },
      maybeList: [1, undefined, 3],
      note: "n",
      tag: 3 as const,
    }
    for (const serializer of [msgpack, new JsonSerializer()]) {
      const bytes = serializer
        .encode(packMessage(Everything, payload).unwrap())
        .unwrap()
      const back = unpackMessage(Everything, serializer.decode(bytes).unwrap())
      expect(back.unwrap()).toEqual(payload)
    }
  })

  test("absent optionals are left out, not set to undefined", () => {
    const M = defineMessage("m", { a: f.int8, b: f.optional(f.string) })
    const back = unpackMessage(M, [1]).unwrap()
    expect(back).toEqual({ a: 1 })
    expect("b" in back).toBe(false)
  })

  test("the result is typed from the descriptor", () => {
    const move = unpackMessage(PlayerMove, [100, 200]).unwrap()
    const x: number = move.x
    // @ts-expect-error — no such field
    move.z
    expect(x).toBe(1)
  })

  test("decoding is type-directed: wrong shapes never reach a handler", () => {
    const cases: unknown[] = [
      "not an array",
      [1000], // missing required y
      [1000, 2000, 3000], // too many fields
      [1000, "2000"], // string for a fixed field
      [1000, 20.5], // fixed must be an integer on the wire
      [1000, 2 ** 31], // outside int32
    ]
    for (const wire of cases) {
      const result = unpackMessage(PlayerMove, wire)
      expect({ wire, code: result.isErr() && result.error.code }).toEqual({
        wire,
        code: "DECODE_FAILED",
      })
    }
  })

  test("every field kind is checked", () => {
    const M = defineMessage("m", {
      i: f.uint8,
      e: f.enum("a", "b"),
      l: f.array(f.bool),
      m: f.map(f.int8),
      n: f.nested(Point),
    })
    const good = [1, 0, [true], { k: 1 }, [1, 2]]
    expect(unpackMessage(M, good).isOk()).toBe(true)
    const mutations: Array<[number, unknown]> = [
      [0, 256], // out of uint8 range
      [0, -1],
      [1, 2], // enum index out of range
      [1, "a"], // enum values travel as indices
      [2, [1]], // bool list holding a number
      [3, { k: 1.5 }], // int8 value not an integer
      [3, [1]], // map as array
      [4, [1]], // nested missing a field
      [4, { x: 1, y: 2 }], // nested must be positional
    ]
    for (const [index, value] of mutations) {
      const wire: unknown[] = [...good]
      wire[index] = value
      const result = unpackMessage(M, wire)
      expect({ index, value, ok: result.isOk() }).toEqual({
        index,
        value,
        ok: false,
      })
    }
  })

  test("a map key that would replace the prototype is rejected", () => {
    const M = defineMessage("m", { m: f.map(f.int8) })
    const wire = JSON.parse('[{"__proto__": 1}]')
    const result = unpackMessage(M, wire)
    expect(result.isErr() && result.error.code).toBe("DECODE_FAILED")
  })

  test("error messages name the offending field", () => {
    const result = unpackMessage(Everything, [1, 2, 3, 4, 5, "s", "no"])
    expect(result.isErr() && result.error.message).toBe(
      "everything.b: expected bool",
    )
  })
})
