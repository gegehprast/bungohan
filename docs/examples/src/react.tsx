import type { IRoom } from "@bungohan/client-js"
import {
  useBungohan,
  useRoom,
  useRoomMessage,
  useRoomState,
} from "@bungohan/client-js/react"
import { ArenaState, arenaContract } from "@bungohan/tutorial-shared"
import { useEffect, useState } from "react"

const arena = { state: ArenaState, contract: arenaContract }
type Arena = IRoom<ArenaState, typeof arenaContract>

// #region selectors
export function Hud({ room }: { room: Arena }) {
  // Select plain values; this re-renders only when one of them changes.
  const players = useRoomState(room, (state) => state.players.size)
  const gems = useRoomState(room, (state) => state.gems.size)
  // Arrays of primitives are compared element by element (shallowEqual).
  const names = useRoomState(room, (state) =>
    [...state.players.values()].map((p) => p.name.get()),
  )
  const [last, setLast] = useState<string>()
  useRoomMessage(room, "gemCollected", ({ sessionId }) => setLast(sessionId))

  return (
    <p>
      {players} players ({names?.join(", ")}), {gems} gems, last pickup:{" "}
      {last ?? "none"}
    </p>
  )
}
// #endregion selectors

// #region strict-mode-problem
/**
 * Under <StrictMode>, React mounts, unmounts and mounts again in
 * development, so this creates TWO rooms: the first join's seat is given
 * back, and the empty room disposes itself. Prefer the pattern below.
 */
export function CreateOnMount({ name }: { name: string }) {
  const created = useRoom(
    "arena",
    { create: { gems: 5 }, join: { name } },
    "create",
    arena,
  )
  return <p>{created.status}</p>
}
// #endregion strict-mode-problem

// #region strict-mode-fix
/** Create from an event, not an effect: it runs once, StrictMode or not. */
export function CreateOnClick({ name }: { name: string }) {
  const client = useBungohan()
  const [room, setRoom] = useState<Arena>()
  const [error, setError] = useState<string>()

  const create = async () => {
    const created = await client.create(
      "arena",
      { create: { gems: 5 }, join: { name } },
      arena,
    )
    if (created.isErr()) setError(created.error.message)
    else setRoom(created.value)
  }

  // We own this seat now, so we leave it ourselves.
  useEffect(() => () => void room?.leave(), [room])

  if (room !== undefined) return <Hud room={room} />
  return (
    <button type="button" onClick={create}>
      {error ?? "Create a room"}
    </button>
  )
}
// #endregion strict-mode-fix
