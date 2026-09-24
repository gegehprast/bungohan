import {
  type AuthResult,
  type Client,
  type ConnectionContext,
  createBungohanServer,
  Room,
} from "@bungohan/core"

/**
 * Where one-time login tickets live: your web backend issues them, the
 * game server redeems them. In Redis, `redeem` is `GETDEL ticket:<id>`.
 */
export interface Tickets {
  /** The ticket's user, or undefined if it is unknown or already used. */
  redeem(ticket: string): Promise<string | undefined>
}

// #region authenticate
/** Admits a connection whose `?token=` is an unused ticket, once. */
export function redeemTicket(tickets: Tickets) {
  return async (context: ConnectionContext): Promise<AuthResult> => {
    if (context.token === undefined) return false
    const userId = await tickets.redeem(context.token)
    return userId === undefined ? false : { userId }
  }
}

export function createGameServer(tickets: Tickets) {
  return createBungohanServer({ authenticate: redeemTicket(tickets) })
}
// #endregion authenticate

// #region rooms
/** No `onAuth`: every admitted connection may sit down. */
export class TableRoom extends Room {
  protected override async onJoin(client: Client): Promise<void> {
    // A copy of what authenticate returned.
    console.log(`${String(client.auth["userId"])} sat down`)
  }
}

/** Checks the connection's user without touching the ticket again. */
export class VipRoom extends Room {
  public static vips = new Set(["ada"])

  protected static override async onAuth(client: Client) {
    const userId = client.connection?.auth?.["userId"]
    // true: client.auth becomes a copy of the connection's auth.
    return typeof userId === "string" && VipRoom.vips.has(userId)
  }

  protected override async onAuth(client: Client) {
    return VipRoom.onAuth(client)
  }
}
// #endregion rooms
