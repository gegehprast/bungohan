import { useRoomMessage, useRoomState } from "@bungohan/client-js/react"
import type { CreateShooterOptions } from "@bungohan/example-shooter-shared"
import { useState } from "react"
import type { LobbyRoom } from "../rooms"
import { CreateRoomModal } from "./CreateRoomModal"
import { JoinByCodeModal } from "./JoinByCodeModal"
import { PlayerNameModal } from "./PlayerNameModal"
import { RoomList } from "./RoomList"

interface LobbySceneProps {
  lobby: LobbyRoom
  /** A join is in flight. */
  busy: boolean
  notice: string | undefined
  onDismissNotice: () => void
  onJoinRoom: (roomId: string, playerName: string) => void
  onCreateRoom: (options: CreateShooterOptions) => void
}

type Modal = "create" | "code" | "name"

export function LobbyScene({
  lobby,
  busy,
  notice,
  onDismissNotice,
  onJoinRoom,
  onCreateRoom,
}: LobbySceneProps) {
  // No selector: the list changes rarely, and only when a room does.
  const state = useRoomState(lobby)
  const [modal, setModal] = useState<Modal>()
  const [pendingRoomId, setPendingRoomId] = useState<string>()
  const [error, setError] = useState<string>()

  // Join by code: the lobby resolves the code, then we ask for a name.
  useRoomMessage(lobby, "roomFound", ({ roomId }) => {
    setPendingRoomId(roomId)
    setModal("name")
  })
  useRoomMessage(lobby, "error", ({ message }) => setError(message))

  const pickRoom = (roomId: string) => {
    setPendingRoomId(roomId)
    setModal("name")
  }

  const closeModal = () => {
    setPendingRoomId(undefined)
    setModal(undefined)
  }

  const message = error ?? notice
  const dismiss = () => {
    setError(undefined)
    onDismissNotice()
  }

  return (
    <div className="min-h-screen bg-linear-to-br from-slate-900 via-purple-900 to-slate-900 flex items-center justify-center p-8">
      <div className="max-w-4xl w-full">
        <div className="text-center mb-12">
          <h1 className="text-6xl font-bold text-white mb-4 tracking-tight">
            🎮 Bungohan Shooter
          </h1>
          <p className="text-xl text-purple-200">
            Compete to shoot and loot as many enemies as possible!
          </p>
        </div>

        {message !== undefined && (
          <div className="mb-6 p-4 bg-red-900/40 border border-red-700 rounded-lg flex items-center justify-between text-red-200">
            <span>{message}</span>
            <button
              type="button"
              onClick={dismiss}
              className="ml-4 px-3 py-1 rounded bg-red-800 hover:bg-red-700 text-white"
            >
              Dismiss
            </button>
          </div>
        )}

        <div className="flex gap-4 justify-center mb-8">
          <button
            type="button"
            disabled={busy}
            onClick={() => setModal("create")}
            className="px-8 py-4 bg-linear-to-r from-purple-600 to-pink-600 text-white font-bold text-lg rounded-lg shadow-lg hover:from-purple-700 hover:to-pink-700 transition-all transform hover:scale-105 disabled:opacity-50"
          >
            ➕ Create Room
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => setModal("code")}
            className="px-8 py-4 bg-linear-to-r from-blue-600 to-cyan-600 text-white font-bold text-lg rounded-lg shadow-lg hover:from-blue-700 hover:to-cyan-700 transition-all transform hover:scale-105 disabled:opacity-50"
          >
            🔑 Join by Code
          </button>
          <button
            type="button"
            onClick={() => lobby.send("refreshRooms", {})}
            className="px-8 py-4 bg-slate-700 text-white font-bold text-lg rounded-lg shadow-lg hover:bg-slate-600 transition-all"
          >
            🔄 Refresh
          </button>
        </div>

        <RoomList
          rooms={state === undefined ? [] : [...state.rooms]}
          disabled={busy}
          onJoinRoom={pickRoom}
        />

        {modal === "create" && (
          <CreateRoomModal
            onClose={closeModal}
            onCreate={(options) => {
              closeModal()
              onCreateRoom(options)
            }}
          />
        )}
        {modal === "code" && (
          <JoinByCodeModal
            onClose={closeModal}
            onJoin={(roomCode) => {
              closeModal()
              setError(undefined)
              lobby.send("joinByCode", { roomCode })
            }}
          />
        )}
        {modal === "name" && pendingRoomId !== undefined && (
          <PlayerNameModal
            onCancel={closeModal}
            onConfirm={(playerName) => {
              closeModal()
              onJoinRoom(pendingRoomId, playerName)
            }}
          />
        )}
      </div>
    </div>
  )
}
