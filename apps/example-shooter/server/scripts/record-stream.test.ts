/**
 * The committed shooter recordings (clients/fixtures/shooter-stream.*.json)
 * replayed through the TypeScript client state layer: the same checks the
 * C# and GDScript tests make, so all three agree on what a correct replica
 * of the stream is.
 */
import { expect, test } from "bun:test"
import { GameState, shooterContract } from "@bungohan/example-shooter-shared"
import {
  type IStateCodec,
  MessagePackStateCodec,
  SchemaCodec,
} from "@bungohan/serializer"
import {
  applyDelta,
  reachableSchemaClasses,
  SchemaRegistry,
} from "@bungohan/state"
import { dumpState } from "./record-stream"

interface Recording {
  codec: string
  contractHash: string
  serverMessages: string[]
  frames: { kind: string; hex: string; name?: string; payload?: unknown }[]
  events: Record<string, number>
  final: unknown
}

const codecs: Record<string, IStateCodec> = {
  schema: new SchemaCodec(),
  messagepack: new MessagePackStateCodec(),
}

function fromHex(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g) ?? [], (b) => Number.parseInt(b, 16))
}

for (const name of ["schema", "messagepack"]) {
  test(`shooter-stream.${name}.json replays to its final state`, async () => {
    const recording: Recording = await Bun.file(
      new URL(
        `../../../../clients/fixtures/shooter-stream.${name}.json`,
        import.meta.url,
      ),
    ).json()
    const codec = codecs[recording.codec]
    if (codec === undefined) throw new Error(`no codec ${recording.codec}`)
    SchemaRegistry.register(...reachableSchemaClasses(GameState))

    const session = codec.createSession()
    const root = new GameState()
    const events: Record<string, number> = {}
    const count = (key: string) => () => {
      events[key] = (events[key] ?? 0) + 1
    }
    let snapshots = 0
    for (const frame of recording.frames) {
      const body = fromHex(frame.hex)
      if (frame.kind === "message") {
        const def =
          shooterContract.server[
            frame.name as keyof typeof shooterContract.server
          ]
        expect<unknown>(codec.decodeMessage(def, body).unwrap()).toEqual(
          frame.payload,
        )
        continue
      }
      applyDelta(root, session.decodeOps(body).unwrap()).unwrap()
      if (frame.kind === "snapshot" && snapshots++ === 0) {
        // Listeners attached once the join's snapshot is applied.
        root.enemies.onAdd(count("enemiesAdded"))
        root.enemies.onRemove(count("enemiesRemoved"))
        root.bullets.onAdd(count("bulletsAdded"))
        root.bullets.onRemove(count("bulletsRemoved"))
        root.loot.onAdd(count("lootAdded"))
        root.loot.onRemove(count("lootRemoved"))
        root.gameStatus.onChange(count("statusChanges"))
        root.players.onAdd((player) => {
          count("playersAdded")()
          player.score.onChange(count("scoreChanges"))
        })
      }
    }
    expect(snapshots).toBe(1)
    expect(recording.contractHash).toBe(
      (await import("@bungohan/types")).contractHash(shooterContract),
    )
    for (const [key, value] of Object.entries(recording.events)) {
      expect({ key, value: events[key] ?? 0 }).toEqual({ key, value })
    }
    expect<unknown>(dumpState(root)).toEqual(recording.final)
  })
}
