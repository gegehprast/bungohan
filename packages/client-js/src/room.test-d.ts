/**
 * Type-level tests, checked by `tsc --noEmit` (never executed). Each
 * `@ts-expect-error` fails the typecheck if the error it expects disappears.
 *
 * The client sees the contract with the direction inverted (spec §4.1):
 * it sends `client` messages and receives `server` ones.
 */
import { createNumber, Schema } from "@bungohan/state"
import { defineContract, defineMessage, f } from "@bungohan/types"
import type { IBungohanClient } from "./client"

class Score extends Schema {
  public static override schemaName = "TypeTest.Score"
  public points = createNumber()
}

const Move = defineMessage("move", { x: f.fixed(2), y: f.fixed(2) })
const Started = defineMessage("started", {
  level: f.int32,
  names: f.array(f.string),
})
const contract = defineContract({
  client: { move: Move },
  server: { started: Started },
})

declare const client: IBungohanClient

export async function inferred(): Promise<void> {
  // State and contract types are inferred from the runtime join options.
  const joined = await client.joinOrCreate("r", {}, { state: Score, contract })
  if (joined.isErr()) return
  const room = joined.value

  const points: number = room.state.points.get()
  void points

  room.send("move", { x: 1, y: 2 })
  // @ts-expect-error — "started" is a server → client message
  room.send("started", { level: 1, names: [] })
  // @ts-expect-error — unknown message
  room.send("mvoe", { x: 1, y: 2 })
  // @ts-expect-error — wrong payload type
  room.send("move", { x: "1", y: 2 })
  // @ts-expect-error — missing field
  room.send("move", { x: 1 })

  room.onMessage("started", (message) => {
    const level: number = message.level
    const names: string[] = message.names
    void level
    void names
    // @ts-expect-error — no such field
    void message.score
  })
  // @ts-expect-error — "move" is client → server
  room.onMessage("move", () => {})

  room.listen((state) => state.points.onChange((value) => void value))
  // Raw messages stay untyped.
  room.sendRaw("anything", { at: "all" })
  room.onMessageRaw((type: string, message: unknown) => void [type, message])
}

export async function explicitGenerics(): Promise<void> {
  // The §4.1 spelling type-checks too (at runtime, pass the contract).
  const joined = await client.joinOrCreate<Score, typeof contract>("r")
  if (joined.isOk()) joined.value.send("move", { x: 0, y: 0 })
}

export async function noContract(): Promise<void> {
  const joined = await client.joinOrCreate("r")
  if (joined.isErr()) return
  // @ts-expect-error — EmptyContract: no typed messages at all
  joined.value.send("move", { x: 1, y: 2 })
  joined.value.sendRaw("move", { x: 1, y: 2 })
}
