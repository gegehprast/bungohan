// #region contract
import {
  defineContract,
  defineMessage,
  f,
  type InferCreateOptions,
  type InferJoinOptions,
} from "@bungohan/client-js"

/** Client → server: which way the player is holding the keys. */
export const Move = defineMessage("move", { dx: f.int8, dy: f.int8 })

/** Server → client: someone picked up a gem. */
export const GemCollected = defineMessage("gemCollected", {
  sessionId: f.string,
  score: f.uint16,
})

export const arenaContract = defineContract({
  client: { move: Move },
  server: { gemCollected: GemCollected },
  options: {
    /** Sent only by the client whose join creates the room. */
    create: defineMessage("arenaCreateOptions", { gems: f.uint8 }),
    /** Sent by every client that joins. */
    join: defineMessage("arenaJoinOptions", { name: f.string }),
  },
})

export type ArenaCreateOptions = InferCreateOptions<typeof arenaContract>
export type ArenaJoinOptions = InferJoinOptions<typeof arenaContract>
// #endregion contract
