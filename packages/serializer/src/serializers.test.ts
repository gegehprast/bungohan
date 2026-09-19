import { describe, expect, test } from "bun:test"
import { encode } from "@msgpack/msgpack"
import { JsonSerializer } from "./json"
import { MessagePackSerializer } from "./messagepack"

describe("MessagePackSerializer", () => {
  const s = new MessagePackSerializer()

  test("round-trips, dropping undefined properties", () => {
    const bytes = s.encode({ a: 1, b: undefined, c: [1, "x", true] })
    expect(bytes.isOk()).toBe(true)
    const back = s.decode(bytes.unwrap())
    expect(back.unwrap()).toEqual({ a: 1, c: [1, "x", true] })
  })

  test("output is owned by the caller, not a view of a reused buffer", () => {
    const first = s.encode([1, 2, 3]).unwrap()
    const copy = Uint8Array.from(first)
    s.encode(["something", "much", "longer", 123456789])
    expect(first).toEqual(copy)
  })

  test("positional arrays cost no key strings", () => {
    const keyed = s.encode({ x: 1000, y: 2000 }).unwrap()
    const positional = s.encode([1000, 2000]).unwrap()
    expect(positional.byteLength).toBe(7)
    expect(keyed.byteLength).toBe(11)
  })

  test("strings are Unicode scalar values: U+0000 and lone surrogates become U+FFFD (PROTOCOL.md §1.3)", () => {
    const hex = (value: unknown): string =>
      Buffer.from(s.encode(value).unwrap()).toString("hex")
    expect(hex("a\u0000b")).toBe("a561efbfbd62")
    expect(hex("a\ud800b")).toBe("a561efbfbd62")
    expect(hex("\udc00\ud83d\ude00")).toBe("a7efbfbdf09f9880")
    // Nested values and map keys too; other values are untouched.
    expect(
      s.decode(s.encode({ "k\u0000": ["\u0000", 1] }).unwrap()).unwrap(),
    ).toEqual({ "k\ufffd": ["\ufffd", 1] })
    const bytes = Uint8Array.of(0, 1)
    expect(hex({ b: bytes, n: null, t: true })).toBe(
      "83a162c4020001a16ec0a174c3",
    )
  })

  test("bad input is an error result, never a throw", () => {
    const valid = encode({ a: [1, 2, 3] })
    for (const data of [
      valid.subarray(0, valid.length - 1), // truncated
      Uint8Array.of(...valid, 0x01), // trailing bytes
      Uint8Array.of(0xc1), // never-used type byte
      // { "__proto__": 1 }: fixmap(1), fixstr(9) "__proto__", 1
      Uint8Array.of(0x81, 0xa9, ...new TextEncoder().encode("__proto__"), 1),
      new Uint8Array(0),
    ]) {
      const result = s.decode(data)
      expect(result.isErr() && result.error.code).toBe("DECODE_FAILED")
    }
    const unencodable = s.encode({ f: () => 1 })
    expect(unencodable.isErr() && unencodable.error.code).toBe("ENCODE_FAILED")
    expect(s.getName()).toBe("messagepack")
  })
})

describe("JsonSerializer (debug)", () => {
  const s = new JsonSerializer()

  test("round-trips, including Uint8Array", () => {
    const value = { bytes: Uint8Array.of(1, 2, 255), list: [1, "a", null] }
    expect(s.decode(s.encode(value).unwrap()).unwrap()).toEqual(value)
    expect(s.decode(s.encode(undefined).unwrap()).unwrap()).toBeNull()
  })

  test("a wrapped-bytes lookalike with non-byte data stays an object", () => {
    const fake = { __type: "Uint8Array", data: [1, 300] }
    expect(s.decode(s.encode(fake).unwrap()).unwrap()).toEqual(fake)
  })

  test("bad input is an error result", () => {
    const bad = s.decode(new TextEncoder().encode("{nope"))
    expect(bad.isErr() && bad.error.code).toBe("DECODE_FAILED")
    const invalidUtf8 = s.decode(Uint8Array.of(0x22, 0xff, 0x22))
    expect(invalidUtf8.isErr()).toBe(true)
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const unencodable = s.encode(cyclic)
    expect(unencodable.isErr() && unencodable.error.code).toBe("ENCODE_FAILED")
    expect(s.getName()).toBe("json")
  })
})
