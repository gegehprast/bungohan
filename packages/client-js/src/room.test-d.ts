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
import { useRoom } from "./react"

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

// --- typed options (spec §4.1.2) --------------------------------------------

const Lobby = defineMessage("lobby", { map: f.enum("dust", "ice") })
const Player = defineMessage("player", {
  name: f.string,
  team: f.optional(f.uint8),
})
const both = defineContract({
  client: { move: Move },
  server: {},
  options: { create: Lobby, join: Player },
})
const joinOnly = defineContract({
  client: {},
  server: {},
  options: { join: Player },
})

export async function typedOptions(): Promise<void> {
  // Creating modes take { create, join } when create options are declared…
  await client.joinOrCreate(
    "r",
    { create: { map: "ice" }, join: { name: "ann" } },
    { contract: both },
  )
  await client.create(
    "r",
    { create: { map: "dust" }, join: { name: "ann", team: 2 } },
    { state: Score, contract: both },
  )
  // …and joining modes the join options alone.
  await client.join("r", { name: "ann" }, { contract: both })
  await client.joinById("id", { name: "ann" }, { contract: both })
  // With only join options declared, every mode takes them directly.
  await client.joinOrCreate("r", { name: "ann" }, { contract: joinOnly })

  // @ts-expect-error — the options are required
  await client.joinOrCreate("r", undefined, { contract: both })
  // @ts-expect-error — missing the create options
  await client.joinOrCreate("r", { join: { name: "ann" } }, { contract: both })
  const j = { contract: both } as const
  // @ts-expect-error — not one of the enum's values
  await client.create("r", { create: { map: "lava" }, join: { name: "a" } }, j)
  // @ts-expect-error — a number where the declaration says string
  await client.join("r", { name: 1 }, { contract: both })
  // @ts-expect-error — create options where join options go
  await client.join("r", { create: { map: "ice" } }, { contract: both })
  // @ts-expect-error — an unknown field
  await client.joinById("id", { name: "a", nick: "b" }, { contract: both })

  // The room is still typed by the contract.
  const joined = await client.join("r", { name: "ann" }, { contract: both })
  if (joined.isOk()) joined.value.send("move", { x: 1, y: 2 })
}

export function useTypedRoomChecks(): void {
  // The mode picks the options' type, as the client's methods do.
  useRoom("r", { create: { map: "ice" }, join: { name: "a" } }, "create", {
    contract: both,
  })
  useRoom("r", { name: "a" }, "join", { contract: both })
  useRoom("id", { name: "a" }, "joinById", { contract: both })
  const withState = useRoom("r", { name: "a" }, "joinOrCreate", {
    state: Score,
    contract: joinOnly,
  })
  void withState.room?.state.points
  const j = { contract: both } as const
  // @ts-expect-error — join options where { create, join } go
  useRoom("r", { name: "a" }, "joinOrCreate", j)
  // @ts-expect-error — { create, join } where join options go
  useRoom("r", { create: { map: "ice" }, join: { name: "a" } }, "join", j)
  // Untyped contracts keep every argument optional.
  useRoom("r")
  useRoom("r", { anything: 1 }, "join", { contract })
}
