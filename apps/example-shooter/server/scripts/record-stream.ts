/**
 * Records a real state stream from the shooter server, for the C# and
 * GDScript clients' tests (clients/fixtures/shooter-stream.<codec>.json).
 *
 * Two client-js players join a shooter room on the loopback harness, ready
 * up and play: a full round under the `schema` codec (60 s of simulated
 * time, so enemies spawn and die, bullets come and go, and the round ends
 * with `gameEnded`), and 15 s under `messagepack`. Every
 * frame Alice's client receives is recorded as bytes, with:
 *
 * - `serverMessages`: the handshake's table, so message ids resolve by name;
 * - each contract message's decoded payload;
 * - `events`: how often Alice's replica fired some listeners, attached once
 *   the join's snapshot was applied (as `room.listen` does on a joined room);
 * - `final`: a canonical dump of Alice's replica after the last frame.
 *
 * The game uses Math.random, so a new recording differs from the last one:
 * this is a recording, not a generated vector. `record-stream.test.ts`
 * replays the committed files through the TypeScript client state layer.
 *
 *     bun apps/example-shooter/server/scripts/record-stream.ts
 */
import type { BungohanClient, IRoom } from "@bungohan/client-js"
import {
  GAME_CONFIG,
  GameState,
  type PlayerInput,
  ROOM_TYPE,
  shooterContract,
} from "@bungohan/example-shooter-shared"
import {
  decodeFrame,
  type IStateCodec,
  MessagePackSerializer,
  MessagePackStateCodec,
  SchemaCodec,
} from "@bungohan/serializer"
import {
  ArrayBase,
  MapBase,
  PrimitiveState,
  Schema,
  SetBase,
} from "@bungohan/state"
import { createTestHarness } from "@bungohan/testing"
import { SERVER_FRAME_HEADERS } from "@bungohan/types"
import { setupShooterServer } from "../src/app"

const OUT = new URL("../../../../clients/fixtures/", import.meta.url)

type Plain = null | boolean | number | string | Plain[] | { [k: string]: Plain }

function number(value: number): Plain {
  if (Number.isFinite(value) && !Object.is(value, -0)) return value
  const view = new DataView(new ArrayBuffer(8))
  view.setFloat64(0, value)
  return { f64: view.getBigUint64(0).toString(16).padStart(16, "0") }
}

function compareKeys(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a - b
  const x = String(a)
  const y = String(b)
  return x < y ? -1 : x > y ? 1 : 0
}

function element(value: unknown): Plain {
  if (value instanceof Schema) return dumpState(value)
  if (typeof value === "number") return number(value)
  if (typeof value === "string" || typeof value === "boolean") return value
  return null
}

/**
 * A replica as canonical JSON: `{"$class": name, field: value, …}` in field
 * order; maps as `[key, value]` pairs sorted by key, sets sorted, arrays in
 * order. Every client test builds the same dump from its own replica.
 */
export function dumpState(schema: Schema): Plain {
  const info = schema._ensureInit()
  const out: { [k: string]: Plain } = { $class: info.name }
  for (const field of info.fields) {
    const value: unknown = Reflect.get(schema, field.name)
    if (value instanceof Schema) out[field.name] = dumpState(value)
    else if (value instanceof PrimitiveState)
      out[field.name] = element(value.get())
    else if (value instanceof MapBase) {
      out[field.name] = [...value]
        .sort(([a], [b]) => compareKeys(a, b))
        .map(([k, v]) => [element(k), element(v)])
    } else if (value instanceof SetBase) {
      out[field.name] = [...value].sort(compareKeys).map(element)
    } else if (value instanceof ArrayBase) {
      out[field.name] = [...value].map(element)
    }
  }
  return out
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
}

const idle: PlayerInput = {
  up: false,
  down: false,
  left: false,
  right: false,
  rotation: 0,
  shooting: false,
}

type ShooterView = IRoom<GameState, typeof shooterContract>

async function record(codec: IStateCodec, playMs: number): Promise<unknown> {
  const shooter = { state: GameState, contract: shooterContract }
  const h = await createTestHarness({
    define: (server) => setupShooterServer(server, { log: false }),
    server: { stateCodec: codec },
    client: { pingInterval: 0, logger: { warn() {}, error() {} } },
  })
  const mp = new MessagePackSerializer()

  const alice: BungohanClient = await h.connect()
  const received: Uint8Array[] = []
  h.socketOf(alice).onMessage((data) => received.push(data.slice()))

  const events = {
    enemiesAdded: 0,
    enemiesRemoved: 0,
    bulletsAdded: 0,
    bulletsRemoved: 0,
    lootAdded: 0,
    lootRemoved: 0,
    playersAdded: 0,
    scoreChanges: 0,
    statusChanges: 0,
  }
  const room: ShooterView = (
    await alice.create(
      ROOM_TYPE.SHOOTER,
      { playerName: "Alice", maxPlayers: 4, roomName: "Recorded ☃" },
      shooter,
    )
  ).unwrap()
  room.listen((state) => {
    const offs = [
      state.enemies.onAdd(() => events.enemiesAdded++),
      state.enemies.onRemove(() => events.enemiesRemoved++),
      state.bullets.onAdd(() => events.bulletsAdded++),
      state.bullets.onRemove(() => events.bulletsRemoved++),
      state.loot.onAdd(() => events.lootAdded++),
      state.loot.onRemove(() => events.lootRemoved++),
      state.gameStatus.onChange(() => events.statusChanges++),
      state.players.onAdd((player) => {
        events.playersAdded++
        player.score.onChange(() => events.scoreChanges++)
      }),
    ]
    return () => {
      for (const off of offs) off()
    }
  })

  const bob = (
    await (await h.connect()).joinById(room.id, { playerName: "Bob" }, shooter)
  ).unwrap()
  await h.tick(100)
  room.send("ready", { isReady: true })
  bob.send("ready", { isReady: true })
  await h.tick(100)
  room.send("startGame", {})
  await h.tick(100)

  // Play: steer both players around, shooting now and then.
  for (let t = 0; t < playMs; t += 250) {
    const phase = Math.floor(t / 1500) % 4
    room.send("input", {
      ...idle,
      up: phase === 0,
      right: phase === 1,
      down: phase === 2,
      left: phase === 3,
      rotation: (t / 1000) % (2 * Math.PI),
      shooting: phase % 2 === 0,
    })
    bob.send("input", {
      ...idle,
      left: phase < 2,
      right: phase >= 2,
      rotation: -((t / 700) % Math.PI),
      shooting: phase === 1,
    })
    await h.tick(250)
  }
  await h.flushSync()

  // The handshake names the server's message table (ids resolve by name).
  const frames: unknown[] = []
  let serverMessages: string[] = []
  let contractHash = ""
  for (const data of received) {
    const frame = decodeFrame(data, SERVER_FRAME_HEADERS)
    if (frame.isErr()) throw frame.error
    const { type, header, body } = frame.value
    if (type === 4) {
      const handshake = mp.decode(body).unwrap()
      if (!Array.isArray(handshake)) throw new Error("bad handshake")
      contractHash = String(handshake[4])
      serverMessages = (handshake[7] as unknown[]).map(String)
    } else if (type === 2 || type === 3) {
      frames.push({ kind: type === 2 ? "snapshot" : "patch", hex: hex(body) })
    } else if (type === 0) {
      const name = serverMessages[header[1] ?? -1]
      const def =
        name === undefined
          ? undefined
          : shooterContract.server[name as keyof typeof shooterContract.server]
      if (def === undefined) throw new Error(`unknown message id ${header[1]}`)
      const payload = codec.decodeMessage(def, body).unwrap()
      frames.push({ kind: "message", name, hex: hex(body), payload })
    }
  }
  const final = dumpState(room.state)
  await h.stop()
  return {
    description:
      `A shooter round recorded from the TypeScript server under the ${codec.getName()} codec: ` +
      "every STATE_SNAPSHOT/STATE_PATCH body and contract message Alice's client received, in order. " +
      "`final` is her replica after the last frame (maps as sorted [key, value] pairs, sets sorted), " +
      "`events` how often her replica's listeners fired. Written by apps/example-shooter/server/scripts/record-stream.ts.",
    codec: codec.getName(),
    contractHash,
    serverMessages,
    frames,
    events,
    final,
  }
}

/** One frame per line: readable diffs, no indentation bulk. */
function format(value: unknown): string {
  if (typeof value !== "object" || value === null) return JSON.stringify(value)
  const { frames, ...rest } = value as { frames: unknown[] }
  const head = JSON.stringify(rest, null, 1).slice(0, -2)
  const lines = frames.map((frame) => `  ${JSON.stringify(frame)}`)
  return `${head},\n "frames": [\n${lines.join(",\n")}\n ]\n}\n`
}

async function write(name: string, value: unknown): Promise<void> {
  const url = new URL(name, OUT)
  await Bun.write(url, format(value))
  console.log(`${url.pathname}: ${(await Bun.file(url).size) >> 10} KiB`)
}

if (import.meta.main) {
  // The full round (it ends with gameEnded), under the default codec...
  const round = GAME_CONFIG.GAME_DURATION_S * 1000 + 2000
  await write(
    "shooter-stream.schema.json",
    await record(new SchemaCodec(), round),
  )
  // ...and 15 s of it under messagepack, whose bodies are about twice as big.
  await write(
    "shooter-stream.messagepack.json",
    await record(new MessagePackStateCodec(), 15_000),
  )
}
