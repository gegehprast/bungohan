/**
 * Type-level tests for core's typed rooms, checked by `tsc --noEmit` (never
 * executed). Every `@ts-expect-error` is an assertion.
 */
import { createNumber, Schema } from "@bungohan/state"
import {
  defineContract,
  defineMessage,
  f,
  type InferCreateOptions,
} from "@bungohan/types"
import type { Client } from "./client"
import { Room } from "./room"
import { BungohanServer } from "./server"
import type { RoomOnCreateOptions } from "./types"

class S extends Schema {
  public static override schemaName = "TD.S"
  public n = createNumber()
}

const Move = defineMessage("move", { x: f.fixed(2) })
const Hit = defineMessage("hit", { by: f.string })
const contract = defineContract({
  client: { move: Move },
  server: { hit: Hit },
})

class Typed extends Room<S, typeof contract> {
  public static override contract = contract
  public override state = new S()

  protected override async onCreate(): Promise<void> {
    this.onMessage("move", (client, msg) => {
      const x: number = msg.x
      this.send(client, "hit", { by: client.sessionId })
      this.broadcast("hit", { by: String(x) }, client)
      // @ts-expect-error — wrong direction
      this.send(client, "move", { x: 1 })
      // @ts-expect-error — wrong payload
      this.broadcast("hit", { by: 1 })
    })
    // @ts-expect-error — not a client message
    this.onMessage("hit", () => {})
  }
}

class Forgot extends Room<S, typeof contract> {
  public override state = new S()
}

class Untyped extends Room<S> {
  public override state = new S()
  protected override async onJoin(client: Client): Promise<void> {
    this.sendRaw(client, "anything", { at: 1 })
    // @ts-expect-error — no contract, no typed send
    this.send(client, "hit", { by: "x" })
  }
}

const server = new BungohanServer({ transport: { config: { port: 0 } } })
server.defineRoomType("typed", Typed)
server.defineRoomType("untyped", Untyped)
// @ts-expect-error — typed with a contract but no `static contract`
server.defineRoomType("forgot", Forgot)

class WrongContract extends Room<S, typeof contract> {
  public static override contract = defineContract({ client: {}, server: {} })
}
// @ts-expect-error — `static contract` is not the typed contract
server.defineRoomType("wrong", WrongContract)

// Typed rooms are rooms.
export const rooms: Room[] = [new Typed(), new Untyped()]

// --- typed options (spec §4.1.2) --------------------------------------------

const withOptions = defineContract({
  client: {},
  server: {},
  options: {
    create: defineMessage("setup", { rounds: f.uint8 }),
    join: defineMessage("player", { name: f.string }),
  },
})

class WithOptions extends Room<S, typeof withOptions> {
  public static override contract = withOptions

  protected override async onCreate(
    options: RoomOnCreateOptions & InferCreateOptions<typeof withOptions>,
  ): Promise<void> {
    const rounds: number = options.rounds
    void rounds
  }

  protected override async onJoin(
    _client: Client,
    options: { name: string },
  ): Promise<void> {
    const name: string = options.name
    void name
  }
}

class NarrowsWrong extends Room<S, typeof withOptions> {
  public static override contract = withOptions
  // @ts-expect-error — the join options have no `level`
  protected override async onJoin(
    _client: Client,
    options: { level: number },
  ): Promise<void> {
    void options
  }
}

server.defineRoomType("options", WithOptions)
export const narrowsWrong = NarrowsWrong

export async function serverBuilt(): Promise<void> {
  const mm = server.getMatchMaker()
  await mm.createRoom(WithOptions, { rounds: 3 })
  await mm.joinOrCreate(WithOptions, { rounds: 3 })
  await mm.reserve(WithOptions, { name: "bot" }, undefined, { rounds: 1 })
  // @ts-expect-error — the create options are required
  await mm.createRoom(WithOptions)
  // @ts-expect-error — wrong type
  await mm.createRoom(WithOptions, { rounds: "3" })
  // @ts-expect-error — join options, not create options
  await mm.reserve(WithOptions, { rounds: 3 })
  // By name nothing is typed; the options are converted at run time.
  await mm.createRoom("options", { anything: true })
  // An untyped class takes anything, as before.
  await mm.createRoom(Untyped, { anything: true })
  await mm.createRoom(Untyped)
}
