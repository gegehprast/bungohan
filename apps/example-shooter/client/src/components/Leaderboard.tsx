import { useRoomState } from "@bungohan/client-js/react"
import type { GameState } from "@bungohan/example-shooter-shared"
import type { GameRoom } from "../rooms"

interface Row {
  id: string
  name: string
  score: number
  color: string
}

function selectRows(state: Readonly<GameState>): Row[] {
  return [...state.players]
    .map(([id, player]) => ({
      id,
      name: player.name.get(),
      score: player.score.get(),
      color: player.color.get(),
    }))
    .sort((a, b) => b.score - a.score)
}

/** Rows are fresh objects every frame: compare what they show. */
function sameRows(a: Row[], b: Row[]): boolean {
  return (
    a.length === b.length &&
    a.every((row, i) => {
      const other = b[i]
      return (
        other !== undefined &&
        row.id === other.id &&
        row.name === other.name &&
        row.score === other.score &&
        row.color === other.color
      )
    })
  )
}

export function Leaderboard({ room }: { room: GameRoom }) {
  // Re-renders only when a row changes, not on every position update.
  const rows = useRoomState(room, selectRows, sameRows) ?? []

  return (
    <div className="w-64 bg-slate-800 border-l border-slate-700 p-4">
      <h3 className="text-xl font-bold text-white mb-4">Leaderboard</h3>
      <div className="space-y-2">
        {rows.map((row, index) => {
          const isMe = row.id === room.sessionId
          return (
            <div
              key={row.id}
              className="p-3 rounded-lg bg-slate-700/50"
              style={{
                borderWidth: isMe ? "2px" : "1px",
                borderStyle: "solid",
                borderColor: isMe ? row.color : "transparent",
                backgroundColor: isMe ? `${row.color}20` : undefined,
              }}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-xl font-bold text-slate-400">
                    #{index + 1}
                  </span>
                  <span className="text-white font-semibold truncate">
                    {row.name}
                  </span>
                </div>
                <span className="text-yellow-400 font-bold">{row.score}</span>
              </div>
            </div>
          )
        })}
      </div>

      <div className="mt-6 p-3 bg-slate-700/50 rounded-lg">
        <div className="text-xs text-slate-400 mb-2">Controls</div>
        <div className="text-sm text-white space-y-1">
          <div>WASD / Arrows - Move</div>
          <div>Mouse - Aim</div>
          <div>Click - Shoot</div>
        </div>
      </div>
    </div>
  )
}
