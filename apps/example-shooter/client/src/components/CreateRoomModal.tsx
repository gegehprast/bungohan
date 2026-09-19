import {
  type CreateShooterOptions,
  GAME_CONFIG,
} from "@bungohan/example-shooter-shared"
import { type FormEvent, useState } from "react"

interface CreateRoomModalProps {
  onClose: () => void
  onCreate: (options: CreateShooterOptions) => void
}

export function CreateRoomModal({ onClose, onCreate }: CreateRoomModalProps) {
  const [playerName, setPlayerName] = useState("")
  const [roomName, setRoomName] = useState("")
  const [maxPlayers, setMaxPlayers] = useState(4)
  const [isPrivate, setIsPrivate] = useState(false)

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault()
    const name = playerName.trim()
    if (!name) return
    onCreate({
      playerName: name,
      roomName: roomName.trim() || `${name}'s room`,
      maxPlayers,
      isPrivate,
    })
  }

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-slate-800 rounded-xl p-8 max-w-md w-full border border-slate-700 shadow-2xl">
        <h2 className="text-3xl font-bold text-white mb-6">Create Room</h2>

        <form onSubmit={handleSubmit} className="space-y-6">
          <div>
            <label
              htmlFor="playerName"
              className="block text-sm font-medium text-slate-300 mb-2"
            >
              Your Name
            </label>
            <input
              id="playerName"
              type="text"
              value={playerName}
              onChange={(e) => setPlayerName(e.target.value)}
              placeholder="Enter your name"
              maxLength={GAME_CONFIG.MAX_PLAYER_NAME_LENGTH}
              className="w-full px-4 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-purple-500"
              required
            />
            <p className="text-xs text-slate-400 mt-1">
              This will be shown to other players
            </p>
          </div>

          <div>
            <label
              htmlFor="roomName"
              className="block text-sm font-medium text-slate-300 mb-2"
            >
              Room Name
            </label>
            <input
              id="roomName"
              type="text"
              value={roomName}
              onChange={(e) => setRoomName(e.target.value)}
              placeholder="Optional"
              maxLength={GAME_CONFIG.MAX_ROOM_NAME_LENGTH}
              className="w-full px-4 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-purple-500"
            />
          </div>

          <div>
            <label
              htmlFor="maxPlayers"
              className="block text-sm font-medium text-slate-300 mb-2"
            >
              Max Players
            </label>
            <input
              id="maxPlayers"
              type="number"
              min={1}
              max={GAME_CONFIG.MAX_PLAYERS}
              value={maxPlayers}
              onChange={(e) => setMaxPlayers(Number(e.target.value))}
              className="w-full px-4 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-purple-500"
            />
            <p className="text-xs text-slate-400 mt-1">
              Choose between 1 and {GAME_CONFIG.MAX_PLAYERS} players
            </p>
          </div>

          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={isPrivate}
              onChange={(e) => setIsPrivate(e.target.checked)}
              className="w-5 h-5 rounded border-slate-600 bg-slate-700 text-purple-600 focus:ring-purple-500"
            />
            <span className="text-slate-300 font-medium">
              Private Room (only accessible by room code)
            </span>
          </label>

          <div className="flex gap-3 pt-4">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-4 py-3 bg-slate-700 text-white font-bold rounded-lg hover:bg-slate-600 transition-all"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!playerName.trim()}
              className="flex-1 px-4 py-3 bg-linear-to-r from-purple-600 to-pink-600 text-white font-bold rounded-lg hover:from-purple-700 hover:to-pink-700 transition-all disabled:from-slate-600 disabled:to-slate-600 disabled:cursor-not-allowed"
            >
              Create
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
