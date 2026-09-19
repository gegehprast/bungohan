import type { GameRoom } from "../rooms"
import { GameCanvas } from "./GameCanvas"
import { GameTop } from "./GameTop"
import { Leaderboard } from "./Leaderboard"

interface GameSceneProps {
  room: GameRoom
  onLeave: () => void
}

export function GameScene({ room, onLeave }: GameSceneProps) {
  return (
    <div className="min-h-screen bg-slate-900 flex flex-col">
      <GameTop room={room} onLeave={onLeave} />
      <div className="flex-1 flex">
        <div className="flex-1 flex items-center justify-center p-4">
          <GameCanvas room={room} />
        </div>
        <Leaderboard room={room} />
      </div>
    </div>
  )
}
