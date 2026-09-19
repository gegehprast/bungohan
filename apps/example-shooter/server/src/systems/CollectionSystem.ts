import { GAME_CONFIG } from "@bungohan/example-shooter-shared"
import { distance } from "../utils/physics"
import type { World } from "./world"

/** Players pick up loot they touch; uncollected loot expires. */
export class CollectionSystem {
  public update({ state, now }: World): void {
    for (const player of state.players.values()) {
      if (player.isDead.get()) continue
      const at = { x: player.x.get(), y: player.y.get() }
      for (const [lootId, loot] of state.loot) {
        const reach = distance(at, { x: loot.x.get(), y: loot.y.get() })
        if (reach < GAME_CONFIG.LOOT_COLLECTION_RADIUS) {
          player.score.set(player.score.get() + loot.value.get())
          state.loot.delete(lootId)
        }
      }
    }

    for (const [lootId, loot] of state.loot) {
      if (now - loot.spawnedAt >= GAME_CONFIG.LOOT_LIFETIME_MS) {
        state.loot.delete(lootId)
      }
    }
  }
}
