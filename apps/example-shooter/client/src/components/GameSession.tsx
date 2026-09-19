import { useRoomMessage, useRoomState } from "@bungohan/client-js/react"
import type { GameResult } from "@bungohan/example-shooter-shared"
import { useState } from "react"
import type { GameRoom } from "../rooms"
import { GameResultsScene } from "./GameResultsScene"
import { GameScene } from "./GameScene"
import { WaitingRoom } from "./WaitingRoom"

interface GameSessionProps {
  room: GameRoom
  onLeave: () => void
}

/** One joined game room: waiting room, match, then results. */
export function GameSession({ room, onLeave }: GameSessionProps) {
  const status = useRoomState(room, (state) => state.gameStatus.get())
  const [results, setResults] = useState<GameResult[]>()

  useRoomMessage(room, "gameStarted", () => setResults(undefined))
  useRoomMessage(room, "gameEnded", (message) => setResults(message.results))
  useRoomMessage(room, "playerJoined", ({ playerName }) => {
    console.info(`👋 ${playerName} joined the room`)
  })
  useRoomMessage(room, "playerLeft", ({ playerId }) => {
    console.info(`👋 ${playerId} left the room`)
  })

  if (results !== undefined) {
    return (
      <GameResultsScene
        results={results}
        sessionId={room.sessionId}
        onBackToLobby={onLeave}
      />
    )
  }
  if (status === "playing") return <GameScene room={room} onLeave={onLeave} />
  return <WaitingRoom room={room} onLeave={onLeave} />
}
