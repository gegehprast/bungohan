// #region vanilla
import { createBungohanClient } from "@bungohan/client-js"
import { joinArena } from "./arena"
import { drawArena } from "./draw"
import { watchKeys } from "./input"
import { playerName, SERVER_URL } from "./url"

const canvas = document.querySelector("canvas")
const status = document.querySelector("#status")
const ctx = canvas?.getContext("2d")
if (!ctx || !status) throw new Error("index.html is missing its elements")

const client = createBungohanClient({ url: SERVER_URL })
// Closing the tab is leaving; otherwise the server would hold the seat
// for a reconnection that never comes.
window.addEventListener("pagehide", () => void client.disconnect())

async function main(ctx: CanvasRenderingContext2D, status: Element) {
  // Resolves once the first state snapshot is in: room.state is filled.
  const joined = await joinArena(client, playerName())
  if (joined.isErr()) {
    status.textContent = `Could not join: ${joined.error.message}`
    return
  }
  const room = joined.value
  status.textContent = `Joined room ${room.id}`

  const stopKeys = watchKeys((direction) => room.send("move", direction))

  room.onMessage("gemCollected", ({ sessionId, score }) => {
    const who = room.state.players.get(sessionId)?.name.get() ?? sessionId
    status.textContent = `${who} has ${score} gems`
  })

  room.onLeave((code) => {
    stopKeys()
    status.textContent = `Left the room (code ${code})`
  })

  // Read room.state every frame, not a saved reference: a reconnection
  // replaces the replica with a fresh object.
  const frame = () => {
    drawArena(ctx, room.state, room.sessionId)
    if (room.status !== "left") requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
}

void main(ctx, status)
// #endregion vanilla
