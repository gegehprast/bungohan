import { Enemy, GAME_CONFIG } from "@bungohan/example-shooter-shared"
import type { World } from "./world"

/** Spawns enemies at random places, at a fixed rate, up to a cap. */
export class SpawnSystem {
  private lastSpawnAt = Number.NEGATIVE_INFINITY

  public update({ state, now, nextId }: World): void {
    if (state.enemies.size >= GAME_CONFIG.ENEMY_MAX_COUNT) return
    if (now - this.lastSpawnAt < GAME_CONFIG.ENEMY_SPAWN_RATE_MS) return

    const enemy = new Enemy()
    enemy.x.set(Math.random() * GAME_CONFIG.ARENA_WIDTH)
    enemy.y.set(Math.random() * GAME_CONFIG.ARENA_HEIGHT)
    enemy.health.set(GAME_CONFIG.ENEMY_HEALTH)
    enemy.lastShotAt = now
    state.enemies.set(nextId(), enemy)
    this.lastSpawnAt = now
  }

  public reset(): void {
    this.lastSpawnAt = Number.NEGATIVE_INFINITY
  }
}
