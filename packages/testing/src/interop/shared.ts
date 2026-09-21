/**
 * The contract and state of the cross-language interop server
 * (`server.ts`). Deliberately small, but covering every shape a client has
 * to get right: fixed-point, integer and boolean fields, a `schemaMap` of
 * nested instances, a primitive `set` and `array`, optional and nested
 * message fields.
 *
 * Nothing here is random or clock-dependent: every value a client sees is
 * a function of the messages it sent, so a C#, GDScript or TypeScript run
 * ends in exactly the same state.
 *
 * `bun run codegen:interop` emits the C# and GDScript bindings the
 * non-TypeScript runners use, so all three speak the same declarations.
 */
import {
  createArray,
  createBoolean,
  createFixedPoint,
  createInt,
  createSchemaMap,
  createSet,
  createString,
  Schema,
} from "@bungohan/state"
import { defineContract, defineMessage, f } from "@bungohan/types"

export class InteropPlayer extends Schema {
  public static override schemaName = "Interop.Player"
  public name = createString()
  public x = createFixedPoint(2)
  public y = createFixedPoint(2)
  public score = createInt(f.int32)
  public alive = createBoolean(true)
  public tags = createSet(f.string)
}

export class InteropState extends Schema {
  public static override schemaName = "Interop.State"
  public turn = createInt(f.uint32)
  public label = createString()
  public players = createSchemaMap(f.string, InteropPlayer)
  public log = createArray(f.string)
}

/** One player of a `dump`, mirroring {@link InteropPlayer}. */
export const PlayerDump = defineMessage("playerDump", {
  id: f.string,
  name: f.string,
  x: f.fixed(2),
  y: f.fixed(2),
  score: f.int32,
  alive: f.bool,
  tags: f.array(f.string),
})

/** The server's own view of its state, for a client to compare against. */
export const Dump = defineMessage("dump", {
  turn: f.uint32,
  label: f.string,
  log: f.array(f.string),
  players: f.array(f.nested(PlayerDump)),
})

export const Welcome = defineMessage("welcome", {
  sessionId: f.string,
  players: f.uint8,
})

export const Echoed = defineMessage("echoed", {
  text: f.string,
  count: f.int32,
  note: f.optional(f.string),
})

export const Move = defineMessage("move", { dx: f.fixed(2), dy: f.fixed(2) })
export const SetName = defineMessage("setName", { name: f.string })
export const AddTag = defineMessage("addTag", { tag: f.string })
export const Bump = defineMessage("bump", {
  by: f.int32,
  alive: f.bool,
  note: f.optional(f.string),
})
/** Asks for a `dump` of the server's state. */
export const RequestDump = defineMessage("requestDump", {})
/** Asks the server to echo it back as `echoed`. */
export const Echo = defineMessage("echo", { text: f.string, count: f.int32 })
/** Asks the server to kick this client from the room (`LEAVE 4000`). */
export const KickMe = defineMessage("kickMe", { reason: f.string })
/** Asks the server to drop the whole connection, without a consented leave. */
export const DropMe = defineMessage("dropMe", {})

export const interopContract = defineContract({
  client: {
    move: Move,
    setName: SetName,
    addTag: AddTag,
    bump: Bump,
    requestDump: RequestDump,
    echo: Echo,
    kickMe: KickMe,
    dropMe: DropMe,
  },
  server: { welcome: Welcome, dump: Dump, echoed: Echoed },
})

/**
 * Typed join and create options (PROTOCOL.md §6.2.1): exactly what the
 * `join` conformance vectors declare, served by the room type `options`.
 */
export const OptionsCreate = defineMessage("optionsCreate", {
  mode: f.enum("duel", "team"),
  rounds: f.uint8,
  friendlyFire: f.bool,
})
export const OptionsJoin = defineMessage("optionsJoin", {
  name: f.string,
  aim: f.fixed(2),
  team: f.optional(f.uint8),
  spectator: f.bool,
})

export const optionsContract = defineContract({
  client: {},
  server: {},
  options: { create: OptionsCreate, join: OptionsJoin },
})
