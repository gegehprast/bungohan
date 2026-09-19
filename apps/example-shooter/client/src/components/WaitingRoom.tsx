import { useRoomState } from "@bungohan/client-js/react"
import type { GameRoom } from "../rooms"

interface WaitingRoomProps {
  room: GameRoom
  onLeave: () => void
}

export function WaitingRoom({ room, onLeave }: WaitingRoomProps) {
  // No selector: re-render on every state frame. Nothing moves before the
  // match starts, so frames only come when someone joins or readies up.
  const state = useRoomState(room)
  if (state === undefined) return null

  const players = [...state.players]
  const me = state.players.get(room.sessionId)
  const isReady = me?.isReady.get() ?? false
  const isHost = state.hostId.get() === room.sessionId
  const roomCode = state.roomCode.get()
  const canStart = state.canStart.get()
  const readyCount = players.filter(([, p]) => p.isReady.get()).length
  const finishing = state.gameStatus.get() === "finished"

  const handleCopyCode = () => {
    void navigator.clipboard.writeText(roomCode)
  }

  return (
    <div className="min-h-screen bg-linear-to-br from-slate-900 via-purple-900 to-slate-900 flex items-center justify-center p-8">
      <div className="max-w-2xl w-full">
        {/* Room Code Card */}
        <div className="bg-slate-800/50 backdrop-blur-sm rounded-xl p-8 mb-6 border border-slate-700 text-center">
          <h2 className="text-2xl font-bold text-white mb-1">
            {state.roomName.get()}
          </h2>
          <p className="text-slate-400 mb-4 text-sm">Room Code</p>
          <div className="flex items-center justify-center gap-4">
            <div className="px-8 py-4 bg-slate-700 rounded-lg border-2 border-purple-500">
              <span className="text-4xl font-mono font-bold text-purple-300 tracking-widest">
                {roomCode}
              </span>
            </div>
            <button
              type="button"
              onClick={handleCopyCode}
              className="px-4 py-2 bg-purple-600 text-white font-bold rounded-lg hover:bg-purple-700 transition-all"
              title="Copy code to clipboard"
            >
              📋 Copy
            </button>
          </div>
          <p className="text-slate-400 mt-3 text-sm">
            Share this code with friends to join your room
          </p>
        </div>

        {finishing && (
          <div className="mb-6 p-4 bg-yellow-900/30 border border-yellow-700 rounded-lg text-center text-yellow-200">
            A round is finishing; the room reopens in a few seconds.
          </div>
        )}

        {/* Players List */}
        <div className="bg-slate-800/50 backdrop-blur-sm rounded-xl p-6 mb-6 border border-slate-700">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-2xl font-bold text-white">
              Players ({players.length}/{state.maxPlayers.get()})
            </h2>
            <div className="text-green-400 font-semibold">
              {readyCount} Ready
            </div>
          </div>

          <div className="space-y-2">
            {players.map(([playerId, player]) => {
              const color = player.color.get()
              const ready = player.isReady.get()
              return (
                <div
                  key={playerId}
                  className="bg-slate-700/50 rounded-lg p-4 flex items-center justify-between"
                  style={{
                    borderWidth: "2px",
                    borderStyle: "solid",
                    borderColor: color,
                  }}
                >
                  <div className="flex items-center gap-3">
                    <div
                      className="w-3 h-3 rounded-full"
                      style={{ backgroundColor: ready ? color : "#64748b" }}
                    />
                    <span className="text-white font-semibold">
                      {player.name.get() || "Player"}
                    </span>
                    {playerId === state.hostId.get() && (
                      <span className="px-2 py-1 bg-yellow-600 text-white text-xs font-bold rounded">
                        HOST
                      </span>
                    )}
                    {playerId === room.sessionId && (
                      <span
                        className="px-2 py-1 text-white text-xs font-bold rounded"
                        style={{ backgroundColor: color }}
                      >
                        YOU
                      </span>
                    )}
                  </div>
                  <div className="text-slate-400 text-sm">
                    {ready ? "✓ Ready" : "Waiting..."}
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex gap-4">
          <button
            type="button"
            onClick={onLeave}
            className="flex-1 px-6 py-4 bg-slate-700 text-white font-bold text-lg rounded-lg hover:bg-slate-600 transition-all"
          >
            ← Leave Room
          </button>
          <button
            type="button"
            disabled={finishing}
            onClick={() => room.send("ready", { isReady: !isReady })}
            className={`flex-1 px-6 py-4 font-bold text-lg rounded-lg transition-all text-white disabled:bg-slate-600 disabled:cursor-not-allowed ${
              isReady
                ? "bg-yellow-600 hover:bg-yellow-700"
                : "bg-green-600 hover:bg-green-700"
            }`}
          >
            {isReady ? "⏸ Not Ready" : "✓ Ready"}
          </button>
        </div>

        {isHost && (
          <div className="flex gap-4 mt-4">
            <button
              type="button"
              onClick={() => room.send("startGame", {})}
              disabled={!canStart}
              className="flex-1 px-6 py-4 bg-linear-to-r from-green-600 to-emerald-600 text-white font-bold text-lg rounded-lg hover:from-green-700 hover:to-emerald-700 transition-all disabled:from-slate-600 disabled:to-slate-600 disabled:cursor-not-allowed"
            >
              {canStart ? "🚀 Start Game" : "⏳ Waiting for players..."}
            </button>
          </div>
        )}

        {isHost && players.length < 2 && (
          <div className="mt-4 p-4 bg-blue-900/30 border border-blue-700 rounded-lg text-center">
            <p className="text-blue-300 text-sm">
              💡 Tip: You can start the game alone, or wait for more players to
              join!
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
