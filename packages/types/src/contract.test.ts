import { describe, expect, test } from "bun:test"
import { defineContract, defineMessage, f, isIntegerLikeKey } from "./contract"

describe("field builders", () => {
  test("scalars are frozen constant descriptors", () => {
    expect(f.int32).toEqual({ kind: "int32" })
    expect(f.bool).toEqual({ kind: "bool" })
    expect(Object.isFrozen(f.string)).toBe(true)
  })

  test("parameterized builders produce descriptors", () => {
    expect(f.fixed(2)).toEqual({ kind: "fixed", decimals: 2 })
    expect(f.enum("a", "b")).toEqual({ kind: "enum", values: ["a", "b"] })
    expect(f.array(f.string)).toEqual({ kind: "array", of: { kind: "string" } })
    expect(f.map(f.int8)).toEqual({ kind: "map", of: { kind: "int8" } })
    expect(f.optional(f.bool)).toEqual({
      kind: "optional",
      of: { kind: "bool" },
    })
  })
})

describe("defineMessage", () => {
  test("captures name, fields and positional field order", () => {
    const Vec = defineMessage("vec", { x: f.float32, y: f.float32 })
    const M = defineMessage("m", {
      b: f.string,
      a: f.nested(Vec),
      c: f.optional(f.int8),
    })

    expect(M.kind).toBe("message")
    expect(M.name).toBe("m")
    expect(M.fieldNames).toEqual(["b", "a", "c"])
    expect(M.fields.a).toEqual({ kind: "nested", message: Vec })
    expect(Object.isFrozen(M)).toBe(true)
  })
})

describe("integer-like field names", () => {
  test("isIntegerLikeKey matches exactly the keys JS reorders", () => {
    for (const key of ["0", "7", "42", "4294967294"]) {
      expect(isIntegerLikeKey(key)).toBe(true)
    }
    for (const key of ["07", "-1", "1.5", "1e3", "x1", "", "4294967295"]) {
      expect(isIntegerLikeKey(key)).toBe(false)
    }
  })

  test("defineMessage rejects them once, at definition time", () => {
    // Untyped callers (plain JS, dynamic shapes) reach the runtime check.
    const shape: Record<string, typeof f.int8> = { b: f.int8, 1: f.int8 }
    expect(() => defineMessage("bad", shape)).toThrow(TypeError)
    expect(() => defineMessage("bad", shape)).toThrow('"1"')
    // Keys JS keeps in insertion order pass the runtime check (the types
    // are stricter and reject every numeric-looking name).
    const zeroPadded: Record<string, typeof f.int8> = {
      "07": f.int8,
      a: f.int8,
    }
    expect(defineMessage("ok", zeroPadded).fieldNames).toEqual(["07", "a"])
  })
})

describe("defineContract", () => {
  test("returns the contract unchanged (and frozen)", () => {
    const Ping = defineMessage("ping", { t: f.float64 })
    const Pong = defineMessage("pong", { t: f.float64 })
    const c = defineContract({ client: { ping: Ping }, server: { pong: Pong } })

    expect(c.client.ping).toBe(Ping)
    expect(c.server.pong).toBe(Pong)
    expect(Object.isFrozen(c)).toBe(true)
  })
})
