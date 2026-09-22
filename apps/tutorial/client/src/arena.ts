// #region join
import type { IBungohanClient, IRoom } from "@bungohan/client-js"
import { ArenaState, arenaContract, ROOM_TYPE } from "@bungohan/tutorial-shared"

/**
 * What every join passes: the state class (to build the local replica)
 * and the contract (to type and encode messages and options).
 */
export const arenaJoin = { state: ArenaState, contract: arenaContract }

/** The room type TypeScript infers from `arenaJoin`. */
export type ArenaRoom = IRoom<ArenaState, typeof arenaContract>

/** Create options (used only if this join creates the room), then ours. */
export function arenaOptions(name: string) {
  return { create: { gems: 5 }, join: { name } }
}

export function joinArena(client: IBungohanClient, name: string) {
  return client.joinOrCreate(ROOM_TYPE, arenaOptions(name), arenaJoin)
}
// #endregion join
