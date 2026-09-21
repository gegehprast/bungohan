import { describe, expect, test } from "bun:test"
import { defineContract, defineMessage, f } from "./contract"
import {
  contractHash,
  contractLayout,
  fnv1a32,
  hasTypedOptions,
  messageLayout,
  NO_OPTIONS,
  optionsDef,
  validateContract,
} from "./layout"

const Vec = defineMessage("vec", { x: f.float32, y: f.float32 })
const Move = defineMessage("move", { x: f.fixed(2), y: f.fixed(2) })
const Chat = defineMessage("chat", {
  text: f.string,
  team: f.enum("red", "blue"),
  level: f.enum(1, 2),
  tags: f.array(f.uint8),
  scores: f.map(f.int32),
  at: f.optional(f.nested(Vec)),
})

describe("layout", () => {
  test("canonical message layout", () => {
    expect(messageLayout(Move)).toBe("move(x:fixed:2,y:fixed:2)")
    expect(messageLayout(Chat)).toBe(
      'chat(text:string,team:enum["red"|"blue"],level:enum[1|2],' +
        "tags:array<uint8>,scores:map<int32>," +
        "at:optional<nested<vec(x:float32,y:float32)>>)",
    )
    expect(messageLayout(defineMessage("empty", {}))).toBe("empty()")
  })

  test("contract layout sorts messages; hash ignores key order", () => {
    const a = defineContract({ client: { move: Move, chat: Chat }, server: {} })
    const b = defineContract({ client: { chat: Chat, move: Move }, server: {} })
    expect(contractLayout(a)).toBe(
      `client{${messageLayout(Chat)};${messageLayout(Move)}}server{}`,
    )
    expect(contractHash(a)).toBe(contractHash(b))
    expect(contractHash(a)).toMatch(/^[0-9a-f]{8}$/)
  })

  test("any change to a message changes the hash", () => {
    const base = defineContract({ client: { move: Move }, server: {} })
    const moved = defineMessage("move", { x: f.fixed(3), y: f.fixed(2) })
    const changed = defineContract({ client: { move: moved }, server: {} })
    const flipped = defineContract({ client: {}, server: { move: Move } })
    expect(contractHash(changed)).not.toBe(contractHash(base))
    expect(contractHash(flipped)).not.toBe(contractHash(base))
  })

  test("FNV-1a 32 reference values", () => {
    expect(fnv1a32("")).toBe("811c9dc5")
    expect(fnv1a32("a")).toBe("e40c292c")
    expect(fnv1a32("foobar")).toBe("bf9cf968")
    expect(fnv1a32("é")).toBe(fnv1a32("é")) // UTF-8 bytes, not code units
  })
})

describe("validateContract", () => {
  test("accepts well-formed contracts", () => {
    const contract = defineContract({
      client: { move: Move, chat: Chat },
      server: { vec: Vec },
    })
    expect(validateContract(contract)).toEqual([])
  })

  test("reports what got past the types", () => {
    const bad = {
      client: {
        wrongKey: Move,
        junk: { kind: "message", name: "junk", fields: {}, fieldNames: ["x"] },
        fields: {
          kind: "message",
          name: "fields",
          fields: {
            a: { kind: "fixed", decimals: 12 },
            b: { kind: "enum", values: [] },
            c: { kind: "enum", values: ["x", "x"] },
            d: { kind: "optional", of: { kind: "optional", of: f.bool } },
            e: { kind: "wat" },
            "not-an-id": f.bool,
            g: { kind: "nested", message: {} },
          },
          fieldNames: ["a", "b", "c", "d", "e", "not-an-id", "g"],
        },
      },
      server: undefined,
    }
    const problems = validateContract(bad)
    expect(problems).toEqual([
      "client.wrongKey: key must equal the message name",
      "client.junk: fieldNames don't match fields",
      "client.fields.a: fixed decimals must be an integer 0..9",
      "client.fields.b: enum needs at least one value",
      "client.fields.c: enum values must be distinct",
      "client.fields.d: optional inside optional",
      'client.fields.e: unknown field kind "wat"',
      "client.fields.not-an-id: field names must be identifiers",
      "client.fields.g: not a message (use defineMessage)",
      "contract.server: missing message map",
    ])
  })

  test("arrays and maps can't hold messages that encode to zero bytes", () => {
    const Empty = defineMessage("empty", {})
    const OnlyEmpty = defineMessage("onlyEmpty", { e: f.nested(Empty) })
    const Flagged = defineMessage("flagged", { b: f.bool })
    const contract = defineContract({
      client: {
        lists: defineMessage("lists", {
          a: f.array(f.nested(Empty)),
          m: f.map(f.nested(OnlyEmpty)),
          ok: f.array(f.nested(Flagged)),
          one: f.nested(Empty),
        }),
      },
      server: {},
    })
    expect(validateContract(contract)).toEqual([
      "client.lists.a: array elements can't be messages with no data",
      "client.lists.m: map elements can't be messages with no data",
    ])
  })
})

describe("typed options (spec §4.1.2)", () => {
  const Seat = defineMessage("seat", { name: f.string })
  const Setup = defineMessage("setup", { rounds: f.uint8 })

  test("the layout gains an options part only when options are declared", () => {
    const plain = defineContract({ client: {}, server: {} })
    expect(contractLayout(plain)).toBe("client{}server{}")
    expect(contractLayout({ ...plain, options: {} })).toBe("client{}server{}")
    expect(
      contractLayout({ ...plain, options: { join: Seat, create: Setup } }),
    ).toBe(
      "client{}server{}options{create:setup(rounds:uint8);join:seat(name:string)}",
    )
    expect(contractLayout({ ...plain, options: { join: Seat } })).toBe(
      "client{}server{}options{join:seat(name:string)}",
    )
  })

  test("a kind left out is the empty message; none declared is untyped", () => {
    const plain = defineContract({ client: {}, server: {} })
    expect(optionsDef(plain, "join")).toBeUndefined()
    const joinOnly = { ...plain, options: { join: Seat } }
    expect(optionsDef(joinOnly, "join")).toBe(Seat)
    expect(optionsDef(joinOnly, "create")).toBe(NO_OPTIONS)
    expect(hasTypedOptions(joinOnly)).toBe(true)
  })

  test("validateContract checks the declarations and their kinds", () => {
    expect(
      validateContract({ client: {}, server: {}, options: { join: Seat } }),
    ).toEqual([])
    expect(
      validateContract({
        client: {},
        server: {},
        options: { joins: Seat, create: { kind: "message" } },
      }),
    ).toEqual([
      'options.joins: unknown options kind (use "create" or "join")',
      "options.create: message name must be a non-empty string",
      "options.create: malformed message (use defineMessage)",
    ])
    expect(validateContract({ client: {}, server: {}, options: 3 })).toEqual([
      "contract.options: not an object",
    ])
  })
})
