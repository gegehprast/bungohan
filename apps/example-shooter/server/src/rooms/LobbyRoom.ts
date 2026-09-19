import { getMatchMaker, Room } from "@bungohan/core"
import {
  GAME_CONFIG,
  LobbyState,
  lobbyContract,
  ROOM_TYPE,
  RoomInfo,
} from "@bungohan/example-shooter-shared"
import type { TimerId } from "@bungohan/types"
import { parseListing } from "../utils/options"

/**
 * Lists the public shooter rooms and resolves room codes. The list is
 * rebuilt from the matchmaker every second, and at once when someone joins
 * or leaves a shooter room (see `index.ts`). It is updated in place, so an
 * unchanged list costs nothing on the wire.
 */
export class LobbyRoom extends Room<LobbyState, typeof lobbyContract> {
  public static override contract = lobbyContract
  public override state = new LobbyState()

  private refreshTimer: TimerId | undefined

  protected override async onCreate(): Promise<void> {
    this.onMessage("refreshRooms", () => this.refreshRoomList())

    this.onMessage("joinByCode", async (client, { roomCode }) => {
      const code = roomCode.trim().toUpperCase()
      // Private rooms too: a code is how you get into one.
      const found = await getMatchMaker().query({
        type: ROOM_TYPE.SHOOTER,
        metadata: { code },
        includePrivate: true,
        limit: 1,
      })
      const room = found.isOk() ? found.value[0] : undefined
      if (room === undefined) {
        this.send(client, "error", { message: `No room with code ${code}` })
      } else {
        this.send(client, "roomFound", { roomId: room.id })
      }
    })

    this.refreshTimer = this.clock.setInterval(
      () => this.refreshRoomList(),
      GAME_CONFIG.LOBBY_REFRESH_MS,
    )
    this.refreshRoomList()
  }

  protected override async onDispose(): Promise<void> {
    if (this.refreshTimer !== undefined) {
      this.clock.clearInterval(this.refreshTimer)
    }
  }

  public refreshRoomList(): void {
    void this.refresh()
  }

  private async refresh(): Promise<void> {
    const listed = await getMatchMaker().query({ type: ROOM_TYPE.SHOOTER })
    if (listed.isErr() || this.isDisposed) return

    const { rooms } = this.state
    const current = new Set<string>()
    for (const room of listed.value) {
      const listing = parseListing(room.metadata)
      if (listing === undefined || room.clients === 0) continue
      current.add(room.id)

      const info = rooms.get(room.id) ?? new RoomInfo()
      info.name.set(listing.name)
      info.code.set(listing.code)
      info.hostName.set(listing.hostName)
      info.status.set(listing.status)
      info.playerCount.set(room.clients)
      info.maxPlayers.set(room.maxClients)
      rooms.set(room.id, info)
    }
    for (const id of [...rooms.keys()]) {
      if (!current.has(id)) rooms.delete(id)
    }
  }
}
