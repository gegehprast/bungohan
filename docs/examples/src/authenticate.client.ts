import {
  type BungohanClient,
  createBungohanClient,
  type TokenProvider,
} from "@bungohan/client-js"

// #region ticket
/** Asks your web backend for a one-time game ticket. */
export const fetchTicket: TokenProvider = async () => {
  const response = await fetch("/api/game-ticket", { method: "POST" })
  return response.ok ? await response.text() : undefined
}

export function connectWithTickets(url: string): BungohanClient {
  // Called before every connection, reconnections included, so each one
  // carries a ticket that hasn't been spent yet.
  return createBungohanClient({ url, token: fetchTicket })
}
// #endregion ticket
