import { GAME_CONFIG } from "@bungohan/example-shooter-shared"
import { clamp } from "../utils/physics"
import type { World } from "./world"

/** Moves players from their input, and turns them toward their aim. */
export class MovementSystem {
  public update({ state, inputs, dt }: World): void {
    const seconds = dt / 1000
    for (const [playerId, input] of inputs) {
      const player = state.players.get(playerId)
      if (player === undefined || player.isDead.get()) continue

      let dx = 0
      let dy = 0
      if (input.up) dy -= 1
      if (input.down) dy += 1
      if (input.left) dx -= 1
      if (input.right) dx += 1

      const length = Math.hypot(dx, dy)
      if (length > 0) {
        const step = (GAME_CONFIG.PLAYER_SPEED * seconds) / length
        player.x.set(
          clamp(player.x.get() + dx * step, 0, GAME_CONFIG.ARENA_WIDTH),
        )
        player.y.set(
          clamp(player.y.get() + dy * step, 0, GAME_CONFIG.ARENA_HEIGHT),
        )
      }

      // Turn toward the aim by the shortest way, at a limited speed.
      const current = player.rotation.get()
      let diff = input.rotation - current
      while (diff > Math.PI) diff -= 2 * Math.PI
      while (diff < -Math.PI) diff += 2 * Math.PI
      const maxTurn = GAME_CONFIG.PLAYER_ROTATION_SPEED * seconds
      player.rotation.set(
        Math.abs(diff) <= maxTurn
          ? input.rotation
          : current + Math.sign(diff) * maxTurn,
      )
    }
  }
}
