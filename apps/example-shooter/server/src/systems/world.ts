import type { GameState, PlayerInput } from "@bungohan/example-shooter-shared"

/** What every system sees during one simulation step. */
export interface World {
  readonly state: GameState
  /** The room's clock, in ms (driven by the test harness in tests). */
  readonly now: number
  /** Step length in ms. */
  readonly dt: number
  /** Latest input of every connected player, by sessionId. */
  readonly inputs: ReadonlyMap<string, PlayerInput>
  /** A fresh key for `enemies`, `bullets` and `loot`. */
  nextId(): number
}
