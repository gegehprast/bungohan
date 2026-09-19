import { useRoomState } from "@bungohan/client-js/react"
import { GAME_CONFIG } from "@bungohan/example-shooter-shared"
import type { GameRoom } from "../rooms"

interface GameTopProps {
  room: GameRoom
  onLeave: () => void
}

const DEFAULT_COLOR = "#8b5cf6"

export function GameTop({ room, onLeave }: GameTopProps) {
  // Re-renders only when one of these three values changes, not on every
  // position update.
  const [score, color, gameTime] = useRoomState(room, (state) => {
    const me = state.players.get(room.sessionId)
    return [
      me?.score.get() ?? 0,
      me?.color.get() ?? DEFAULT_COLOR,
      state.gameTime.get(),
    ] as const
  }) ?? [0, DEFAULT_COLOR, 0]

  const remaining = Math.max(0, GAME_CONFIG.GAME_DURATION_S - gameTime)
  const minutes = Math.floor(remaining / 60)
  const seconds = Math.floor(remaining % 60)

  return (
    <div className="bg-slate-800 border-b border-slate-700 p-4">
      <div className="max-w-7xl mx-auto flex items-center justify-between">
        <div className="flex items-center gap-6">
          <div>
            <div className="text-sm text-slate-400">Your Score</div>
            <div className="text-3xl font-bold" style={{ color }}>
              {score}
            </div>
          </div>
          <div>
            <div className="text-sm text-slate-400">Time Remaining</div>
            <div className="text-2xl font-bold text-white">
              {minutes}:{seconds.toString().padStart(2, "0")}
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={onLeave}
          className="px-4 py-2 bg-red-600 text-white font-bold rounded-lg hover:bg-red-700 transition-all"
        >
          Leave Game
        </button>
      </div>
    </div>
  )
}
