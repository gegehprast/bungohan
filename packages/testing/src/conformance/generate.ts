/**
 * Generates the `generated: true` conformance vectors (`conformance/v1/1xx-*`)
 * by running this implementation: the state layer produces real op streams
 * (snapshots, patches, refId reuse, filtering, late joiners), and both codecs
 * encode them. Deterministic, so regenerating is a no-op unless the wire
 * format changed:
 *
 *   bun run vectors
 *
 * The hand-written vectors (`0xx-*`) are what make the implementation
 * trustworthy; these extend coverage. Both are normative (PROTOCOL.md §14).
 */
import {
  encodeFrame,
  type IStateCodec,
  MessagePackSerializer,
  MessagePackStateCodec,
  SchemaCodec,
} from "@bungohan/serializer"
import {
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
} from "@bungohan/state"
import {
  ClientFrameType,
  defineMessage,
  f,
  type MessageDef,
  ServerFrameType,
  type WireOp,
} from "@bungohan/types"
import {
  declarationOf,
  difference,
  normalize,
  toHex,
  toJson,
  VECTOR_DIR,
} from "./vectors"

const codecs: Readonly<Record<string, IStateCodec>> = {
  schema: new SchemaCodec(),
  messagepack: new MessagePackStateCodec(),
}
const mp = new MessagePackSerializer()

type Case = Record<string, unknown>

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

// ===========================================================================
// Output
// ===========================================================================

/** One case per line, and one line per frame of a state case. */
function format(description: string, cases: Case[]): string {
  const lines = cases.map((c) => {
    const json = toJson(c)
    if (typeof json !== "object" || json === null || !("frames" in json)) {
      return `    ${JSON.stringify(json)}`
    }
    const { frames, ...rest } = json as Record<string, unknown>
    const head = JSON.stringify(rest).slice(0, -1)
    const body = (frames as unknown[])
      .map((frame) => `      ${JSON.stringify(frame)}`)
      .join(",\n")
    return `    ${head}, "frames": [\n${body}\n    ]}`
  })
  return `{\n  "description": ${JSON.stringify(description)},\n  "generated": true,\n  "cases": [\n${lines.join(",\n")}\n  ]\n}\n`
}

async function write(
  name: string,
  description: string,
  cases: Case[],
): Promise<void> {
  const text = format(description, cases)
  await Bun.write(new URL(name, VECTOR_DIR), text)
  console.log(`${name}: ${cases.length} cases, ${text.length} bytes`)
}

// ===========================================================================
// State streams
// ===========================================================================

interface Viewer {
  readonly id: string
}

interface StreamFrame {
  readonly to: readonly string[]
  readonly ops: WireOp[]
  readonly note?: string
}

/** Records what a server would send, grouped exactly as core groups it. */
class Recorder {
  public readonly frames: StreamFrame[] = []
  public readonly viewers: Viewer[] = []
  private readonly _root: Schema

  public constructor(root: Schema) {
    this._root = root
  }

  public join(id: string, note?: string): void {
    const viewer = { id }
    const ops = encodeSnapshot(this._root, viewer).unwrap()
    this.viewers.push(viewer)
    this.frames.push({ to: [id], ops, note: note ?? `snapshot for ${id}` })
  }

  public tick(note?: string): void {
    const deltas = generateDeltas(this._root, this.viewers)
    const groups = new Map<WireOp[], string[]>()
    for (const [viewer, ops] of deltas) {
      if (ops.length === 0) continue
      const group = groups.get(ops)
      if (group === undefined) groups.set(ops, [viewer.id])
      else group.push(viewer.id)
    }
    for (const [ops, to] of groups) this.frames.push({ to, ops, note })
    clearChangeTrees(this._root)
  }
}

/** One `state` case per codec, from one recorded stream. */
function stateCases(description: string, recorder: Recorder): Case[] {
  const clients = recorder.viewers.map((viewer) => viewer.id)
  return Object.entries(codecs).map(([name, codec]) => {
    const encoder = codec.createSession()
    const decoders = new Map(clients.map((id) => [id, codec.createSession()]))
    const frames = recorder.frames.map((frame) => {
      const bytes = encoder.encodeOps(frame.ops).unwrap()
      const out: Case = {}
      if (frame.note !== undefined) out["description"] = frame.note
      if (clients.length > 1) out["to"] = frame.to
      out["ops"] = frame.ops
      out["hex"] = toHex(bytes)
      for (const id of frame.to) {
        const decoded = decoders.get(id)?.decodeOps(bytes).unwrap()
        if (difference(decoded, frame.ops) !== undefined) {
          out["decoded"] = decoded
        }
      }
      return out
    })
    const c: Case = { kind: "state", description, codec: name }
    if (clients.length > 1) c["clients"] = clients
    c["frames"] = frames
    return c
  })
}

// --- classes ---------------------------------------------------------------

class GVec extends Schema {
  public static override schemaName = "G.Vec"
  public x = createFixedPoint(3)
  public y = createFixedPoint(3)
}

class GUnit extends Schema {
  public static override schemaName = "G.Unit"
  public name = createString()
  public pos = new GVec()
  public hp = createInt(f.uint16, 100)
  public tags = createSet(f.string)
}

class GBoss extends GUnit {
  public static override schemaName = "G.Boss"
  public rage = createFloat32()
}

/** Every field type, every key type, every collection element type. */
class GAll extends Schema {
  public static override schemaName = "G.All"
  public num = createNumber()
  public f32 = createFloat32()
  public fx0 = createFixedPoint(0)
  public fx9 = createFixedPoint(9)
  public str = createString()
  public flag = createBoolean()
  public i8 = createInt(f.int8)
  public i16 = createInt(f.int16)
  public i32 = createInt(f.int32)
  public u8 = createInt(f.uint8)
  public u16 = createInt(f.uint16)
  public u32 = createInt(f.uint32)
  public vec = new GVec()
  public byName = createMap(f.string, f.float64)
  public byI8 = createMap(f.int8, f.float32)
  public byU16 = createMap(f.uint16, f.fixed(2))
  public byF64 = createMap(f.float64, f.string)
  public byI32 = createMap(f.int32, f.bool)
  public strs = createSet(f.string)
  public f64s = createSet(f.float64)
  public i8s = createSet(f.int8)
  public i16s = createSet(f.int16)
  public i32s = createSet(f.int32)
  public u8s = createSet(f.uint8)
  public u16s = createSet(f.uint16)
  public u32s = createSet(f.uint32)
  public af64 = createArray(f.float64)
  public af32 = createArray(f.float32)
  public afx = createArray(f.fixed(1))
  public astr = createArray(f.string)
  public abool = createArray(f.bool)
  public units = createSchemaMap(f.string, GUnit)
  public unitsById = createSchemaMap(f.uint32, GUnit)
  public unitSet = createSchemaSet(GUnit)
  public unitList = createSchemaArray(GUnit)
}

function unit(name: string, x: number, y: number): GUnit {
  const u = new GUnit()
  u.name.set(name)
  u.pos.x.set(x)
  u.pos.y.set(y)
  return u
}

function everyType(): Case[] {
  const s = new GAll()
  s.num.set(-1234.5678)
  s.f32.set(0.1)
  s.fx0.set(-7.5)
  s.fx9.set(1.234567891)
  s.str.set("snowman ☃")
  s.flag.set(true)
  s.i8.set(-100)
  s.i16.set(-30000)
  s.i32.set(-2000000000)
  s.u8.set(200)
  s.u16.set(60000)
  s.u32.set(4000000000)
  s.vec.x.set(-1.25)
  s.byName.set("a", 1.5)
  s.byName.set("é", -0.1)
  s.byI8.set(-128, 3.5)
  s.byI8.set(127, 0.3)
  s.byU16.set(65535, 12.34)
  s.byF64.set(-0.5, "neg")
  s.byF64.set(1e100, "big")
  s.byI32.set(-2147483648, true)
  s.byI32.set(2147483647, false)
  s.strs.add("").add("x")
  s.f64s.add(Math.PI).add(-1e-300)
  s.i8s.add(-128).add(127)
  s.i16s.add(-32768).add(32767)
  s.i32s.add(-2147483648).add(2147483647)
  s.u8s.add(0).add(255)
  s.u16s.add(65535)
  s.u32s.add(4294967295)
  s.af64.push(0, -0.5, 1e-7)
  s.af32.push(1 / 3, -2.5)
  s.afx.push(1.25, -1.25, 0.05)
  s.astr.push("", "b", "日本")
  s.abool.push(true, false, true)
  s.units.set("u1", unit("one", 1, 2))
  const boss = new GBoss()
  boss.name.set("boss")
  boss.rage.set(9.75)
  boss.tags.add("final")
  s.units.set("b", boss)
  s.unitsById.set(7, unit("seven", -3, 4.5))
  s.unitSet.add(unit("setA", 0, 0))
  s.unitList.push(unit("l0", 0.001, -0.001), unit("l1", 100, 200))

  const r = new Recorder(s)
  r.join("a")
  s.num.set(0)
  s.i16.set(1)
  s.u32.set(0)
  s.vec.y.set(99.999)
  r.tick("primitive and nested-field changes; zero values are sent as SETs")
  s.byName.set("a", 2.5)
  s.byName.delete("é")
  s.byI8.delete(127)
  s.strs.delete("")
  s.u8s.add(1)
  s.af64.set(1, 42)
  s.af64.splice(0, 1)
  s.abool.clear()
  s.abool.push(false)
  r.tick(
    "map upsert and remove, set add and remove, array replace/remove, clear and refill",
  )
  const u1 = s.units.get("u1")
  if (u1 !== undefined) {
    u1.pos.x.set(-50.5)
    u1.hp.set(0)
    u1.tags.add("hurt")
  }
  s.unitList.splice(0, 1)
  s.unitList.push(unit("l2", 5, 5))
  s.unitsById.set(8, new GBoss())
  r.tick("changes inside schema elements; a new subclass instance")
  const moved = s.units.get("u1")
  if (moved !== undefined) {
    s.units.delete("u1")
    s.unitList.push(moved)
  }
  const first = [...s.unitSet.value][0]
  if (first !== undefined) s.unitSet.delete(first)
  s.unitsById.clear()
  r.tick(
    "a move (same refId), a schema-set removal by refId, a schema-map clear",
  )
  return stateCases(
    "every field type, key type and collection element type, as a snapshot and then patches",
    r,
  )
}

class GItem extends Schema {
  public static override schemaName = "G.Item"
  public x = createFixedPoint(2)
  public y = createFixedPoint(2)
  public bag = createArray(f.string)
}

class GWorld extends Schema {
  public static override schemaName = "G.World"
  public tick = createInt(f.uint32)
  public items = createSchemaMap(f.uint32, GItem)
}

function refIdReuse(): Case[] {
  const w = new GWorld()
  const r = new Recorder(w)
  r.join("a")
  const seen = new Set<number>()
  let reused = false
  let serial = 0
  for (let t = 0; t < 8; t++) {
    w.tick.set(t)
    for (let j = 0; j < 2; j++) {
      const item = new GItem()
      item.x.set(serial * 1.5)
      item.bag.push(`i${serial}`)
      w.items.set(serial++, item)
    }
    if (t >= 2) {
      w.items.delete(serial - 6)
      w.items.delete(serial - 5)
    }
    r.tick(`tick ${t}: two spawns${t >= 2 ? ", two despawns" : ""}`)
    const frame = r.frames.at(-1)
    for (const op of frame?.ops ?? []) {
      if (op[0] === 1 && op.length === 4 && Array.isArray(op[3])) {
        const ref = op[3][1]
        if (seen.has(ref)) reused = true
        seen.add(ref)
      }
    }
  }
  if (!reused) throw new Error("the refId reuse scenario reused nothing")
  return stateCases(
    "refId reuse (§11.4): despawned blocks (instance + its collection) come back, LIFO, for new instances of the same class, one tick later",
    r,
  )
}

class GPlayer extends Schema {
  public static override schemaName = "G.Player"
  public name = createString()
  public pos = new GVec()
  public vel = new GVec()
  public owner = createString()
  public secret = createFiltered(
    createString(),
    function (this: GPlayer, client) {
      return this.owner.get() === client.id
    },
  )
  public inventory = createFiltered(
    createArray(f.string),
    function (this: GPlayer, client) {
      return this.owner.get() === client.id
    },
  )
}

class GRoom extends Schema {
  public static override schemaName = "G.Room"
  public phase = createString("lobby")
  public players = createSchemaMap(f.string, GPlayer)
}

function player(owner: string, x: number): GPlayer {
  const p = new GPlayer()
  p.name.set(owner.toUpperCase())
  p.owner.set(owner)
  p.pos.x.set(x)
  p.secret.set(`${owner}-secret`)
  p.inventory.push("sword")
  return p
}

function filtered(): Case[] {
  const room = new GRoom()
  room.players.set("a", player("a", 1))
  const r = new Recorder(room)
  r.join("a")
  room.players.set("b", player("b", 2))
  r.tick("b's player spawns; a can't see its secret or inventory")
  r.join(
    "b",
    "snapshot for b, at the sync boundary: a's secret and inventory are left out",
  )
  room.players.get("a")?.pos.x.set(3)
  room.players.get("a")?.secret.set("a-changed")
  r.tick("a shared change plus a's secret: two frames, one per visibility")
  const b = room.players.get("b")
  if (b !== undefined) b.owner.set("a")
  r.tick(
    "b's player now belongs to a: a gets its secret and inventory (reveal), b gets the zero value and a CLEAR (hide)",
  )
  room.players.get("a")?.inventory.push("shield")
  room.phase.set("play")
  r.tick("an ADD inside a filtered collection reaches only a")
  return stateCases(
    "per-client filtered output (§11.8): one encoding session, each client decodes only its own frames",
    r,
  )
}

function lateJoiner(): Case[] {
  const room = new GRoom()
  const r = new Recorder(room)
  r.join("host", 'snapshot: the table so far, root content (phase "lobby")')
  const p = player("host", 10)
  p.vel.x.set(1.5)
  room.players.set("host", p)
  r.tick(
    "a player with nested schemas: every nested instance gets its ref and content",
  )
  p.pos.x.set(11.5)
  p.vel.y.set(-0.25)
  r.tick("SETs on nested instances target their own refIds")
  r.join(
    "late",
    "a late joiner's snapshot restates every DEFINE and the full tree",
  )
  p.pos.y.set(-4)
  r.tick("a patch to both")
  return stateCases(
    "nested schemas and a late joiner: each client decodes its own stream from its own snapshot",
    r,
  )
}

class GEdge extends Schema {
  public static override schemaName = "G.Edge"
  public d = createNumber(1)
  public e = createFloat32(1)
  public fx = createFixedPoint(2)
  public u8 = createInt(f.uint8)
  public i16 = createInt(f.int16)
}

function numericEdges(): Case[] {
  const s = new GEdge()
  const r = new Recorder(s)
  r.join("a")
  const steps: [string, () => void][] = [
    [
      "NaN",
      () => {
        s.d.set(Number.NaN)
        s.e.set(Number.NaN)
      },
    ],
    [
      "+Infinity",
      () => {
        s.d.set(Infinity)
        s.e.set(Infinity)
      },
    ],
    [
      "-Infinity",
      () => {
        s.d.set(-Infinity)
        s.e.set(1e39)
      },
    ],
    [
      "-0 (the messagepack codec delivers 0)",
      () => {
        s.d.set(-0)
        s.e.set(-0)
      },
    ],
    [
      "float32 rounding",
      () => {
        s.d.set(0.1)
        s.e.set(0.1)
      },
    ],
    ["fixed saturation", () => s.fx.set(1e12)],
    ["fixed negative saturation", () => s.fx.set(-Infinity)],
    ["fixed half-way negative", () => s.fx.set(-0.125)],
    [
      "fixed NaN is 0",
      () => {
        s.fx.set(1)
        s.fx.set(Number.NaN)
      },
    ],
    [
      "int saturation and truncation",
      () => {
        s.u8.set(300)
        s.i16.set(-2.9)
      },
    ],
  ]
  for (const [note, step] of steps) {
    step()
    r.tick(note)
  }
  return stateCases(
    "numeric edge values in state fields (§12): the server converts, the codec carries wire values",
    r,
  )
}

// ===========================================================================
// Messages
// ===========================================================================

const Inner = defineMessage("inner", {
  on: f.bool,
  id: f.uint32,
  label: f.optional(f.string),
})

const Everything = defineMessage("everything", {
  i8: f.int8,
  i16: f.int16,
  i32: f.int32,
  u8: f.uint8,
  u16: f.uint16,
  u32: f.uint32,
  f32: f.float32,
  f64: f.float64,
  fx0: f.fixed(0),
  fx3: f.fixed(3),
  fx9: f.fixed(9),
  s: f.string,
  b: f.bool,
  color: f.enum("red", "green", "blue"),
  level: f.enum(1, 5, 10),
  list: f.array(f.int16),
  names: f.map(f.string),
  maybe: f.optional(f.fixed(2)),
  maybeFlag: f.optional(f.bool),
  holes: f.array(f.optional(f.uint8)),
  sparse: f.map(f.optional(f.bool)),
  inner: f.nested(Inner),
  inners: f.array(f.nested(Inner)),
  flags: f.array(f.bool),
})

function everythingPayload(random: () => number): Record<string, unknown> {
  const int = (n: number): number => Math.floor(random() * n)
  const pick = <T>(xs: readonly T[]): T => xs[int(xs.length)] as T
  const inner = (): Record<string, unknown> => ({
    on: random() < 0.5,
    id: int(2 ** 32),
    ...(random() < 0.5 ? { label: pick(["", "x", "ünï"]) } : {}),
  })
  const payload: Record<string, unknown> = {
    i8: int(300) - 150,
    i16: int(70000) - 35000,
    i32: (random() - 0.5) * 5e9,
    u8: int(260),
    u16: int(66000),
    u32: random() * 4.3e9,
    f32: (random() - 0.5) * 1e6,
    f64: pick([0, 1.5, -2.25, 1e308, Math.E, (random() - 0.5) * 1e9]),
    fx0: (random() - 0.5) * 10,
    fx3: (random() - 0.5) * 1e4,
    fx9: (random() - 0.5) * 4,
    s: pick(["", "hello", "日本語", "é", "a".repeat(40)]),
    b: random() < 0.5,
    color: pick(["red", "green", "blue"]),
    level: pick([1, 5, 10]),
    list: Array.from({ length: int(4) }, () => int(65536) - 32768),
    names: Object.fromEntries(
      Array.from({ length: int(3) }, (_, i) => [`k${i}`, pick(["a", "bb"])]),
    ),
    holes: Array.from({ length: int(4) }, () =>
      random() < 0.3 ? null : int(256),
    ),
    sparse: { x: random() < 0.5 ? null : random() < 0.5 },
    inner: inner(),
    inners: Array.from({ length: int(3) }, inner),
    flags: Array.from({ length: int(10) }, () => random() < 0.5),
  }
  if (random() < 0.5) payload["maybe"] = (random() - 0.5) * 100
  if (random() < 0.5) payload["maybeFlag"] = random() < 0.5
  return payload
}

function messageCase(
  def: MessageDef,
  payload: Record<string, unknown>,
  description?: string,
): Case {
  const hex: Record<string, string> = {}
  let decoded: unknown
  for (const [name, codec] of Object.entries(codecs)) {
    const bytes = codec.encodeMessage(def, payload).unwrap()
    hex[name] = toHex(bytes)
    const back = normalize(codec.decodeMessage(def, bytes).unwrap())
    if (decoded === undefined) decoded = back
    else if (difference(back, decoded) !== undefined) {
      throw new Error(`${def.name}: the codecs decode differently`)
    }
  }
  const c: Case = { kind: "message" }
  if (description !== undefined) c["description"] = description
  c["message"] = declarationOf(def)
  c["payload"] = payload
  if (difference(decoded, normalize(payload)) !== undefined) {
    c["decoded"] = decoded
  }
  c["hex"] = hex
  return c
}

// The example shooter's contract (apps/example-shooter/shared).
const Input = defineMessage("input", {
  up: f.bool,
  down: f.bool,
  left: f.bool,
  right: f.bool,
  rotation: f.fixed(2),
  shooting: f.bool,
})
const GameResult = defineMessage("gameResult", {
  playerId: f.string,
  playerName: f.string,
  score: f.int32,
  rank: f.uint8,
  color: f.string,
})
const GameEnded = defineMessage("gameEnded", {
  results: f.array(f.nested(GameResult)),
})
const PlayerJoined = defineMessage("playerJoined", {
  playerId: f.string,
  playerName: f.string,
})

function messages(): Case[] {
  const random = rng(20260919)
  const cases: Case[] = []
  for (let i = 0; i < 24; i++) {
    cases.push(messageCase(Everything, everythingPayload(random)))
  }
  cases.push(
    messageCase(
      Input,
      {
        up: true,
        down: false,
        left: false,
        right: true,
        rotation: -1.5708,
        shooting: false,
      },
      "the shooter's input message",
    ),
    messageCase(
      GameEnded,
      {
        results: [
          {
            playerId: "k3Jd9",
            playerName: "Ann",
            score: 150,
            rank: 1,
            color: "#8b5cf6",
          },
          {
            playerId: "Zq81x",
            playerName: "Bo",
            score: -20,
            rank: 2,
            color: "#10b981",
          },
        ],
      },
      "the shooter's gameEnded message",
    ),
    messageCase(
      PlayerJoined,
      { playerId: "k3Jd9", playerName: "Ann" },
      "the shooter's playerJoined message",
    ),
    messageCase(
      defineMessage("gameStarted", {}),
      {},
      "a message with no fields",
    ),
  )
  return cases
}

// ===========================================================================
// Frames and handshakes
// ===========================================================================

function frameCase(
  direction: "client" | "server",
  description: string,
  type: number,
  header: number[],
  body?: { value: unknown } | { bytes: Uint8Array },
): Case {
  const bytes =
    body === undefined
      ? new Uint8Array()
      : "bytes" in body
        ? body.bytes
        : mp.encode(body.value).unwrap()
  const c: Case = { kind: "frame", description, direction, type, header }
  if (body !== undefined && "value" in body) c["body"] = body.value
  c["bodyHex"] = toHex(bytes)
  c["hex"] = toHex(encodeFrame(type, header, bytes).unwrap())
  return c
}

function frames(): Case[] {
  const S = ServerFrameType
  const C = ClientFrameType
  const move = defineMessage("move", { x: f.fixed(2), y: f.fixed(2) })
  const schemaBody = codecs["schema"]
    ?.encodeMessage(move, { x: 12.5, y: -7 })
    .unwrap()
  const mpBody = codecs["messagepack"]
    ?.encodeMessage(move, { x: 12.5, y: -7 })
    .unwrap()
  if (schemaBody === undefined || mpBody === undefined) throw new Error()
  const cases: Case[] = []
  const boundaries = [
    0, 127, 128, 16383, 16384, 2097151, 2097152, 268435456, 4294967295,
  ]
  for (const value of boundaries) {
    cases.push(
      frameCase("client", `PING at a varint boundary (${value})`, C.PING, [
        value,
        value,
      ]),
    )
  }
  cases.push(
    frameCase(
      "client",
      "ROOM_MESSAGE, schema codec body",
      C.ROOM_MESSAGE,
      [1, 3],
      { bytes: schemaBody },
    ),
    frameCase(
      "client",
      "ROOM_MESSAGE, messagepack codec body",
      C.ROOM_MESSAGE,
      [1, 3],
      { bytes: mpBody },
    ),
    frameCase(
      "client",
      "ROOM_MESSAGE_RAW with a nested payload",
      C.ROOM_MESSAGE_RAW,
      [2],
      {
        value: [
          "chat",
          { text: "hi", to: ["a", "b"], n: -1.5, ok: true, none: null },
        ],
      },
    ),
    frameCase("client", "LEAVE", C.LEAVE, [300]),
  )
  const joins: [string, unknown[]][] = [
    [
      "JOIN_OR_CREATE with options and a hash",
      [0, "shooter", { playerName: "Ann", level: 3 }, "c0ffee42"],
    ],
    ["CREATE without a hash", [1, "shooter", { private: true }, null]],
    ["JOIN with null options", [2, "shooter", null, null]],
    ["JOIN_BY_ID", [3, "Xk2p9QzA", {}, "c0ffee42"]],
    ["RECONNECT: mode and target only", [4, "Xk2p9QzA.9f8e7d6c5b4a"]],
    ["CONSUME_RESERVATION", [5, "res-0001", null, null]],
    [
      "a v2 JOIN with a fifth element (ignored by a v1 server)",
      [0, "shooter", {}, null, { future: true }],
    ],
  ]
  for (const [i, [description, body]] of joins.entries()) {
    cases.push(
      frameCase("client", `JOIN: ${description}`, C.JOIN, [i + 1], {
        value: body,
      }),
    )
  }

  const handshake = (
    codec: string,
    token: string | null,
    extra: unknown[] = [],
  ) => [
    "Xk2p9QzA",
    "shooter",
    "k3Jd9",
    token,
    "c0ffee42",
    codec,
    ["input", "ready", "startGame"],
    ["playerJoined", "playerLeft", "gameStarted", "gameEnded"],
    ...extra,
  ]
  cases.push(
    frameCase(
      "server",
      "JOIN_SUCCESS: schema codec, with a token",
      S.JOIN_SUCCESS,
      [1, 1],
      {
        value: handshake("schema", "Xk2p9QzA.9f8e7d6c5b4a"),
      },
    ),
    frameCase(
      "server",
      "JOIN_SUCCESS: messagepack codec, no reconnection",
      S.JOIN_SUCCESS,
      [2, 2],
      {
        value: handshake("messagepack", null),
      },
    ),
    frameCase(
      "server",
      "JOIN_SUCCESS: a room without a contract (empty tables)",
      S.JOIN_SUCCESS,
      [3, 3],
      {
        value: ["r", "lobby", "s", null, "811c9dc5", "schema", [], []],
      },
    ),
    frameCase(
      "server",
      "JOIN_SUCCESS with a ninth element: v1 clients read the first eight",
      S.JOIN_SUCCESS,
      [4, 4],
      {
        value: handshake("schema", "t", [{ region: "eu" }]),
      },
    ),
    frameCase("server", "JOIN_ERROR", S.JOIN_ERROR, [5], {
      value: ["CONTRACT_MISMATCH", "contract hash differs"],
    }),
    frameCase(
      "server",
      "JOIN_ERROR with a trailing element",
      S.JOIN_ERROR,
      [6],
      {
        value: ["ROOM_FULL", "full", { retryAfter: 5 }],
      },
    ),
    frameCase(
      "server",
      "ROOM_MESSAGE, schema codec body",
      S.ROOM_MESSAGE,
      [1, 0],
      { bytes: schemaBody },
    ),
    frameCase("server", "ROOM_MESSAGE_RAW", S.ROOM_MESSAGE_RAW, [1], {
      value: ["tick", 42],
    }),
    frameCase("server", "STATE_PATCH, messagepack body", S.STATE_PATCH, [1], {
      bytes: mp.encode([[0, 2, 1, -325]]).unwrap(),
    }),
    frameCase("server", "CLIENT_JOINED", S.CLIENT_JOINED, [1], {
      value: "k3Jd9",
    }),
    frameCase("server", "CLIENT_LEFT", S.CLIENT_LEFT, [1], { value: "k3Jd9" }),
    frameCase("server", "LEAVE: room disposed", S.LEAVE, [1, 4002]),
    frameCase("server", "LEAVE: kicked, with a reason", S.LEAVE, [1, 4000], {
      value: "cheating",
    }),
    frameCase("server", "LEAVE: server shutdown", S.LEAVE, [2, 4001]),
    frameCase("server", "ERROR for a room", S.ERROR, [1], {
      value: ["DESYNC", "resync required"],
    }),
    frameCase("server", "ERROR with a trailing element", S.ERROR, [0], {
      value: ["INVALID_MESSAGE", "why", 1],
    }),
    frameCase("server", "PONG", S.PONG, [4294967295]),
  )
  return cases
}

function compatibility(): Case[] {
  const cases: Case[] = []
  for (const type of [11, 12, 64, 127, 128, 200, 254, 255]) {
    cases.push({
      kind: "behavior",
      side: "client",
      description: `unknown server frame type ${type} (any header or body)`,
      frames: [toHex(new Uint8Array([type, 1, 0x80, 0x01, 0xc0, 0xff]))],
      expect: "drop",
    })
  }
  for (const type of [5, 6, 10, 128, 255]) {
    cases.push({
      kind: "behavior",
      side: "server",
      description: `unknown client frame type ${type}`,
      frames: [toHex(new Uint8Array([type, 1]))],
      expect: "violation",
    })
  }
  for (const extra of [[null], [1, "two"], [{ nested: [1, 2] }, true, 3.5]]) {
    const body = mp.encode([1, "compat", {}, null, ...extra]).unwrap()
    cases.push({
      kind: "behavior",
      side: "server",
      description: `JOIN (CREATE compat) with ${extra.length} trailing element(s)`,
      frames: [toHex(encodeFrame(ClientFrameType.JOIN, [20], body).unwrap())],
      expect: "accept",
    })
    const raw = mp.encode(["t", "payload", ...extra]).unwrap()
    cases.push({
      kind: "behavior",
      side: "server",
      description: `ROOM_MESSAGE_RAW with ${extra.length} trailing element(s)`,
      frames: [
        toHex(encodeFrame(ClientFrameType.ROOM_MESSAGE_RAW, [1], raw).unwrap()),
      ],
      expect: "accept",
    })
    const error = mp.encode(["CODE", "message", ...extra]).unwrap()
    cases.push({
      kind: "behavior",
      side: "client",
      description: `ERROR with ${extra.length} trailing element(s)`,
      frames: [toHex(encodeFrame(ServerFrameType.ERROR, [1], error).unwrap())],
      expect: "accept",
    })
  }
  return cases
}

// ===========================================================================

await write(
  "101-generated-frames.json",
  "Frames in both directions (§3, §5), headers at every varint length boundary, JOIN bodies of every mode, handshakes (§6.4) for both codecs. Generated by the reference implementation.",
  frames(),
)
await write(
  "102-generated-state.json",
  "State streams (§11, §13) under both codecs, generated from the reference server's state layer: every type, refId reuse, nested schemas and a late joiner, numeric edge values.",
  [...everyType(), ...refIdReuse(), ...lateJoiner(), ...numericEdges()],
)
await write(
  "103-generated-filtered.json",
  "Per-client filtered streams (§11.8) under both codecs: frames list the clients they go to. Generated by the reference implementation.",
  filtered(),
)
await write(
  "104-generated-messages.json",
  "Contract messages (§10, §13.1.6, §13.2.2) under both codecs: random payloads over every field kind (seeded), and the example shooter's messages. Generated by the reference implementation.",
  messages(),
)
await write(
  "105-generated-compatibility.json",
  "Forward-compatibility rules (§9): unknown frame types in both directions, trailing elements in array bodies. Generated.",
  compatibility(),
)
