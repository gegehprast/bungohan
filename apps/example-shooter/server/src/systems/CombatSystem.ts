import {
  Bullet,
  ENEMY_OWNER,
  type Enemy,
  GAME_CONFIG,
  type GameState,
  Loot,
  type Player,
} from "@bungohan/example-shooter-shared"
import { circleCollision } from "../utils/physics"
import type { World } from "./world"

/** Shooting (players and enemies), bullet flight, hits and kills. */
export class CombatSystem {
  public update(world: World): void {
    for (const [playerId, input] of world.inputs) {
      if (input.shooting) this.tryShoot(world, playerId)
    }
    this.enemiesShoot(world)
    this.moveBullets(world)
    this.resolveHits(world)
  }

  private tryShoot(world: World, playerId: string): void {
    const player = world.state.players.get(playerId)
    if (player === undefined || player.isDead.get()) return
    if (world.now - player.lastShotAt < GAME_CONFIG.PLAYER_FIRE_RATE_MS) return

    const angle = player.rotation.get()
    const { x, y } = player
    this.fire(
      world,
      playerId,
      x.get(),
      y.get(),
      angle,
      GAME_CONFIG.BULLET_SPEED,
    )
    player.lastShotAt = world.now
  }

  private enemiesShoot(world: World): void {
    for (const enemy of world.state.enemies.values()) {
      if (world.now - enemy.lastShotAt < GAME_CONFIG.ENEMY_FIRE_RATE_MS) {
        continue
      }
      for (let i = 0; i < GAME_CONFIG.ENEMY_BULLETS_PER_SHOT; i++) {
        const angle = Math.random() * Math.PI * 2
        const speed = GAME_CONFIG.ENEMY_BULLET_SPEED
        this.fire(
          world,
          ENEMY_OWNER,
          enemy.x.get(),
          enemy.y.get(),
          angle,
          speed,
        )
      }
      enemy.lastShotAt = world.now
    }
  }

  private fire(
    world: World,
    ownerId: string,
    x: number,
    y: number,
    angle: number,
    speed: number,
  ): void {
    const bullet = new Bullet()
    bullet.ownerId.set(ownerId)
    bullet.x.set(x)
    bullet.y.set(y)
    bullet.vx = Math.cos(angle) * speed
    bullet.vy = Math.sin(angle) * speed
    bullet.damage = GAME_CONFIG.BULLET_DAMAGE
    world.state.bullets.set(world.nextId(), bullet)
  }

  private moveBullets({ state, dt }: World): void {
    const seconds = dt / 1000
    for (const [bulletId, bullet] of state.bullets) {
      const x = bullet.x.get() + bullet.vx * seconds
      const y = bullet.y.get() + bullet.vy * seconds
      bullet.ageMs += dt
      if (
        x < 0 ||
        x > GAME_CONFIG.ARENA_WIDTH ||
        y < 0 ||
        y > GAME_CONFIG.ARENA_HEIGHT ||
        bullet.ageMs >= GAME_CONFIG.BULLET_LIFETIME_MS
      ) {
        state.bullets.delete(bulletId)
        continue
      }
      bullet.x.set(x)
      bullet.y.set(y)
    }
  }

  private resolveHits(world: World): void {
    const { state } = world
    for (const [bulletId, bullet] of state.bullets) {
      if (this.hitPlayer(state, bullet) || this.hitEnemy(world, bullet)) {
        state.bullets.delete(bulletId)
      }
    }
  }

  /** Any bullet hurts any living player but its owner. */
  private hitPlayer(state: GameState, bullet: Bullet): boolean {
    const ownerId = bullet.ownerId.get()
    for (const [playerId, player] of state.players) {
      if (player.isDead.get() || playerId === ownerId) continue
      if (!touches(bullet, player, GAME_CONFIG.PLAYER_SIZE)) continue

      player.health.set(Math.max(0, player.health.get() - bullet.damage))
      if (player.health.get() === 0) {
        player.isDead.set(true)
        const shooter = state.players.get(ownerId)
        shooter?.score.set(shooter.score.get() + GAME_CONFIG.PLAYER_KILL_SCORE)
      }
      return true
    }
    return false
  }

  /** Only players' bullets hurt enemies. A kill drops loot. */
  private hitEnemy(world: World, bullet: Bullet): boolean {
    const ownerId = bullet.ownerId.get()
    if (ownerId === ENEMY_OWNER) return false
    const { state } = world
    for (const [enemyId, enemy] of state.enemies) {
      if (!touches(bullet, enemy, GAME_CONFIG.ENEMY_SIZE)) continue

      enemy.health.set(enemy.health.get() - bullet.damage)
      if (enemy.health.get() <= 0) {
        this.dropLoot(world, enemy)
        state.enemies.delete(enemyId)
        const shooter = state.players.get(ownerId)
        shooter?.score.set(shooter.score.get() + GAME_CONFIG.ENEMY_SCORE)
      }
      return true
    }
    return false
  }

  private dropLoot(world: World, enemy: Enemy): void {
    const loot = new Loot()
    loot.x.set(enemy.x.get())
    loot.y.set(enemy.y.get())
    loot.value.set(GAME_CONFIG.LOOT_VALUE)
    loot.spawnedAt = world.now
    world.state.loot.set(world.nextId(), loot)
  }
}

function touches(bullet: Bullet, target: Player | Enemy, radius: number) {
  return circleCollision(
    { x: bullet.x.get(), y: bullet.y.get() },
    GAME_CONFIG.BULLET_SIZE,
    { x: target.x.get(), y: target.y.get() },
    radius,
  )
}
