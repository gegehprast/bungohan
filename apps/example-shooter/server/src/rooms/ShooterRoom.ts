import {
  type Client,
  Room,
  type RoomOnCreateOptions,
  type TimerId,
} from "@bungohan/core"
import {
  GAME_CONFIG,
  type GameResult,
  GameState,
  type JoinShooterOptions,
  Player,
  type PlayerInput,
  type ShooterListing,
  type ShooterSettings,
  shooterContract,
} from "@bungohan/example-shooter-shared"
import { CollectionSystem } from "../systems/CollectionSystem"
import { CombatSystem } from "../systems/CombatSystem"
import { MovementSystem } from "../systems/MovementSystem"
import { SpawnSystem } from "../systems/SpawnSystem"
import type { World } from "../systems/world"
import { playerName, roomSettings } from "../utils/options"
import { generateRoomCode } from "../utils/roomCodes"

/**
 * One game: a waiting room with a ready check, a timed round, then the
 * results, then back to waiting.
 */
export class ShooterRoom extends Room<GameState, typeof shooterContract> {
  public static override contract = shooterContract
  protected override state = new GameState()

  private readonly inputs = new Map<string, PlayerInput>()
  private readonly movement = new MovementSystem()
  private readonly combat = new CombatSystem()
  private readonly spawn = new SpawnSystem()
  private readonly collection = new CollectionSystem()
  private elapsedMs = 0
  private lastEntityId = 0
  private autoStartTimer: TimerId | undefined
  private resetTimer: TimerId | undefined

  protected override async onCreate(
    options: RoomOnCreateOptions & ShooterSettings,
  ): Promise<void> {
    const { roomName, maxPlayers, isPrivate } = roomSettings(options)
    this.state.roomName.set(roomName)
    this.state.roomCode.set(generateRoomCode())
    this.state.maxPlayers.set(maxPlayers)
    this.maxClients = maxPlayers
    if (isPrivate) this.makePrivate()
    this.setSimulationTickRate(GAME_CONFIG.SIMULATION_TICK_RATE)
    this.setStateSyncTickRate(GAME_CONFIG.STATE_SYNC_RATE)

    this.onMessage("input", (client, input) => {
      this.inputs.set(client.sessionId, input)
    })

    this.onMessage("ready", (client, { isReady }) => {
      if (this.state.gameStatus.get() !== "waiting") return
      this.state.players.get(client.sessionId)?.isReady.set(isReady)
      this.updateCanStart()
    })

    this.onMessage("startGame", (client) => {
      const isHost = client.sessionId === this.state.hostId.get()
      if (isHost && this.state.canStart.get()) this.startGame()
    })

    this.publishListing()
  }

  protected override async onJoin(
    client: Client,
    options: JoinShooterOptions,
  ): Promise<void> {
    const { players } = this.state
    const name = playerName(options.playerName, `Player${players.size + 1}`)
    if (players.size === 0) this.state.hostId.set(client.sessionId)

    const player = new Player()
    player.name.set(name)
    player.color.set(this.freeColor())
    player.health.set(GAME_CONFIG.PLAYER_MAX_HEALTH)
    placeAtRandom(player)
    players.set(client.sessionId, player)

    this.broadcast("playerJoined", {
      playerId: client.sessionId,
      playerName: name,
    })

    if (players.size >= this.maxClients) this.scheduleAutoStart()
    this.updateCanStart()
    this.publishListing()
  }

  protected override async onLeave(client: Client): Promise<void> {
    const id = client.sessionId
    const { players } = this.state
    this.inputs.delete(id)
    if (!players.delete(id)) return

    this.broadcast("playerLeft", { playerId: id })

    if (id === this.state.hostId.get()) {
      const [nextHost] = players.keys()
      this.state.hostId.set(nextHost ?? "")
    }
    if (
      this.state.gameStatus.get() === "playing" &&
      players.size < GAME_CONFIG.MIN_PLAYERS
    ) {
      this.endGame()
    }
    if (players.size < this.maxClients) this.cancelAutoStart()
    this.updateCanStart()
    this.publishListing()
  }

  /**
   * The player's connection dropped; their seat is held for reconnection.
   * Drop their last input, or they'd keep running and shooting meanwhile.
   */
  protected override onDisconnect(client: Client): void {
    this.inputs.delete(client.sessionId)
  }

  protected override onTick(deltaTime: number): void {
    const { state } = this
    if (state.gameStatus.get() !== "playing") return

    this.elapsedMs += deltaTime
    state.gameTime.set(Math.floor(this.elapsedMs / 1000))

    const world: World = {
      state,
      now: this.clock.now(),
      dt: deltaTime,
      inputs: this.inputs,
      nextId: () => ++this.lastEntityId,
    }
    this.movement.update(world)
    this.spawn.update(world)
    this.combat.update(world)
    this.collection.update(world)

    const timeUp = this.elapsedMs >= GAME_CONFIG.GAME_DURATION_S * 1000
    const winner = [...state.players.values()].some(
      (p) => p.score.get() >= GAME_CONFIG.WIN_SCORE,
    )
    if (timeUp || winner) this.endGame()
  }

  protected override async onDispose(): Promise<void> {
    this.cancelAutoStart()
    if (this.resetTimer !== undefined) this.clock.clearTimeout(this.resetTimer)
  }

  private startGame(): void {
    const { state } = this
    this.cancelAutoStart()
    this.lock()
    state.gameStatus.set("playing")
    state.gameTime.set(0)
    state.enemies.clear()
    state.bullets.clear()
    state.loot.clear()
    this.elapsedMs = 0
    this.lastEntityId = 0
    this.spawn.reset()

    for (const player of state.players.values()) {
      placeAtRandom(player)
      player.rotation.set(0)
      player.score.set(0)
      player.health.set(GAME_CONFIG.PLAYER_MAX_HEALTH)
      player.isDead.set(false)
      player.lastShotAt = Number.NEGATIVE_INFINITY
    }

    this.updateCanStart()
    this.broadcast("gameStarted", {})
    this.publishListing()
  }

  private endGame(): void {
    this.state.gameStatus.set("finished")

    const results: GameResult[] = [...this.state.players]
      .map(([playerId, p]) => ({
        playerId,
        playerName: p.name.get(),
        score: p.score.get(),
        color: p.color.get(),
        rank: 0,
      }))
      .sort((a, b) => b.score - a.score)
      .map((result, i) => ({ ...result, rank: i + 1 }))
    this.broadcast("gameEnded", { results })

    this.resetTimer = this.clock.setTimeout(() => {
      this.resetTimer = undefined
      this.resetToWaiting()
    }, GAME_CONFIG.RESULTS_DURATION_MS)
    this.publishListing()
  }

  private resetToWaiting(): void {
    const { state } = this
    state.gameStatus.set("waiting")
    state.gameTime.set(0)
    state.enemies.clear()
    state.bullets.clear()
    state.loot.clear()
    for (const player of state.players.values()) player.isReady.set(false)
    this.unlock()
    this.updateCanStart()
    this.publishListing()
  }

  private updateCanStart(): void {
    const players = [...this.state.players.values()]
    this.state.canStart.set(
      this.state.gameStatus.get() === "waiting" &&
        players.length >= GAME_CONFIG.MIN_PLAYERS &&
        players.every((p) => p.isReady.get()),
    )
  }

  /** A full room starts on its own after a countdown, ready or not. */
  private scheduleAutoStart(): void {
    if (this.autoStartTimer !== undefined) return
    if (this.state.gameStatus.get() !== "waiting") return
    this.autoStartTimer = this.clock.setTimeout(() => {
      this.autoStartTimer = undefined
      if (this.state.gameStatus.get() === "waiting") this.startGame()
    }, GAME_CONFIG.AUTO_START_DELAY_MS)
  }

  private cancelAutoStart(): void {
    if (this.autoStartTimer === undefined) return
    this.clock.clearTimeout(this.autoStartTimer)
    this.autoStartTimer = undefined
  }

  /** The first palette color nobody in the room has. */
  private freeColor(): string {
    const taken = new Set<string>()
    for (const player of this.state.players.values()) {
      taken.add(player.color.get())
    }
    const palette = GAME_CONFIG.PLAYER_COLORS
    return (
      palette.find((color) => !taken.has(color)) ??
      palette[this.state.players.size % palette.length] ??
      palette[0]
    )
  }

  /** What the lobby lists (it can't read this room's state). */
  private publishListing(): void {
    const { state } = this
    const host = state.players.get(state.hostId.get())
    const listing: ShooterListing = {
      name: state.roomName.get(),
      code: state.roomCode.get(),
      hostName: host?.name.get() ?? "",
      status: state.gameStatus.get(),
    }
    Object.assign(this.metadata, listing)
  }
}

function placeAtRandom(player: Player): void {
  player.x.set(Math.random() * GAME_CONFIG.ARENA_WIDTH)
  player.y.set(Math.random() * GAME_CONFIG.ARENA_HEIGHT)
}
