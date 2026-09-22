import type { IBungohanClient } from "@bungohan/client-js"
import type { Reservation } from "@bungohan/types"
import { lobbyContract, MatchState, matchContract } from "./matchmaking"

// #region consume
export async function findMatch(client: IBungohanClient) {
  const joined = await client.joinOrCreate("lobby", undefined, {
    contract: lobbyContract,
  })
  if (joined.isErr()) return joined
  const lobby = joined.value

  const reservation = await new Promise<Reservation>((resolve) => {
    lobby.onMessage("found", resolve)
    lobby.send("find", {})
  })
  // Takes the reserved seat; its options were given when it was reserved.
  return client.consumeReservation(reservation, {
    state: MatchState,
    contract: matchContract,
  })
}
// #endregion consume
