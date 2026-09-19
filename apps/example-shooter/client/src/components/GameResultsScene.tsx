import type { GameResult } from "@bungohan/example-shooter-shared"

interface GameResultsSceneProps {
  results: GameResult[]
  sessionId: string
  onBackToLobby: () => void
}

const MEDALS: Record<number, string> = { 1: "🏆", 2: "🥈", 3: "🥉" }
const RANK_COLORS: Record<number, string> = {
  1: "text-yellow-400",
  2: "text-gray-300",
  3: "text-orange-400",
}

export function GameResultsScene({
  results,
  sessionId,
  onBackToLobby,
}: GameResultsSceneProps) {
  const mine = results.find((r) => r.playerId === sessionId)
  const isWinner = mine?.rank === 1

  return (
    <div className="min-h-screen bg-linear-to-br from-slate-900 via-purple-900 to-slate-900 flex items-center justify-center p-4">
      <div className="max-w-2xl w-full bg-slate-800 rounded-2xl shadow-2xl border-2 border-purple-500 overflow-hidden">
        {/* Header */}
        <div className="bg-linear-to-r from-purple-600 to-pink-600 p-8 text-center">
          <div className="text-6xl mb-4">
            {(mine && MEDALS[mine.rank]) ?? "🎮"}
          </div>
          <h1 className="text-4xl font-bold text-white mb-2">
            {isWinner ? "Victory!" : "Game Over"}
          </h1>
          <p className="text-purple-100 text-lg">
            {isWinner
              ? "You are the champion!"
              : `You placed #${mine?.rank ?? "N/A"}`}
          </p>
        </div>

        {/* Your Score */}
        {mine && (
          <div className="bg-slate-700/50 p-6 border-b border-slate-600 text-center">
            <div className="text-sm text-slate-400 mb-2">Your Score</div>
            <div className="text-5xl font-bold text-yellow-400">
              {mine.score}
            </div>
          </div>
        )}

        {/* Final standings */}
        <div className="p-6">
          <h2 className="text-2xl font-bold text-white mb-4 text-center">
            Final Standings
          </h2>
          <div className="space-y-3">
            {results.map((result) => {
              const isMe = result.playerId === sessionId
              return (
                <div
                  key={result.playerId}
                  className="p-4 rounded-lg flex items-center justify-between bg-slate-700/50"
                  style={{
                    borderWidth: isMe ? "2px" : "1px",
                    borderStyle: "solid",
                    borderColor: result.color,
                    backgroundColor: isMe ? `${result.color}20` : undefined,
                  }}
                >
                  <div className="flex items-center gap-4">
                    <div
                      className={`text-3xl font-bold ${
                        RANK_COLORS[result.rank] ?? "text-slate-400"
                      }`}
                    >
                      #{result.rank}
                    </div>
                    <div className="text-white font-semibold text-lg">
                      {result.playerName}
                      {isMe && (
                        <span
                          className="ml-2 text-sm"
                          style={{ color: result.color }}
                        >
                          (You)
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="text-2xl font-bold text-yellow-400">
                    {result.score}
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        <div className="p-6 bg-slate-700/30 border-t border-slate-600 flex justify-center gap-4">
          <button
            type="button"
            onClick={onBackToLobby}
            className="px-8 py-3 bg-purple-600 text-white font-bold rounded-lg hover:bg-purple-700 transition-all shadow-lg"
          >
            Back to Lobby
          </button>
        </div>
      </div>
    </div>
  )
}
