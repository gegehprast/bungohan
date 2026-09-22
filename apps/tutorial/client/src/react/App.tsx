// #region app
import {
  useRoom,
  useRoomMessage,
  useRoomState,
} from "@bungohan/client-js/react"
import { ARENA, ROOM_TYPE } from "@bungohan/tutorial-shared"
import { useEffect, useRef, useState } from "react"
import { type ArenaRoom, arenaJoin, arenaOptions } from "../arena"
import { drawArena } from "../draw"
import { watchKeys } from "../input"

export function App({ name }: { name: string }) {
  // Joins on mount, leaves on unmount. Options are read once, when the
  // join starts.
  const arena = useRoom(
    ROOM_TYPE,
    arenaOptions(name),
    "joinOrCreate",
    arenaJoin,
  )

  if (arena.status === "connecting") return <p>Connecting…</p>
  if (arena.room === undefined) {
    const why =
      arena.status === "left"
        ? `The server ended the room (code ${arena.leaveCode}).`
        : arena.error?.message
    return <p>Not in the arena: {why}</p>
  }
  return <Game room={arena.room} />
}
// #endregion app

// #region game
interface Score {
  id: string
  name: string
  score: number
}

/** Same rows in the same order: nothing on the scoreboard changed. */
function sameScores(a: Score[], b: Score[]): boolean {
  return (
    a.length === b.length &&
    a.every((row, i) => row.id === b[i]?.id && row.score === b[i]?.score)
  )
}

function Game({ room }: { room: ArenaRoom }) {
  // Re-renders only when a name or score changes, not on every move.
  const scores = useRoomState(
    room,
    (state) =>
      [...state.players]
        .map(([id, p]) => ({ id, name: p.name.get(), score: p.score.get() }))
        .sort((a, b) => b.score - a.score),
    sameScores,
  )
  const [news, setNews] = useState("Collect the gems!")
  useRoomMessage(room, "gemCollected", ({ sessionId, score }) => {
    const who = room.state.players.get(sessionId)?.name.get() ?? sessionId
    setNews(`${who} has ${score} gems`)
  })

  useEffect(
    () => watchKeys((direction) => room.send("move", direction)),
    [room],
  )

  return (
    <div>
      <ArenaCanvas room={room} />
      <p>{news}</p>
      <ol>
        {scores?.map((row) => (
          <li key={row.id}>
            {row.name}: {row.score}
          </li>
        ))}
      </ol>
    </div>
  )
}

/**
 * The canvas draws from the replica every animation frame, outside
 * React's render cycle: positions change far too often to re-render for.
 */
function ArenaCanvas({ room }: { room: ArenaRoom }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const ctx = canvas.current?.getContext("2d")
    if (!ctx) return undefined
    let frame = requestAnimationFrame(function draw() {
      drawArena(ctx, room.state, room.sessionId)
      frame = requestAnimationFrame(draw)
    })
    return () => cancelAnimationFrame(frame)
  }, [room])
  return <canvas ref={canvas} width={ARENA.WIDTH} height={ARENA.HEIGHT} />
}
// #endregion game
