import type {
  CreateArg,
  InferCreateOptions,
  InferJoinOptions,
} from "@bungohan/schema"
import type { shooterContract } from "./contract"

export type GameStatus = "waiting" | "playing" | "finished"

/**
 * Options of a shooter join (`client.joinById(id, options)`), declared in
 * `shooterContract`: typed on both ends, and decoded against the
 * declaration before the room sees them.
 */
export type JoinShooterOptions = InferJoinOptions<typeof shooterContract>

/** The settings a shooter room is created with. */
export type ShooterSettings = InferCreateOptions<typeof shooterContract>

/**
 * Options of `client.create("shooter", options)`: `{ create, join }`, the
 * room's settings and the creator's own join options.
 */
export type CreateShooterOptions = CreateArg<typeof shooterContract>

/**
 * What a shooter room publishes in its `metadata` for the lobby, which
 * can't read another room's (protected) state.
 */
export interface ShooterListing {
  name: string
  code: string
  hostName: string
  status: GameStatus
}
