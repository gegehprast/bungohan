/**
 * A small game used by core's end-to-end tests: players with positions, a
 * per-owner secret (filtered), chat, and hooks that can be told to throw.
 */
import { type Client, Room } from "@bungohan/core"
import {
  createFiltered,
  createFixedPoint,
  createNumber,
  createSchemaMap,
  createString,
  Schema,
} from "@bungohan/state"
import { defineContract, defineMessage, f } from "@bungohan/types"

export class Player extends Schema {
  public static override schemaName = "E2E.Player"
  public name = createString()
  public x = createFixedPoint(2)
  public owner = createString()
  public secret = createFiltered(
    createString(),
    function (this: Player, client) {
      return this.owner.get() === client.id
    },
  )
}

export class GameState extends Schema {
  public static override schemaName = "E2E.Game"
  public turn = createNumber()
  public players = createSchemaMap(f.string, Player)
}

export const Move = defineMessage("move", { dx: f.fixed(2) })
export const Say = defineMessage("say", { text: f.string })
export const Boom = defineMessage("boom", {})
export const Welcome = defineMessage("welcome", {
  sessionId: f.string,
  players: f.uint8,
})
export const Said = defineMessage("said", { from: f.string, text: f.string })

export const gameContract = defineContract({
  client: { move: Move, say: Say, boom: Boom },
  server: { welcome: Welcome, said: Said },
})

/** Switches the tests flip to make hooks throw. */
export const faults = {
  onJoin: false,
  onCreate: false,
  onTick: false,
  onLeave: false,
  denyAuth: false,
}

export function resetFaults(): void {
  faults.onJoin = false
  faults.onCreate = false
  faults.onTick = false
  faults.onLeave = false
  faults.denyAuth = false
}

/** Hook calls, in order, for assertions. */
export const calls: string[] = []

export class GameRoom extends Room<GameState, typeof gameContract> {
  public static override contract = gameContract
  public override state = new GameState()

  protected static override async onAuth(): Promise<boolean> {
    calls.push("static onAuth")
    return !faults.denyAuth
  }

  protected override async onAuth(): Promise<boolean> {
    calls.push("onAuth")
    return !faults.denyAuth
  }

  protected override async onCreate(): Promise<void> {
    calls.push("onCreate")
    if (faults.onCreate) throw new Error("onCreate failed")
    this.onMessage("move", (client, { dx }) => {
      const player = this.state.players.get(client.sessionId)
      player?.x.set(player.x.get() + dx)
    })
    this.onMessage("say", (client, { text }) => {
      this.broadcast("said", { from: client.sessionId, text })
    })
    this.onMessage("boom", () => {
      throw new Error("handler exploded")
    })
    this.onMessageRaw("echo", (client, payload) => {
      this.sendRaw(client, "echo", payload)
    })
  }

  protected override async onJoin(client: Client): Promise<void> {
    calls.push(`onJoin ${client.sessionId}`)
    if (faults.onJoin) throw new Error("onJoin failed")
    const player = new Player()
    player.name.set(client.sessionId)
    player.owner.set(client.sessionId)
    player.secret.set(`secret-of-${client.sessionId}`)
    this.state.players.set(client.sessionId, player)
    // Sent during onJoin: must reach the client after JOIN_SUCCESS.
    this.send(client, "welcome", {
      sessionId: client.sessionId,
      players: this.state.players.size,
    })
  }

  protected override async onLeave(
    client: Client,
    consented: boolean,
  ): Promise<void> {
    calls.push(`onLeave ${client.sessionId} ${consented}`)
    this.state.players.delete(client.sessionId)
    if (faults.onLeave) throw new Error("onLeave failed")
  }

  protected override onTick(): void {
    if (faults.onTick) throw new Error("onTick failed")
  }

  protected override onDisconnect(client: Client): void {
    calls.push(`onDisconnect ${client.sessionId}`)
  }

  protected override onReconnect(client: Client): void {
    calls.push(`onReconnect ${client.sessionId}`)
    // Sent from the hook: must reach the client after JOIN_SUCCESS.
    this.send(client, "welcome", {
      sessionId: client.sessionId,
      players: this.state.players.size,
    })
  }

  protected override onPause(): void {
    calls.push("onPause")
  }

  protected override onResume(): void {
    calls.push("onResume")
  }

  protected override async onDispose(): Promise<void> {
    calls.push("onDispose")
  }

  /** Test access to protected state and room APIs. */
  public get game(): GameState {
    return this.state
  }
}
