/**
 * Runs the protocol conformance vectors (`conformance/v1/`, spec §11.3,
 * PROTOCOL.md §14) against this implementation, in both directions:
 * encode → exact bytes, and bytes → decoded values, for both codecs.
 * Behavior vectors run against a real server (server side), and against
 * both the byte-level TestClient and client-js (client side).
 */
import { describe, expect, test } from "bun:test"
import { BungohanClient, joinBody } from "@bungohan/client-js"
import {
  type Client,
  Room,
  type RoomConstructor,
  type RoomOnCreateOptions,
} from "@bungohan/core"
import {
  decodeFrame,
  encodeFrame,
  type IStateCodec,
  MessagePackSerializer,
  MessagePackStateCodec,
  readVarint,
  SchemaCodec,
  unzigzag,
  varintSize,
  writeVarint,
  zigzag,
} from "@bungohan/serializer"
import type { Schema } from "@bungohan/state"
import {
  CLIENT_FRAME_HEADERS,
  ClientFrameType,
  CloseCode,
  type Contract,
  type ContractOptions,
  type IntKind,
  isIntKind,
  type MessageDef,
  SERVER_FRAME_HEADERS,
  ServerFrameType,
  toFixed,
  toInt,
  type WireOp,
} from "@bungohan/types"
import { createServerHarness, createTestHarness } from "../harness"
import { runReplica } from "./replica"
import {
  difference,
  fromHex,
  hexOf,
  loadVectors,
  messageOf,
  normalize,
  toHex,
} from "./vectors"

const codecs: Readonly<Record<string, IStateCodec>> = {
  schema: new SchemaCodec(),
  messagepack: new MessagePackStateCodec(),
}
const mp = new MessagePackSerializer()

type Case = Readonly<Record<string, unknown>>

function num(value: unknown): number {
  if (typeof value !== "number") throw new Error("expected a number")
  return value
}

function str(value: unknown): string {
  if (typeof value !== "string") throw new Error("expected a string")
  return value
}

function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("expected an array")
  return value
}

function codecOf(name: string): IStateCodec {
  const codec = codecs[name]
  if (codec === undefined) throw new Error(`no codec "${name}"`)
  return codec
}

function same(actual: unknown, expected: unknown): void {
  const diff = difference(normalize(actual), expected)
  if (diff !== undefined) throw new Error(`mismatch at ${diff}`)
}

// ---------------------------------------------------------------------------
// Case runners
// ---------------------------------------------------------------------------

function varint(c: Case, signed: boolean): void {
  const bytes = fromHex(str(c["hex"]))
  const read = readVarint(bytes, 0)
  if (c["error"] === true) {
    expect(read === undefined || read[1] !== bytes.length).toBe(true)
    return
  }
  expect(read).toBeDefined()
  if (read === undefined) return
  expect(read[1]).toBe(bytes.length)
  const value = num(c["value"])
  expect(signed ? unzigzag(read[0]) : read[0]).toBe(value)
  if (c["encode"] === false) return
  const wire = signed ? zigzag(value) : value
  const out = new Uint8Array(varintSize(wire))
  writeVarint(out, 0, wire)
  expect(toHex(out)).toBe(hexOf(str(c["hex"])))
}

function frame(c: Case): void {
  const headers =
    c["direction"] === "client" ? CLIENT_FRAME_HEADERS : SERVER_FRAME_HEADERS
  const bytes = fromHex(str(c["hex"]))
  const parsed = decodeFrame(bytes, headers)
  if (c["error"] === true) {
    expect(parsed.isErr()).toBe(true)
    return
  }
  const body = fromHex(str(c["bodyHex"]))
  if ("body" in c)
    expect(toHex(mp.encode(c["body"]).unwrap())).toBe(toHex(body))
  const built = encodeFrame(num(c["type"]), list(c["header"]).map(num), body)
  expect(toHex(built.unwrap())).toBe(toHex(bytes))
  const { type, header, body: parsedBody } = parsed.unwrap()
  expect(type).toBe(num(c["type"]))
  expect([...header]).toEqual(list(c["header"]).map(num))
  expect(toHex(parsedBody)).toBe(toHex(body))
}

function messagepack(c: Case): void {
  const bytes = fromHex(str(c["hex"]))
  expect(toHex(mp.encode(c["value"]).unwrap())).toBe(toHex(bytes))
  same(mp.decode(bytes).unwrap(), "decoded" in c ? c["decoded"] : c["value"])
}

function message(c: Case): void {
  const def = messageOf(c["message"])
  const hexes = c["hex"]
  if (typeof hexes !== "object" || hexes === null) throw new Error("no hex")
  for (const [name, hex] of Object.entries(hexes)) {
    const codec = codecOf(name)
    const bytes = fromHex(str(hex))
    const decoded = codec.decodeMessage(def, bytes)
    if (c["error"] === true) {
      expect({ codec: name, failed: decoded.isErr() }).toEqual({
        codec: name,
        failed: true,
      })
      continue
    }
    const encoded = codec.encodeMessage(def, c["payload"]).unwrap()
    expect({ codec: name, hex: toHex(encoded) }).toEqual({
      codec: name,
      hex: toHex(bytes),
    })
    same(decoded.unwrap(), "decoded" in c ? c["decoded"] : c["payload"])
  }
}

function state(c: Case): void {
  const codec = codecOf(str(c["codec"]))
  const encoder = codec.createSession()
  const clients = "clients" in c ? list(c["clients"]).map(str) : ["a"]
  const decoders = new Map(clients.map((name) => [name, codec.createSession()]))
  for (const [i, raw] of list(c["frames"]).entries()) {
    if (typeof raw !== "object" || raw === null) throw new Error("bad frame")
    const frame = raw as Case
    const to = "to" in frame ? list(frame["to"]).map(str) : clients
    const ops = "ops" in frame ? (list(frame["ops"]) as WireOp[]) : undefined
    if (frame["error"] === true) {
      if (ops !== undefined) {
        expect({
          frame: i,
          encodeFails: encoder.encodeOps(ops).isErr(),
        }).toEqual({ frame: i, encodeFails: true })
      }
      if ("hex" in frame) {
        for (const name of to) {
          const decoded = decoders
            .get(name)
            ?.decodeOps(fromHex(str(frame["hex"])))
          expect({
            frame: i,
            client: name,
            decodeFails: decoded?.isErr(),
          }).toEqual({ frame: i, client: name, decodeFails: true })
        }
      }
      return
    }
    if (ops === undefined) throw new Error(`frame ${i}: no ops`)
    const hex = hexOf(str(frame["hex"]))
    if (frame["encode"] !== false) {
      const encoded = encoder.encodeOps(ops)
      if (encoded.isErr())
        throw new Error(`frame ${i}: ${encoded.error.message}`)
      expect({ frame: i, hex: toHex(encoded.value) }).toEqual({ frame: i, hex })
    }
    for (const name of to) {
      const decoded = decoders.get(name)?.decodeOps(fromHex(hex))
      if (decoded === undefined) throw new Error(`no client ${name}`)
      if (decoded.isErr()) {
        throw new Error(`frame ${i}, ${name}: ${decoded.error.message}`)
      }
      const diff = difference(
        decoded.value,
        "decoded" in frame ? frame["decoded"] : ops,
      )
      expect({ frame: i, client: name, diff }).toEqual({
        frame: i,
        client: name,
        diff: undefined,
      })
    }
  }
}

function numeric(c: Case): void {
  const value = num(c["value"])
  const wire = num(c["wire"])
  switch (c["kind"]) {
    case "fixed": {
      const decimals = num(c["decimals"])
      if (!Number.isInteger(decimals) || decimals < 0 || decimals > 9) {
        throw new Error("bad decimals")
      }
      expect(Object.is(toFixed(value, decimals as 0), wire)).toBe(true)
      return
    }
    case "int": {
      const type = str(c["type"])
      if (!isIntKind(type)) throw new Error(`bad int type ${type}`)
      const kind: IntKind = type
      expect(Object.is(toInt(value, kind), wire)).toBe(true)
      return
    }
    default:
      expect(Object.is(Math.fround(value), wire)).toBe(true)
  }
}

// ---------------------------------------------------------------------------
// Behavior (PROTOCOL.md §8.2, §9)
// ---------------------------------------------------------------------------

class CompatRoom extends Room {
  protected override async onCreate(): Promise<void> {
    this.onMessageRaw("t", () => {})
  }
}

async function serverBehavior(c: Case): Promise<void> {
  const h = await createServerHarness({
    define: (s) => s.defineRoomType("compat", CompatRoom),
  })
  const client = h.connect()
  const joined = (await client.joinOrCreate("compat")).unwrap()
  expect(joined.roomRef).toBe(1)
  for (const hex of list(c["frames"])) client.sendBytes(fromHex(str(hex)))
  await h.flush()
  if (c["expect"] === "violation") {
    expect(client.errors[0]?.[0]).toBe("INVALID_MESSAGE")
    expect(client.closeCode).toBe(CloseCode.POLICY_VIOLATION)
  } else {
    expect(client.errors).toEqual([])
    expect(client.closeCode).toBeUndefined()
  }
  await h.stop()
}

/** Client side, against the byte-level reference driver. */
async function driverBehavior(c: Case): Promise<void> {
  const h = await createServerHarness({
    define: (s) => s.defineRoomType("compat", CompatRoom),
  })
  const client = h.connect({ log: () => {} })
  const room = (await client.joinOrCreate("compat")).unwrap()
  expect(room.roomRef).toBe(1)
  for (const hex of list(c["frames"])) {
    h.transport.send(client.socket.clientId, fromHex(str(hex))).unwrap()
  }
  await h.flush() // rejects if the driver threw on a frame
  expect(client.dropped.length).toBe(c["expect"] === "drop" ? 1 : 0)
  expect(client.connected).toBe(true)
  await h.stop()
}

/** Client side, against client-js. */
async function clientJsBehavior(c: Case): Promise<void> {
  const warnings: unknown[][] = []
  const errors: unknown[][] = []
  const h = await createTestHarness({
    rooms: { compat: CompatRoom },
    client: {
      logger: {
        warn: (...args: unknown[]) => warnings.push(args),
        error: (...args: unknown[]) => errors.push(args),
      },
    },
  })
  const client = await h.connect()
  const room = (await client.joinOrCreate("compat")).unwrap()
  room.onMessageRaw(() => {})
  room.onError(() => {})
  await h.flush()
  warnings.length = 0
  const socket = h.socketOf(client)
  for (const hex of list(c["frames"])) {
    h.transport.send(socket.clientId, fromHex(str(hex))).unwrap()
  }
  await h.flush()
  expect(errors).toEqual([])
  if (c["expect"] === "drop") expect(warnings.length).toBe(1)
  else expect(warnings).toEqual([])
  expect(client.connectionState).toBe("connected")
  expect(room.status).toBe("joined")
  expect(client).toBeInstanceOf(BungohanClient)
  await h.stop()
}

// ---------------------------------------------------------------------------
// Join options (PROTOCOL.md §6.2.1)
// ---------------------------------------------------------------------------

function record(value: unknown): Case {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("expected an object")
  }
  return value as Case
}

/** A contract declaring only the case's options. */
function optionsContract(c: Case): Contract {
  const declares = record(c["declares"])
  const options: { create?: MessageDef; join?: MessageDef } = {}
  if ("create" in declares) options.create = messageOf(declares["create"])
  if ("join" in declares) options.join = messageOf(declares["join"])
  const typed: ContractOptions = options
  return { client: {}, server: {}, options: typed }
}

/**
 * The room type `options` of PROTOCOL.md §14: declares the case's options,
 * and echoes what its hooks received as a raw `"options"` message.
 */
function optionsRoom(
  contract: Contract,
): RoomConstructor<Room<Schema, Contract>> & { contract: Contract } {
  const createFields = contract.options?.create?.fieldNames ?? []
  return class OptionsRoom extends Room<Schema, Contract> {
    public static override contract = contract
    private _created: Record<string, unknown> = {}

    protected override async onCreate(
      options: RoomOnCreateOptions & Record<string, unknown>,
    ): Promise<void> {
      for (const field of createFields) {
        if (field in options) this._created[field] = options[field]
      }
    }

    protected override async onJoin(
      client: Client,
      options: Record<string, unknown>,
    ): Promise<void> {
      this.sendRaw(client, "options", { join: options, create: this._created })
    }
  }
}

async function joinCase(c: Case): Promise<void> {
  const contract = optionsContract(c)
  const bytes = fromHex(str(c["hex"]))
  if ("request" in c) {
    const r = record(c["request"])
    const options =
      contract.options?.create !== undefined &&
      (r["mode"] === 0 || r["mode"] === 1)
        ? { create: r["create"], join: r["join"] }
        : r["join"]
    const hash = r["contractHash"] === null ? null : str(r["contractHash"])
    const body = joinBody(num(r["mode"]), str(r["target"]), options, hash, {
      ...contract,
    }).unwrap()
    const frame = encodeFrame(
      ClientFrameType.JOIN,
      [num(r["requestId"])],
      mp.encode(body).unwrap(),
    ).unwrap()
    expect(toHex(frame)).toBe(toHex(bytes))
  }

  const Options = optionsRoom(contract)
  const h = await createServerHarness({
    define: (s) =>
      s.defineRoomType("options", Options, { visibility: "private" }),
  })
  const client = h.connect({ log: () => {} })
  client.sendBytes(bytes)
  await h.flush()
  const requestId =
    decodeFrame(bytes, CLIENT_FRAME_HEADERS).unwrap().header[0] ?? 0
  const reply = client.unmatched.find(([, id]) => id === requestId)
  const expected = str(c["reply"])
  if (expected !== "JOIN_SUCCESS") {
    expect(reply).toEqual([ServerFrameType.JOIN_ERROR, requestId, expected])
    expect(client.connected).toBe(true)
    await h.stop()
    return
  }
  expect(reply?.[0]).toBe(ServerFrameType.JOIN_SUCCESS)
  const roomRef = reply?.[2]
  const echoes = client.frames
    .map((data) => decodeFrame(data, SERVER_FRAME_HEADERS).unwrap())
    .filter(
      (frame) =>
        frame.type === ServerFrameType.ROOM_MESSAGE_RAW &&
        frame.header[0] === roomRef,
    )
    .map((frame) => list(mp.decode(frame.body).unwrap()))
  expect(echoes.length).toBe(1)
  expect(echoes[0]?.[0]).toBe("options")
  const request = "request" in c ? record(c["request"]) : {}
  const received =
    "received" in c
      ? c["received"]
      : { join: request["join"], create: request["create"] }
  same(echoes[0]?.[1], received)
  await h.stop()
}

// ---------------------------------------------------------------------------

const files = await loadVectors()

test("the vector corpus is present", () => {
  expect(files.length).toBeGreaterThan(0)
  expect(files.some((file) => !file.generated)).toBe(true)
})

for (const file of files) {
  describe(file.name, () => {
    for (const [i, c] of file.cases.entries()) {
      const label = `#${i} ${String(c["kind"])}${
        c["description"] === undefined ? "" : `: ${String(c["description"])}`
      }`
      switch (c["kind"]) {
        case "varint":
          test(label, () => varint(c, false))
          break
        case "zigzag":
          test(label, () => varint(c, true))
          break
        case "fixed":
        case "int":
        case "float32":
          test(label, () => numeric(c))
          break
        case "frame":
          test(label, () => frame(c))
          break
        case "messagepack":
          test(label, () => messagepack(c))
          break
        case "message":
          test(label, () => message(c))
          break
        case "state":
          test(label, () => state(c))
          break
        case "replica":
          test(label, () => expect(runReplica(c)).toEqual([]))
          break
        case "join":
          test(label, () => joinCase(c))
          break
        case "behavior":
          if (c["side"] === "server") {
            test(label, () => serverBehavior(c))
          } else {
            test(`${label} (TestClient)`, () => driverBehavior(c))
            test(`${label} (client-js)`, () => clientJsBehavior(c))
          }
          break
        default:
          test(label, () => {
            throw new Error(`unknown case kind ${String(c["kind"])}`)
          })
      }
    }
  })
}
