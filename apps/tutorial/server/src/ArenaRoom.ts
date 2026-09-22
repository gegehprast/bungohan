// #region imports
import { type Client, Room, type RoomOnCreateOptions } from "@bungohan/core"
import {
  ARENA,
  type ArenaCreateOptions,
  type ArenaJoinOptions,
  ArenaState,
  arenaContract,
  Gem,
  Player,
} from "@bungohan/tutorial-shared"

// #endregion imports

interface Direction {
  dx: number
  dy: number
}

// #region class
export class ArenaRoom extends Room<ArenaState, typeof arenaContract> {
  // The contract, again, as a value: the type parameter is erased at
  // runtime, and the server needs the descriptors to decode messages.
  public static override contract = arenaContract
  // The synchronized state. Tests read it with the harness's `stateOf`.
  protected override state = new ArenaState()

  // Server-only bookkeeping: plain fields, never sent to anyone.
  private readonly directions = new Map<string, Direction>()
  private gemCount = 5
  private nextGemId = 0
  // #endregion class

  // #region on-create
  protected override async onCreate(
    options: RoomOnCreateOptions & ArenaCreateOptions,
  ): Promise<void> {
    // The type guarantees a uint8; how many gems make sense is game logic.
    this.gemCount = Math.min(Math.max(options.gems, 1), 20)
    for (let i = 0; i < this.gemCount; i++) this.spawnGem()

    this.onMessage("move", (client, { dx, dy }) => {
      // An int8 can be anything from -128 to 127: keep only the sign.
      this.directions.set(client.sessionId, {
        dx: Math.sign(dx),
        dy: Math.sign(dy),
      })
    })
  }
  // #endregion on-create

  // #region on-join
  protected override async onJoin(
    client: Client,
    options: ArenaJoinOptions,
  ): Promise<void> {
    const player = new Player()
    player.name.set(options.name.trim().slice(0, 16) || "Anonymous")
    player.x.set(Math.random() * ARENA.WIDTH)
    player.y.set(Math.random() * ARENA.HEIGHT)
    this.state.players.set(client.sessionId, player)
  }

  protected override async onLeave(client: Client): Promise<void> {
    this.state.players.delete(client.sessionId)
    this.directions.delete(client.sessionId)
  }

  /** The connection dropped; the seat is held for 30 s by default. */
  protected override onDisconnect(client: Client): void {
    // Stop them walking while they're away.
    this.directions.delete(client.sessionId)
  }
  // #endregion on-join

  // #region on-tick
  protected override onTick(deltaTime: number): void {
    const step = (ARENA.PLAYER_SPEED * deltaTime) / 1000
    for (const [sessionId, player] of this.state.players) {
      const direction = this.directions.get(sessionId)
      if (direction === undefined) continue
      player.x.set(clamp(player.x.get() + direction.dx * step, ARENA.WIDTH))
      player.y.set(clamp(player.y.get() + direction.dy * step, ARENA.HEIGHT))
      this.collectGems(sessionId, player)
    }
  }

  private collectGems(sessionId: string, player: Player): void {
    for (const [id, gem] of this.state.gems) {
      const distance = Math.hypot(
        gem.x.get() - player.x.get(),
        gem.y.get() - player.y.get(),
      )
      if (distance > ARENA.PICKUP_RADIUS) continue
      this.state.gems.delete(id)
      this.spawnGem()
      player.score.set(player.score.get() + 1)
      this.broadcast("gemCollected", { sessionId, score: player.score.get() })
    }
  }

  private spawnGem(): void {
    const gem = new Gem()
    gem.x.set(Math.random() * ARENA.WIDTH)
    gem.y.set(Math.random() * ARENA.HEIGHT)
    this.state.gems.set(this.nextGemId++, gem)
  }
}

function clamp(value: number, max: number): number {
  return Math.min(Math.max(value, 0), max)
}
// #endregion on-tick
