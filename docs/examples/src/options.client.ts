import type { IBungohanClient } from "@bungohan/client-js"
import { RaceState, raceContract } from "./options"

// #region client
const race = { state: RaceState, contract: raceContract }

/** Creating modes take `{ create, join }`. */
export function hostRace(client: IBungohanClient, driver: string) {
  return client.create(
    "race",
    { create: { track: "oval", laps: 5 }, join: { driver } },
    race,
  )
}

/** Joining modes take the join options alone. */
export function joinRace(client: IBungohanClient, id: string, driver: string) {
  return client.joinById(id, { driver, car: "red" }, race)
}
// #endregion client
