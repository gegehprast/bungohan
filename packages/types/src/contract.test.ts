import { describe, expect, test } from "bun:test"
import { defineContract, defineMessage, f } from "./contract"

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
