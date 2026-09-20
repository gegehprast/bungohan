/**
 * The owner side of a clustered seat (spec §6.4).
 *
 * A room lives on exactly one process. When the client's socket is on
 * another one, the owning process still holds a real `Client` in
 * `room.clients` — it runs `onJoin`, it is counted against `maxClients`, it
 * is passed to `createFiltered` filters, and it gets its own snapshot from
 * the room's single codec session. The only thing that differs is where its
 * frames go: into a `RemoteConnection`, which publishes them to the process
 * that holds the socket instead of handing them to a transport.
 *
 * Because the edge process allocates the `roomRef` **before** forwarding
 * the join, the owner builds every frame with the edge's handle, and the
 * edge relays the bytes unchanged (PROTOCOL.md §3.1: `roomRef` is per
 * connection, and the connection is the edge's).
 */
import type { ConnectionContext } from "@bungohan/transport"
import { Connection } from "../client"

/** A `Connection` that lives on another process. */
export class RemoteConnection extends Connection {
  /** The process that holds the socket. */
  public readonly processId: string
  /** The connection's id *on that process*. */
  public readonly connectionId: string

  public constructor(
    processId: string,
    connectionId: string,
    context: ConnectionContext,
    now: number,
  ) {
    super(`${processId}|${connectionId}`, context, now)
    this.processId = processId
    this.connectionId = connectionId
  }
}

export function isRemoteConnection(
  connection: Connection,
): connection is RemoteConnection {
  return connection instanceof RemoteConnection
}
