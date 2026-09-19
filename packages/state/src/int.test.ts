import { describe, expect, test } from "bun:test"
import { f, parseFieldType } from "@bungohan/types"
import { applyDelta } from "./decoder"
import { clearChangeTrees, encodeSnapshot, generateDeltas } from "./encoder"
import { createInt } from "./factories"
import { Schema } from "./schema"
import { validateSchemaClass } from "./validate"

class Counters extends Schema {
  public static override schemaName = "Int.Counters"
  public score = createInt(f.int32)
  public level = createInt(f.uint8, 1)
  public delta = createInt(f.int8)
}

function peer(): { server: Counters; client: Counters } {
  const server = new Counters()
  const client = new Counters()
  applyDelta(client, encodeSnapshot(server).unwrap()).unwrap()
  return { server, client }
}

function sync(server: Counters, client: Counters) {
  const ops = generateDeltas(server)
  applyDelta(client, ops).unwrap()
  clearChangeTrees(server)
  return ops
}

describe("createInt", () => {
  test("declares the integer kind in the class table", () => {
    const ops = encodeSnapshot(new Counters()).unwrap()
    const define = ops.find((op) => op[0] === 4)
    expect(define?.[4]).toEqual(["int32", "uint8", "int8"])
    expect(parseFieldType("uint16")).toEqual({ kind: "int", type: "uint16" })
    expect(validateSchemaClass(Counters)).toEqual([])
  })

  test("syncs integers exactly; the snapshot omits zeros", () => {
    const server = new Counters()
    server.score.set(-70_000)
    const snapshot = encodeSnapshot(server).unwrap()
    const client = new Counters()
    applyDelta(client, snapshot).unwrap()
    expect(client.score.get()).toBe(-70_000)
    expect(client.level.get()).toBe(1)
    // Receivers start from zero, whatever the local initializer says.
    expect(client.delta.get()).toBe(0)
  })

  test("the wire truncates toward zero and saturates; the server keeps what was set", () => {
    const { server, client } = peer()
    server.delta.set(-3.9)
    server.level.set(300)
    sync(server, client)
    expect(server.delta.get()).toBe(-3.9)
    expect(client.delta.get()).toBe(-3)
    expect(client.level.get()).toBe(255)
  })

  test("a write that doesn't change the wire value sends nothing", () => {
    const { server, client } = peer()
    server.score.set(5)
    sync(server, client)
    server.score.set(5.4)
    expect(sync(server, client)).toEqual([])
  })

  test("a receiver rejects a value outside the kind", () => {
    const { client } = peer()
    const applied = applyDelta(client, [[0, 0, 1, 256]])
    expect(applied.isErr() && applied.error.code).toBe("MALFORMED_OP")
    const fraction = applyDelta(client, [[0, 0, 0, 1.5]])
    expect(fraction.isErr() && fraction.error.code).toBe("MALFORMED_OP")
  })

  test("a descriptor that isn't an integer kind is a declaration error", () => {
    class Bad extends Schema {
      public static override schemaName = "Int.Bad"
      // Only reachable by getting past the types.
      public n = createInt(f.float64 as unknown as typeof f.int32)
    }
    expect(validateSchemaClass(Bad)).toEqual([
      "Bad.n: createInt() needs an integer kind (f.int8 … f.uint32), got float64",
    ])
  })
})
