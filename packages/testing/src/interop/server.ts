/**
 * The interop server the C# and GDScript test runners talk to over a real
 * WebSocket (`bun run test:csharp`, `bun run test:godot`, via
 * `scripts/interop.ts`).
 *
 * It is a normal Bungohan server — no test hooks on the wire — with three
 * room types:
 *
 * - **`interop`**: the contract and state of `shared.ts`. Every handler is
 *   a pure function of the message, so a run is reproducible byte for
 *   byte. `kickMe` and `dropMe` let a client ask to be kicked or to have
 *   its connection dropped, which is how the reconnection and kick tests
 *   are driven without a second process.
 * - **`compat`**: no contract, one raw handler. The `behavior` conformance
 *   vectors (PROTOCOL.md §14) are defined against exactly this room.
 * - **`solo`**: like `interop` but `maxClients: 1` and no reconnection, so
 *   a client can check that a seat without a token is simply left.
 * - **`options`**: typed join and create options (`optionsContract`), the
 *   room type the `join` conformance vectors target. Private, so a join
 *   that may create always does, and it echoes what its hooks received.
 *
 * Run it standalone with `bun packages/testing/src/interop/server.ts`
 * (`--port`, default 0 = any free port); it prints the port it bound.
 */
import type { Client, RoomOnCreateOptions } from "@bungohan/core"
import { BungohanServer, Room } from "@bungohan/core"
import { WebSocketTransport } from "@bungohan/transport"
import type {
  Infer,
  InferCreateOptions,
  InferJoinOptions,
} from "@bungohan/types"
import {
  type Dump,
  InteropPlayer,
  InteropState,
  interopContract,
  optionsContract,
} from "./shared"

/** How a room reaches the transport to drop a whole connection. */
let transport: WebSocketTransport | undefined

export class InteropRoom extends Room<InteropState, typeof interopContract> {
  public static override contract = interopContract
  public override state = new InteropState()

  protected override async onCreate(): Promise<void> {
    this.state.label.set("interop")
    this.onMessage("move", (client, { dx, dy }) => {
      const player = this.state.players.get(client.sessionId)
      if (player === undefined) return
      player.x.set(player.x.get() + dx)
      player.y.set(player.y.get() + dy)
      this.state.turn.set(this.state.turn.get() + 1)
    })
    this.onMessage("setName", (client, { name }) => {
      this.state.players.get(client.sessionId)?.name.set(name)
      this.state.log.push(`name:${name}`)
    })
    this.onMessage("addTag", (client, { tag }) => {
      this.state.players.get(client.sessionId)?.tags.add(tag)
    })
    this.onMessage("bump", (client, { by, alive, note }) => {
      const player = this.state.players.get(client.sessionId)
      if (player === undefined) return
      player.score.set(player.score.get() + by)
      player.alive.set(alive)
      if (note !== undefined) this.state.log.push(`note:${note}`)
    })
    this.onMessage("echo", (client, { text, count }) => {
      this.send(client, "echoed", {
        text,
        count,
        // An optional the client must see as absent for count 0.
        ...(count === 0 ? {} : { note: `x${count}` }),
      })
    })
    this.onMessage("requestDump", (client) => {
      this.send(client, "dump", this.dump())
    })
    this.onMessage("kickMe", (client, { reason }) => {
      this.disconnectClient(client, 4000, reason)
    })
    this.onMessage("dropMe", (client) => {
      // Not a consented leave and not a room-level LEAVE: the whole
      // connection goes away, which is what a client must reconnect from.
      const id = client.connection?.id
      if (id !== undefined) transport?.disconnect(id, 1001, "dropped")
    })
    this.onMessageRaw("ping", (client, payload) => {
      this.sendRaw(client, "pong", payload)
    })
  }

  protected override async onJoin(client: Client): Promise<void> {
    const player = new InteropPlayer()
    player.name.set(client.sessionId)
    this.state.players.set(client.sessionId, player)
    // Sent from onJoin: it must reach the client after JOIN_SUCCESS.
    this.send(client, "welcome", {
      sessionId: client.sessionId,
      players: Math.min(255, this.state.players.size),
    })
  }

  protected override async onLeave(client: Client): Promise<void> {
    this.state.players.delete(client.sessionId)
  }

  /** The server's own state, in the shape of the `dump` message. */
  private dump(): Infer<typeof Dump> {
    return {
      turn: this.state.turn.get(),
      label: this.state.label.get(),
      log: [...this.state.log.value],
      players: [...this.state.players.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([id, player]) => ({
          id,
          name: player.name.get(),
          x: player.x.get(),
          y: player.y.get(),
          score: player.score.get(),
          alive: player.alive.get(),
          tags: [...player.tags.value].sort(),
        })),
    }
  }
}

/** No contract: the `behavior` vectors' server-side cases target this. */
export class CompatRoom extends Room {
  protected override async onCreate(): Promise<void> {
    this.onMessageRaw("t", () => {})
  }
}

/**
 * Typed options (PROTOCOL.md §6.2.1, §14): sends each joiner, as a raw
 * `"options"` message from `onJoin`, `{ join, create }` — what its hooks
 * received. That is what the `join` vectors read, and the client runners
 * read it through a handler attached after the join resolves (the
 * unclaimed-event rule, spec §7.5).
 */
export class OptionsRoom extends Room<InteropState, typeof optionsContract> {
  public static override contract = optionsContract
  public override state = new InteropState()
  private _created: InferCreateOptions<typeof optionsContract> | undefined

  protected override async onCreate(
    options: RoomOnCreateOptions & InferCreateOptions<typeof optionsContract>,
  ): Promise<void> {
    const { mode, rounds, friendlyFire } = options
    this._created = { mode, rounds, friendlyFire }
  }

  protected override async onJoin(
    client: Client,
    options: InferJoinOptions<typeof optionsContract>,
  ): Promise<void> {
    this.sendRaw(client, "options", {
      join: options,
      create: this._created ?? null,
    })
  }
}

export interface InteropServerOptions {
  /** 0 (the default) binds any free port. */
  port?: number
}

export interface InteropServerHandle {
  readonly server: BungohanServer
  readonly port: number
  readonly url: string
  stop(): Promise<void>
}

/** Starts the interop server and resolves once it is accepting connections. */
export async function startInteropServer(
  options: InteropServerOptions = {},
): Promise<InteropServerHandle> {
  const ws = new WebSocketTransport()
  transport = ws
  const server = new BungohanServer({
    logger: { level: "silent" },
    gracefulShutdown: { handleSignals: false },
    transport: { provider: ws, config: { port: options.port ?? 0 } },
  })
  server.defineRoomType("interop", InteropRoom)
  server.defineRoomType("compat", CompatRoom)
  server.defineRoomType("solo", InteropRoom, {
    maxClients: 1,
    allowReconnection: false,
  })
  server.defineRoomType("options", OptionsRoom, { visibility: "private" })
  ;(await server.start()).unwrap()
  const port = ws.getPort()
  if (port === undefined) throw new Error("the transport did not bind a port")
  return {
    server,
    port,
    url: `ws://127.0.0.1:${port}`,
    async stop(): Promise<void> {
      if (server.isRunning()) await server.stop()
      if (transport === ws) transport = undefined
    },
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2)
  const at = argv.indexOf("--port")
  const port = at < 0 ? 0 : Number(argv[at + 1] ?? 0)
  const handle = await startInteropServer({ port })
  // The runner script reads this line to learn the port.
  console.log(`bungohan-interop-server listening ${handle.port}`)
  const stop = (): void => {
    void handle.stop().then(() => process.exit(0))
  }
  process.on("SIGINT", stop)
  process.on("SIGTERM", stop)
}
