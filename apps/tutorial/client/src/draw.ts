import { ARENA, type ArenaState } from "@bungohan/tutorial-shared"

/** Draws one frame straight from the replica. */
export function drawArena(
  ctx: CanvasRenderingContext2D,
  state: Readonly<ArenaState>,
  me: string,
): void {
  ctx.fillStyle = "#0f172a"
  ctx.fillRect(0, 0, ARENA.WIDTH, ARENA.HEIGHT)

  ctx.fillStyle = "#facc15"
  for (const gem of state.gems.values()) {
    ctx.beginPath()
    ctx.arc(gem.x.get(), gem.y.get(), 6, 0, Math.PI * 2)
    ctx.fill()
  }

  ctx.font = "12px sans-serif"
  ctx.textAlign = "center"
  for (const [sessionId, player] of state.players) {
    ctx.fillStyle = sessionId === me ? "#38bdf8" : "#f472b6"
    ctx.beginPath()
    ctx.arc(player.x.get(), player.y.get(), 12, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = "#e2e8f0"
    const label = `${player.name.get()} (${player.score.get()})`
    ctx.fillText(label, player.x.get(), player.y.get() - 18)
  }
}
