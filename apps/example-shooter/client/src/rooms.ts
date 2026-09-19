import type { IRoom } from "@bungohan/client-js"
import {
  GameState,
  LobbyState,
  lobbyContract,
  shooterContract,
} from "@bungohan/example-shooter-shared"

/**
 * What each join passes to client-js (spec §7.5): the state class builds
 * the replica, the contract types and packs messages. The room types
 * below are what TypeScript infers from them.
 */
export const lobbyJoin = { state: LobbyState, contract: lobbyContract }
export const shooterJoin = { state: GameState, contract: shooterContract }

export type LobbyRoom = IRoom<LobbyState, typeof lobbyContract>
export type GameRoom = IRoom<GameState, typeof shooterContract>
