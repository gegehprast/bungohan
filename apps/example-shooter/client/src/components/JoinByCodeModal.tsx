import { GAME_CONFIG } from "@bungohan/example-shooter-shared"
import { type ChangeEvent, type FormEvent, useState } from "react"

interface JoinByCodeModalProps {
  onClose: () => void
  onJoin: (roomCode: string) => void
}

const CODE_LENGTH = GAME_CONFIG.ROOM_CODE_LENGTH

export function JoinByCodeModal({ onClose, onJoin }: JoinByCodeModalProps) {
  const [roomCode, setRoomCode] = useState("")

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault()
    if (roomCode.length === CODE_LENGTH) onJoin(roomCode)
  }

  const handleInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    const value = event.target.value.toUpperCase().replace(/[^A-Z2-9]/g, "")
    if (value.length <= CODE_LENGTH) setRoomCode(value)
  }

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-slate-800 rounded-xl p-8 max-w-md w-full border border-slate-700 shadow-2xl">
        <h2 className="text-3xl font-bold text-white mb-6">Join by Code</h2>

        <form onSubmit={handleSubmit} className="space-y-6">
          <div>
            <label
              htmlFor="roomCode"
              className="block text-sm font-medium text-slate-300 mb-2"
            >
              Room Code
            </label>
            <input
              id="roomCode"
              type="text"
              value={roomCode}
              onChange={handleInputChange}
              placeholder="ABC123"
              maxLength={CODE_LENGTH}
              className="w-full px-4 py-3 bg-slate-700 border border-slate-600 rounded-lg text-white text-center text-2xl font-mono uppercase tracking-widest focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <p className="text-xs text-slate-400 mt-1 text-center">
              Enter the {CODE_LENGTH}-character room code
            </p>
          </div>

          <div className="flex gap-3">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-4 py-3 bg-slate-700 text-white font-bold rounded-lg hover:bg-slate-600 transition-all"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={roomCode.length !== CODE_LENGTH}
              className="flex-1 px-4 py-3 bg-linear-to-r from-blue-600 to-cyan-600 text-white font-bold rounded-lg hover:from-blue-700 hover:to-cyan-700 transition-all disabled:from-slate-600 disabled:to-slate-600 disabled:cursor-not-allowed"
            >
              Join
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
