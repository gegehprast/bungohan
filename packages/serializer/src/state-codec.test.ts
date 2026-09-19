import { describe, expect, test } from "bun:test"
import {
  applyDelta,
  clearChangeTrees,
  createFixedPoint,
  createNumber,
  createSchemaMap,
  createString,
  encodeSnapshot,
  generateDeltas,
  getSchemaTable,
  Schema,
} from "@bungohan/state"
import { f, type WireOp } from "@bungohan/types"
import { encode } from "@msgpack/msgpack"
import { isWireOp, MessagePackStateCodec } from "./state-codec"

class Unit extends Schema {
  public static override schemaName = "SC.Unit"
  public x = createFixedPoint(2)
  public name = createString()
}

class Late extends Schema {
  public static override schemaName = "SC.Late"
  public v = createNumber()
}

class Arena extends Schema {
  public static override schemaName = "SC.Arena"
  public tick = createNumber()
  public units = createSchemaMap(f.uint16, Unit)
  public extras = createSchemaMap(f.string, Late)
}

const codec = new MessagePackStateCodec()

/** Server → codec → bytes → codec → client, the way core will wire it. */
function send(
  server: ReturnType<MessagePackStateCodec["createSession"]>,
  client: ReturnType<MessagePackStateCodec["createSession"]>,
  replica: Schema,
  ops: WireOp[],
): number {
  const bytes = server.encodeOps(ops).unwrap()
  const decoded = client.decodeOps(bytes).unwrap()
  expect(decoded).toEqual(ops)
  const applied = applyDelta(replica, decoded)
  if (applied.isErr()) throw applied.error
  return bytes.byteLength
}

describe("MessagePackStateCodec (Phase 1)", () => {
  test("output is byte-identical to MessagePack of the op array", () => {
    const ops: WireOp[] = [
      [4, 0, "A", ["x"], ["fixed:2"]],
      [0, 57, 0, 14550],
      [1, 3, "k", [1, 9]],
      [1, 4, true],
      [2, 3, 7],
      [3, 3],
    ]
    const session = codec.createSession()
    expect(session.encodeOps(ops).unwrap()).toEqual(encode(ops))
    // …so the §11.1 baselines hold for it: one position update is 8 bytes.
    expect(session.encodeOps([[0, 57, 0, 14550]]).unwrap().byteLength).toBe(8)
    expect(codec.getName()).toBe("messagepack")
  })

  test("syncs a room end to end and tracks the table from the stream", () => {
    const server = new Arena()
    const u = new Unit()
    u.x.set(1.25)
    u.name.set("a")
    server.units.set(1, u)

    const serverSession = codec.createSession()
    const clientSession = codec.createSession()
    const client = new Arena()
    send(serverSession, clientSession, client, encodeSnapshot(server).unwrap())
    expect(clientSession.getTable()).toEqual(getSchemaTable(server))

    // A class first used mid-session arrives as an inline DEFINE.
    const late = new Late()
    late.v.set(3)
    server.extras.set("e", late)
    u.x.set(2.5)
    send(serverSession, clientSession, client, generateDeltas(server))
    clearChangeTrees(server)
    expect(clientSession.getTable()).toEqual(getSchemaTable(server))
    expect(serverSession.getTable()).toEqual(getSchemaTable(server))
    expect(clientSession.getTable().classes.map((c) => c.name)).toEqual([
      "SC.Arena",
      "SC.Unit",
      "SC.Late",
    ])
    expect(client.extras.get("e")?.v.get()).toBe(3)
    expect(client.units.get(1)?.x.get()).toBe(2.5)

    // A late joiner's snapshot restates the whole table: that's fine for
    // the server session, which has already seen every class.
    const lateSession = codec.createSession()
    const lateClient = new Arena()
    send(
      serverSession,
      lateSession,
      lateClient,
      encodeSnapshot(server).unwrap(),
    )
    expect(lateSession.getTable()).toEqual(getSchemaTable(server))
    expect(lateClient.units.get(1)?.name.get()).toBe("a")
  })

  test("a DEFINE that contradicts the table, or skips an id, is an error", () => {
    const session = codec.createSession()
    const first: WireOp = [4, 0, "A", ["x"], ["float64"]]
    expect(session.encodeOps([first]).isOk()).toBe(true)
    expect(session.encodeOps([first]).isOk()).toBe(true) // restated: fine
    const contradicts = session.encodeOps([[4, 0, "A", ["x"], ["string"]]])
    expect(contradicts.isErr() && contradicts.error.code).toBe("ENCODE_FAILED")
    const skips = session.encodeOps([[4, 2, "C", [], []]])
    expect(skips.isErr() && skips.error.message).toContain("skips ahead")

    const receiver = codec.createSession()
    const bytes = encode([[4, 1, "B", [], []]])
    const decoded = receiver.decodeOps(bytes)
    expect(decoded.isErr() && decoded.error.code).toBe("DECODE_FAILED")
  })

  test("malformed frames are rejected before they reach applyDelta", () => {
    const session = codec.createSession()
    const frames: unknown[] = [
      { not: "an array" },
      [[9, 0]], // unknown op code
      [[0, 1, 2]], // SET missing its value
      [[0, 1, "f", 1]], // field index must be an int
      [[1, 1, "k", [1, 2, 3]]], // ref must be a pair
      [[2, 1]], // REMOVE without a key
      [[3, 1, 2]], // CLEAR with extras
      [[4, 0, "A", ["x", "y"], ["float64"]]], // fields/types mismatch
      [[4, 0, "A", ["x"], ["map"]]], // unparseable type
      [["x"]],
    ]
    for (const frame of frames) {
      const result = session.decodeOps(encode(frame))
      expect({ frame, code: result.isErr() && result.error.code }).toEqual({
        frame,
        code: "DECODE_FAILED",
      })
    }
    const garbage = session.decodeOps(Uint8Array.of(0xc1))
    expect(garbage.isErr() && garbage.error.code).toBe("DECODE_FAILED")
  })

  test("isWireOp accepts every op form", () => {
    const good: unknown[] = [
      [0, 1, 2, 3.5],
      [0, 1, 2, [0, 5]],
      [1, 1, "k", "v"],
      [1, 1, 7, false],
      [1, 1, [2, 3]],
      [2, 1, "k"],
      [2, 1, 5],
      [3, 1],
      [4, 0, "A", ["x"], ["schemaMap<uint16,B>"]],
    ]
    for (const op of good)
      expect({ op, ok: isWireOp(op) }).toEqual({ op, ok: true })
  })
})
