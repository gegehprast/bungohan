import type { BungohanServer, Room } from "@bungohan/core"
import { GAME_CONFIG, ROOM_TYPE } from "@bungohan/example-shooter-shared"
import { LobbyRoom } from "./rooms/LobbyRoom"
import { ShooterRoom } from "./rooms/ShooterRoom"

/**
 * Tick rates are server-wide: a room's `setSimulationTickRate()` and
 * `setStateSyncTickRate()` have no effect from `onCreate`, where a room
 * would naturally configure them.
 */
export const TICK_RATES = {
  simulation: { tickRate: GAME_CONFIG.SIMULATION_TICK_RATE },
  sync: { tickRate: GAME_CONFIG.STATE_SYNC_RATE },
}

/**
 * Defines the shooter's room types and wires the server callbacks. Used
 * by `index.ts` and by the tests, so both run the same setup.
 */
export function setupShooterServer(
  server: BungohanServer,
  { log = true }: { log?: boolean } = {},
): void {
  server.defineRoomType(ROOM_TYPE.LOBBY, LobbyRoom, {
    maxClients: 100,
    autoDispose: false,
    // Nothing in the lobby is worth resuming. Holding seats would also let
    // it pause (every client dropped, seats held), and a paused room stays
    // paused when someone new joins: they'd get no snapshot until the held
    // seats expire.
    allowReconnection: false,
  })
  server.defineRoomType(ROOM_TYPE.SHOOTER, ShooterRoom, {
    maxClients: GAME_CONFIG.MAX_PLAYERS,
    // A dropped player's seat (and character) is held this long.
    reconnectionTimeout: 10,
  })

  /** Shooter rooms changed: have every lobby relist them now. */
  const refreshLobbies = (room: Room): void => {
    if (room.roomType !== ROOM_TYPE.SHOOTER) return
    for (const lobby of server.getMatchMaker().getAllRooms()) {
      if (lobby instanceof LobbyRoom) lobby.refreshRoomList()
    }
  }

  server.onJoin((client, room) => {
    if (log) console.log(`→ ${client.sessionId} joined ${room.roomType}`)
    refreshLobbies(room)
  })

  server.onLeave((client, room, consented) => {
    const how = consented ? "left" : "dropped from"
    if (log) console.log(`← ${client.sessionId} ${how} ${room.roomType}`)
    refreshLobbies(room)
  })

  server.onError((error, context) => {
    const where = context.room ? ` in ${context.room.roomType}` : ""
    console.error(`✖ ${context.source}${where}:`, error)
  })
}
