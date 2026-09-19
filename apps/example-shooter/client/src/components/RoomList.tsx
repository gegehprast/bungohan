import type { RoomInfo } from "@bungohan/example-shooter-shared"

interface RoomListProps {
  /** `[roomId, info]` pairs, as the lobby state's map holds them. */
  rooms: ReadonlyArray<readonly [string, RoomInfo]>
  disabled: boolean
  onJoinRoom: (roomId: string) => void
}

export function RoomList({ rooms, disabled, onJoinRoom }: RoomListProps) {
  if (rooms.length === 0) {
    return (
      <div className="bg-slate-800/50 backdrop-blur-sm rounded-xl p-8 text-center border border-slate-700">
        <p className="text-slate-400 text-lg">
          No rooms available. Create one to get started!
        </p>
      </div>
    )
  }

  return (
    <div className="bg-slate-800/50 backdrop-blur-sm rounded-xl p-6 border border-slate-700">
      <h2 className="text-2xl font-bold text-white mb-4">Available Rooms</h2>
      <div className="space-y-3">
        {rooms.map(([roomId, room]) => {
          const status = room.status.get()
          const full = room.playerCount.get() >= room.maxPlayers.get()
          return (
            <div
              key={roomId}
              className="bg-slate-700/50 rounded-lg p-4 flex items-center justify-between hover:bg-slate-700 transition-colors border border-slate-600"
            >
              <div className="flex-1">
                <div className="flex items-center gap-3 mb-2">
                  <span className="text-lg font-bold text-white">
                    {room.name.get()} · {room.code.get()}
                  </span>
                  <span
                    className={`px-2 py-1 rounded text-xs font-semibold text-white ${
                      status === "waiting" ? "bg-green-600" : "bg-yellow-600"
                    }`}
                  >
                    {status.toUpperCase()}
                  </span>
                </div>
                <div className="flex items-center gap-4 text-sm text-slate-300">
                  <span>
                    👥 {room.playerCount.get()}/{room.maxPlayers.get()} players
                  </span>
                  <span className="text-slate-400">
                    Host: {room.hostName.get()}
                  </span>
                </div>
              </div>
              <button
                type="button"
                onClick={() => onJoinRoom(roomId)}
                disabled={disabled || full || status !== "waiting"}
                className="px-6 py-2 bg-linear-to-r from-green-600 to-emerald-600 text-white font-bold rounded-lg hover:from-green-700 hover:to-emerald-700 transition-all disabled:from-slate-600 disabled:to-slate-600 disabled:cursor-not-allowed"
              >
                {full ? "Full" : "Join"}
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
