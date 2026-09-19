export type GameStatus = "waiting" | "playing" | "finished"

/**
 * Options of a shooter join (`client.joinById(id, options)`). Join options
 * aren't part of the contract, so the server receives them as `unknown`
 * and narrows them itself (server/src/utils/options.ts).
 */
export interface JoinShooterOptions {
  playerName: string
}

/** Options of `client.create("shooter", options)`: the room's, and the creator's join. */
export interface CreateShooterOptions extends JoinShooterOptions {
  roomName?: string
  maxPlayers: number
  isPrivate: boolean
}

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
