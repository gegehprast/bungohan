import { describe, expect, test } from "bun:test"
import { INT_RANGE, isIntOf, toInt } from "./ints"
import { isCollectionField, parseFieldType } from "./wire"

describe("parseFieldType", () => {
  test("primitives", () => {
    const types = ["float64", "float32", "string", "bool", "fixed:0"] as const
    for (const type of types) {
      expect(parseFieldType(type)).toEqual({ kind: "primitive", type })
    }
    expect(parseFieldType("fixed:9")).toEqual({
      kind: "primitive",
      type: "fixed:9",
    })
  })

  test("collections and nested schemas carry their element types", () => {
    expect(parseFieldType("schema<Vec>")).toEqual({
      kind: "schema",
      schema: "Vec",
    })
    expect(parseFieldType("map<uint16,fixed:2>")).toEqual({
      kind: "map",
      key: "uint16",
      element: "fixed:2",
    })
    expect(parseFieldType("set<int32>")).toEqual({
      kind: "set",
      element: "int32",
    })
    expect(parseFieldType("array<float32>")).toEqual({
      kind: "array",
      element: "float32",
    })
    expect(parseFieldType("schemaMap<string,Game.Player>")).toEqual({
      kind: "schemaMap",
      key: "string",
      schema: "Game.Player",
    })
    expect(parseFieldType("schemaSet<Item>")).toEqual({
      kind: "schemaSet",
      schema: "Item",
    })
    expect(parseFieldType("schemaArray<Item>")).toEqual({
      kind: "schemaArray",
      schema: "Item",
    })
  })

  test("a schema name runs to the final '>', whatever it contains", () => {
    expect(parseFieldType("schemaMap<float64,A<b>,c>")).toEqual({
      kind: "schemaMap",
      key: "float64",
      schema: "A<b>,c",
    })
  })

  test("integer kinds are field types (createInt), never collection values", () => {
    const kinds = [
      "int8",
      "int16",
      "int32",
      "uint8",
      "uint16",
      "uint32",
    ] as const
    for (const type of kinds) {
      expect(parseFieldType(type)).toEqual({ kind: "int", type })
    }
    // Still rejected below: "map<string,uint8>", "array<int32>".
  })

  test("rejects anything else", () => {
    for (const type of [
      "",
      "map",
      "schema",
      "fixed:10",
      "fixed:-1",
      "map<string>",
      "map<bool,string>",
      "map<string,uint8>",
      "set<float32>",
      "set<fixed:2>",
      "array<int32>",
      "schemaMap<string,>",
      "schemaMap<,Item>",
      "schema<>",
      "list<string>",
      "array<string",
    ]) {
      expect({ type, parsed: parseFieldType(type) }).toEqual({
        type,
        parsed: undefined,
      })
    }
  })

  test("isCollectionField", () => {
    const kinds = ["float64", "schema<X>", "map<string,bool>", "set<string>"]
    expect(
      kinds.map((type) => {
        const parsed = parseFieldType(type)
        return parsed !== undefined && isCollectionField(parsed)
      }),
    ).toEqual([false, false, true, true])
  })
})

describe("integer kinds", () => {
  test("isIntOf checks integrality and range", () => {
    expect(isIntOf(255, "uint8")).toBe(true)
    expect(isIntOf(256, "uint8")).toBe(false)
    expect(isIntOf(-1, "uint32")).toBe(false)
    expect(isIntOf(-128, "int8")).toBe(true)
    expect(isIntOf(1.5, "int32")).toBe(false)
    expect(isIntOf("1", "int32")).toBe(false)
    expect(isIntOf(4294967295, "uint32")).toBe(true)
  })

  test("toInt truncates, saturates, maps NaN to 0 and never returns -0", () => {
    expect(toInt(1.9, "int8")).toBe(1)
    expect(toInt(-1.9, "int8")).toBe(-1)
    expect(toInt(1000, "int8")).toBe(127)
    expect(toInt(-1000, "uint8")).toBe(0)
    expect(toInt(Number.POSITIVE_INFINITY, "int32")).toBe(INT_RANGE.int32[1])
    expect(toInt(Number.NaN, "uint16")).toBe(0)
    expect(Object.is(toInt(-0.5, "int16"), 0)).toBe(true)
  })
})
