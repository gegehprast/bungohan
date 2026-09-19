import { GAME_CONFIG } from "@bungohan/example-shooter-shared"
import { type FormEvent, useState } from "react"

interface PlayerNameModalProps {
  onConfirm: (playerName: string) => void
  onCancel: () => void
}

export function PlayerNameModal({ onConfirm, onCancel }: PlayerNameModalProps) {
  const [playerName, setPlayerName] = useState("")

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault()
    const name = playerName.trim()
    if (name) onConfirm(name)
  }

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-slate-800 rounded-xl p-8 max-w-md w-full border border-slate-700 shadow-2xl">
        <h2 className="text-3xl font-bold text-white mb-6">Enter Your Name</h2>
        <form onSubmit={handleSubmit} className="space-y-6">
          <div>
            <label
              htmlFor="joinPlayerName"
              className="block text-sm font-medium text-slate-300 mb-2"
            >
              Your Name
            </label>
            <input
              id="joinPlayerName"
              type="text"
              placeholder="Enter your name"
              value={playerName}
              maxLength={GAME_CONFIG.MAX_PLAYER_NAME_LENGTH}
              onChange={(e) => setPlayerName(e.target.value)}
              className="w-full px-4 py-3 bg-slate-700 border border-slate-600 rounded-lg text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent transition-all"
            />
          </div>
          <div className="flex gap-3 pt-4">
            <button
              type="button"
              onClick={onCancel}
              className="flex-1 px-4 py-3 bg-slate-700 text-white font-bold rounded-lg hover:bg-slate-600 transition-all"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!playerName.trim()}
              className="flex-1 px-4 py-3 bg-linear-to-r from-purple-600 to-pink-600 text-white font-bold rounded-lg hover:from-purple-700 hover:to-pink-700 transition-all disabled:from-slate-600 disabled:to-slate-600 disabled:cursor-not-allowed"
            >
              Join
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
