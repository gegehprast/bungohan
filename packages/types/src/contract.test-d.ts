/**
 * Type-level tests for §4.1 contracts, checked by `tsc --noEmit` (never
 * executed). Every `@ts-expect-error` is an assertion: if the call it guards
 * stops being a compile error, tsc reports an unused directive and fails.
 *
 * `Room` / `IRoom` below are stand-ins using the exact generic signatures from
 * spec §6.2 / §7.2, so core and client-js inherit what is proven here.
 */
import {
  type Contract,
  defineContract,
  defineMessage,
  type EmptyContract,
  f,
  type Infer,
  type RecvMap,
  type SendMap,
} from "./index"

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false
function expectType<T extends true>(): T | undefined {
  return undefined
}

// --- The spec's own example -------------------------------------------------

const PlayerMove = defineMessage("playerMove", { x: f.fixed(2), y: f.fixed(2) })
const Shoot = defineMessage("shoot", { angle: f.fixed(3) })
const GameStart = defineMessage("gameStart", {
  level: f.int32,
  players: f.array(f.string),
})
const PlayerDied = defineMessage("playerDied", { sessionId: f.string })

type PlayerMove = Infer<typeof PlayerMove>

const shooterContract = defineContract({
  client: { playerMove: PlayerMove, shoot: Shoot },
  server: { gameStart: GameStart, playerDied: PlayerDied },
})

expectType<Equal<PlayerMove, { x: number; y: number }>>()
expectType<
  Equal<Infer<typeof GameStart>, { level: number; players: string[] }>
>()

// --- Every builder ------------------------------------------------------------

const Vec = defineMessage("vec", { x: f.float32, y: f.float32 })
const Everything = defineMessage("everything", {
  i8: f.int8,
  i16: f.int16,
  i32: f.int32,
  u8: f.uint8,
  u16: f.uint16,
  u32: f.uint32,
  f32: f.float32,
  f64: f.float64,
  fx: f.fixed(0),
  s: f.string,
  b: f.bool,
  team: f.enum("red", "blue"),
  level: f.enum(1, 2, 3),
  tags: f.array(f.string),
  grid: f.array(f.array(f.int8)),
  scores: f.map(f.int32),
  pos: f.nested(Vec),
  path: f.array(f.nested(Vec)),
  maybe: f.optional(f.string),
  maybePos: f.optional(f.nested(Vec)),
  holes: f.array(f.optional(f.int8)),
})

expectType<
  Equal<
    Infer<typeof Everything>,
    {
      i8: number
      i16: number
      i32: number
      u8: number
      u16: number
      u32: number
      f32: number
      f64: number
      fx: number
      s: string
      b: boolean
      team: "red" | "blue"
      level: 1 | 2 | 3
      tags: string[]
      grid: number[][]
      scores: { [key: string]: number }
      pos: { x: number; y: number }
      path: { x: number; y: number }[]
      maybe?: string
      maybePos?: { x: number; y: number }
      holes: (number | undefined)[]
    }
  >
>()

// Nested messages nest arbitrarily deep.
const Outer = defineMessage("outer", {
  inner: f.nested(defineMessage("inner", { v: f.nested(Vec) })),
})
expectType<
  Equal<Infer<typeof Outer>, { inner: { v: { x: number; y: number } } }>
>()

// Descriptors are real runtime values: the layout survives erasure.
expectType<Equal<typeof PlayerMove.name, "playerMove">>()
export const layout: readonly string[] = PlayerMove.fieldNames

// Integer-like field names would be reordered by JS: compile error.
// @ts-expect-error — "0" is not a valid field name
defineMessage("numeric", { 0: f.int8, name: f.string })
// @ts-expect-error — numeric-looking string keys too
defineMessage("numeric2", { "12": f.int8 })

// --- defineContract -----------------------------------------------------------

export const mismatched = defineContract({
  // @ts-expect-error — key "move" does not match the message name "playerMove"
  client: { move: PlayerMove },
  server: {},
})

// @ts-expect-error — a contract's values must be message definitions
defineContract({ client: { shoot: { angle: 1 } }, server: {} })

expectType<
  Equal<keyof RecvMap<typeof shooterContract>, "playerMove" | "shoot">
>()
expectType<
  Equal<keyof SendMap<typeof shooterContract>, "gameStart" | "playerDied">
>()

// --- Server side: spec §6.2 signatures ---------------------------------------

interface Client {
  sessionId: string
}
declare abstract class Room<TContract extends Contract = EmptyContract> {
  protected send<K extends keyof SendMap<TContract>>(
    client: Client,
    type: K,
    message: Infer<SendMap<TContract>[K]>,
  ): void
  protected broadcast<K extends keyof SendMap<TContract>>(
    type: K,
    message: Infer<SendMap<TContract>[K]>,
    except?: Client,
  ): void
  public onMessage<K extends keyof RecvMap<TContract>>(
    type: K,
    handler: (
      client: Client,
      message: Infer<RecvMap<TContract>[K]>,
    ) => void | Promise<void>,
  ): () => void
  protected sendRaw(client: Client, type: string, message: unknown): void
  public onMessageRaw(
    type: string,
    handler: (client: Client, message: unknown) => void | Promise<void>,
  ): () => void
}

export abstract class ShooterRoom extends Room<typeof shooterContract> {
  protected onCreate(): void {
    this.onMessage("playerMove", (client, msg) => {
      expectType<Equal<typeof msg, { x: number; y: number }>>()

      this.send(client, "gameStart", { level: 1, players: [] })
      this.broadcast("playerDied", { sessionId: client.sessionId })
      this.broadcast("playerDied", { sessionId: "a" }, client)

      // @ts-expect-error — unknown message name (case matters)
      this.send(client, "gamestart", { level: 1, players: [] })
      // @ts-expect-error — wrong payload: `id` instead of `sessionId`
      this.broadcast("playerDied", { id: "x" })
      // @ts-expect-error — missing required field
      this.send(client, "gameStart", { level: 1 })
      // @ts-expect-error — wrong field type
      this.send(client, "gameStart", { level: "1", players: [] })
      // @ts-expect-error — wrong element type
      this.send(client, "gameStart", { level: 1, players: [1] })
      // @ts-expect-error — excess property
      this.send(client, "gameStart", { level: 1, players: [], extra: true })
      // @ts-expect-error — client→server messages are not sendable by server
      this.send(client, "playerMove", { x: 1, y: 2 })
    })

    this.onMessage("shoot", (_client, msg) => {
      expectType<Equal<typeof msg, { angle: number }>>()
      // @ts-expect-error — no such field on the payload
      msg.x
    })

    // @ts-expect-error — the server does not receive its own messages
    this.onMessage("gameStart", () => {})
    // @ts-expect-error — unknown message name
    this.onMessage("nope", () => {})

    // Untyped escape hatch stays available and honest about `unknown`.
    this.sendRaw({ sessionId: "s" }, "anything", { whatever: 1 })
    this.onMessageRaw("anything", (_client, msg) => {
      expectType<Equal<typeof msg, unknown>>()
    })
  }
}

// A room without a contract compiles, but has no typed messages.
export abstract class UntypedRoom extends Room {
  protected onCreate(): void {
    // @ts-expect-error — EmptyContract declares no messages
    this.send({ sessionId: "s" }, "anything", {})
    // @ts-expect-error — EmptyContract declares no messages
    this.onMessage("anything", () => {})
    this.sendRaw({ sessionId: "s" }, "anything", {})
  }
}

// --- Client side: spec §7.2 signatures (direction inverted) ------------------

interface IRoom<C extends Contract = EmptyContract> {
  send<K extends keyof RecvMap<C>>(type: K, message: Infer<RecvMap<C>[K]>): void
  onMessage<K extends keyof SendMap<C>>(
    type: K,
    cb: (message: Infer<SendMap<C>[K]>) => void,
  ): () => void
}

export function clientSide(room: IRoom<typeof shooterContract>): void {
  room.send("playerMove", { x: 10, y: 20 })
  room.onMessage("gameStart", (msg) => {
    expectType<Equal<typeof msg, { level: number; players: string[] }>>()
  })

  // @ts-expect-error — clients cannot send server→client messages
  room.send("gameStart", { level: 1, players: [] })
  // @ts-expect-error — wrong payload shape
  room.send("playerMove", { x: 10 })
  // @ts-expect-error — clients do not receive client→server messages
  room.onMessage("playerMove", () => {})
}
