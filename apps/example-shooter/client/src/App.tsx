import type { ClientError } from "@bungohan/client-js"
import { useBungohan, useRoom } from "@bungohan/client-js/react"
import {
  type CreateShooterOptions,
  ROOM_TYPE,
} from "@bungohan/example-shooter-shared"
import type { Result } from "@bungohan/result"
import { LeaveCode } from "@bungohan/types"
import { useEffect, useState } from "react"
import { GameSession } from "./components/GameSession"
import { LobbyScene } from "./components/LobbyScene"
import { type GameRoom, lobbyJoin, shooterJoin } from "./rooms"

/** Retrying remounts the session, which joins the lobby again. */
export function App() {
  const [attempt, setAttempt] = useState(0)
  return (
    <Session key={attempt} onRetry={() => setAttempt((count) => count + 1)} />
  )
}

function Session({ onRetry }: { onRetry: () => void }) {
  const client = useBungohan()
  // The lobby stays joined for the whole session, games included.
  const lobby = useRoom(ROOM_TYPE.LOBBY, undefined, "joinOrCreate", lobbyJoin)
  const [game, setGame] = useState<GameRoom>()
  const [joining, setJoining] = useState(false)
  const [notice, setNotice] = useState<string>()

  // A game the server ended (kicked, disposed, reconnection given up)
  // sends the player back to the lobby.
  useEffect(() => {
    if (game === undefined) return undefined
    return game.onLeave((code) => {
      if (code !== LeaveCode.CONSENTED) {
        setNotice(`You were removed from the game (code ${code}).`)
      }
      setGame(undefined)
    })
  }, [game])

  const enter = async (join: Promise<Result<GameRoom, ClientError>>) => {
    setNotice(undefined)
    setJoining(true)
    const joined = await join
    setJoining(false)
    if (joined.isErr()) setNotice(describeJoinError(joined.error))
    else setGame(joined.value)
  }

  const createGame = (options: CreateShooterOptions) =>
    enter(client.create(ROOM_TYPE.SHOOTER, options, shooterJoin))

  const joinGame = (roomId: string, playerName: string) =>
    enter(client.joinById(roomId, { playerName }, shooterJoin))

  const leaveGame = async () => {
    await game?.leave()
    setGame(undefined)
    lobby.room?.send("refreshRooms", {})
  }

  if (lobby.status === "connecting") return <Connecting />
  if (lobby.room === undefined) {
    const reason =
      lobby.status === "left"
        ? `The server closed the lobby (code ${lobby.leaveCode}).`
        : (lobby.error?.message ?? "Failed to reach the game server.")
    return <ConnectionError reason={reason} onRetry={onRetry} />
  }
  if (game !== undefined) {
    return <GameSession room={game} onLeave={leaveGame} />
  }
  return (
    <LobbyScene
      lobby={lobby.room}
      busy={joining}
      notice={notice}
      onDismissNotice={() => setNotice(undefined)}
      onCreateRoom={createGame}
      onJoinRoom={joinGame}
    />
  )
}

function describeJoinError(error: ClientError): string {
  switch (error.code) {
    case "ROOM_FULL":
      return "That room is full."
    case "ROOM_LOCKED":
      return "That game has already started."
    case "ROOM_NOT_FOUND":
      return "That room no longer exists."
    default:
      return `Could not join: ${error.message}`
  }
}

function Connecting() {
  return (
    <div className="min-h-screen bg-linear-to-br from-slate-900 via-purple-900 to-slate-900 flex items-center justify-center">
      <div className="text-center">
        <div className="text-6xl mb-4 animate-pulse">🎮</div>
        <h1 className="text-4xl font-bold text-white mb-2">Connecting...</h1>
        <p className="text-purple-300">
          Establishing connection to game server
        </p>
      </div>
    </div>
  )
}

function ConnectionError(props: { reason: string; onRetry: () => void }) {
  return (
    <div className="min-h-screen bg-linear-to-br from-slate-900 via-red-900 to-slate-900 flex items-center justify-center">
      <div className="max-w-md bg-slate-800 rounded-xl p-8 border border-red-700 text-center">
        <div className="text-6xl mb-4">❌</div>
        <h1 className="text-3xl font-bold text-white mb-4">Connection Error</h1>
        <p className="text-red-300 mb-6">{props.reason}</p>
        <button
          type="button"
          onClick={props.onRetry}
          className="px-6 py-3 bg-red-600 text-white font-bold rounded-lg hover:bg-red-700 transition-all"
        >
          Retry Connection
        </button>
      </div>
    </div>
  )
}
