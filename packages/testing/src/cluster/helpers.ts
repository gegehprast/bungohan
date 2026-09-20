import type { BungohanClient, IRoom } from "@bungohan/client-js"
import type { Room } from "@bungohan/core"
import { GameRoom, GameState, gameContract } from "../core/fixtures"

export type GameRoomView = IRoom<GameState, typeof gameContract>

export const game = { state: GameState, contract: gameContract } as const

export function joinOrCreate(
  client: BungohanClient,
  type = "game",
  options: Record<string, unknown> = {},
) {
  return client.joinOrCreate(type, options, game)
}

/** The server-side `GameRoom` behind an id, on the process that owns it. */
export function gameRoomOf(room: Room | undefined): GameRoom {
  if (!(room instanceof GameRoom)) throw new Error("not a local GameRoom")
  return room
}
