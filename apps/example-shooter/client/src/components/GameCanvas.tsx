import {
  ENEMY_OWNER,
  GAME_CONFIG,
  type GameState,
  type Player,
} from "@bungohan/example-shooter-shared"
import { useEffect, useRef } from "react"
import { useGameInput } from "../hooks/useGameInput"
import type { GameRoom } from "../rooms"

/** Lightens (positive) or darkens (negative) a hex color by `percent`. */
function adjustBrightness(hex: string, percent: number): string {
  const num = Number.parseInt(hex.replace("#", ""), 16)
  const amt = Math.round(2.55 * percent)
  const R = Math.max(0, Math.min(255, (num >> 16) + amt))
  const G = Math.max(0, Math.min(255, ((num >> 8) & 0x00ff) + amt))
  const B = Math.max(0, Math.min(255, (num & 0x0000ff) + amt))
  return `#${(0x1000000 + R * 0x10000 + G * 0x100 + B).toString(16).slice(1)}`
}

/**
 * Draws the replica every animation frame. It reads `room.state` directly
 * rather than through React state: the replica is mutated in place by each
 * state frame, and re-rendering React 30 times a second would buy nothing.
 */
export function GameCanvas({ room }: { room: GameRoom }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  useGameInput(room, canvasRef)

  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext("2d")
    if (canvas == null || ctx == null) return undefined

    const fps = { frames: 0, since: performance.now(), value: 0 }
    const updates = { count: 0, since: performance.now(), perSecond: 0 }
    const offStateChange = room.onStateChange(() => {
      updates.count++
    })

    let frame = 0
    const render = (now: number) => {
      fps.frames++
      if (now - fps.since >= 500) {
        fps.value = Math.round((fps.frames * 1000) / (now - fps.since))
        fps.frames = 0
        fps.since = now
      }
      if (now - updates.since >= 1000) {
        updates.perSecond = Math.round(
          (updates.count * 1000) / (now - updates.since),
        )
        updates.count = 0
        updates.since = now
      }

      drawArena(ctx, canvas, room.state, room.sessionId)

      ctx.textAlign = "left"
      ctx.font = "bold 16px monospace"
      ctx.fillStyle = "#22c55e"
      ctx.fillText(`FPS: ${fps.value}`, 10, 25)
      ctx.fillStyle = "#3b82f6"
      ctx.fillText(`Server: ${updates.perSecond} Hz`, 10, 45)

      frame = requestAnimationFrame(render)
    }
    frame = requestAnimationFrame(render)

    return () => {
      cancelAnimationFrame(frame)
      offStateChange()
    }
  }, [room])

  return (
    <canvas
      ref={canvasRef}
      width={GAME_CONFIG.ARENA_WIDTH}
      height={GAME_CONFIG.ARENA_HEIGHT}
      className="border-4 border-slate-700 rounded-lg shadow-2xl bg-slate-950 max-w-full cursor-crosshair"
    />
  )
}

function drawArena(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  state: Readonly<GameState>,
  sessionId: string,
): void {
  ctx.fillStyle = "#0f172a"
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  ctx.strokeStyle = "#1e293b"
  ctx.lineWidth = 1
  for (let x = 0; x < canvas.width; x += 50) {
    ctx.beginPath()
    ctx.moveTo(x, 0)
    ctx.lineTo(x, canvas.height)
    ctx.stroke()
  }
  for (let y = 0; y < canvas.height; y += 50) {
    ctx.beginPath()
    ctx.moveTo(0, y)
    ctx.lineTo(canvas.width, y)
    ctx.stroke()
  }

  // Loot: yellow squares
  for (const loot of state.loot.values()) {
    const size = GAME_CONFIG.LOOT_SIZE
    ctx.fillStyle = "#fbbf24"
    ctx.fillRect(loot.x.get() - size, loot.y.get() - size, size * 2, size * 2)
    ctx.strokeStyle = "#f59e0b"
    ctx.lineWidth = 2
    ctx.strokeRect(loot.x.get() - size, loot.y.get() - size, size * 2, size * 2)
  }

  // Enemies: orange circles with a health bar
  for (const enemy of state.enemies.values()) {
    const x = enemy.x.get()
    const y = enemy.y.get()
    const r = GAME_CONFIG.ENEMY_SIZE
    ctx.fillStyle = "#fb923c"
    ctx.beginPath()
    ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.fill()
    ctx.strokeStyle = "#ea580c"
    ctx.lineWidth = 2
    ctx.stroke()

    const health = enemy.health.get() / GAME_CONFIG.ENEMY_HEALTH
    ctx.fillStyle = "#22c55e"
    ctx.fillRect(x - r, y - r - 10, 2 * r * health, 3)
    ctx.strokeStyle = "#000"
    ctx.lineWidth = 1
    ctx.strokeRect(x - r, y - r - 10, 2 * r, 3)
  }

  // Bullets: own yellow, enemies' dark red, other players' red
  for (const bullet of state.bullets.values()) {
    const owner = bullet.ownerId.get()
    ctx.fillStyle =
      owner === ENEMY_OWNER
        ? "#dc2626"
        : owner === sessionId
          ? "#fbbf24"
          : "#ef4444"
    ctx.beginPath()
    ctx.arc(bullet.x.get(), bullet.y.get(), 3, 0, Math.PI * 2)
    ctx.fill()
  }

  for (const player of state.players.values()) {
    if (player.isDead.get()) drawTombstone(ctx, player)
    else drawPlayer(ctx, player)
  }
}

function drawPlayer(ctx: CanvasRenderingContext2D, player: Player): void {
  const x = player.x.get()
  const y = player.y.get()
  const color = player.color.get()

  // A triangle pointing where the player aims
  ctx.save()
  ctx.translate(x, y)
  ctx.rotate(player.rotation.get())
  ctx.fillStyle = color
  ctx.beginPath()
  ctx.moveTo(20, 0)
  ctx.lineTo(-15, -12)
  ctx.lineTo(-15, 12)
  ctx.closePath()
  ctx.fill()
  ctx.strokeStyle = adjustBrightness(color, -20)
  ctx.lineWidth = 2
  ctx.stroke()
  ctx.restore()

  ctx.textAlign = "center"
  ctx.fillStyle = "#fff"
  ctx.font = "bold 12px sans-serif"
  ctx.fillText(player.name.get() || "Player", x, y - 30)
  ctx.fillStyle = "#fbbf24"
  ctx.font = "bold 10px sans-serif"
  ctx.fillText(`${player.score.get()}`, x, y - 20)

  const health = player.health.get() / GAME_CONFIG.PLAYER_MAX_HEALTH
  ctx.fillStyle = "#22c55e"
  ctx.fillRect(x - 20, y + 25, 40 * health, 4)
  ctx.strokeStyle = "#000"
  ctx.lineWidth = 1
  ctx.strokeRect(x - 20, y + 25, 40, 4)
}

function drawTombstone(ctx: CanvasRenderingContext2D, player: Player): void {
  const x = player.x.get()
  const y = player.y.get()

  ctx.save()
  ctx.translate(x, y)
  ctx.fillStyle = "#64748b"
  ctx.fillRect(-12, 0, 24, 12)
  ctx.beginPath()
  ctx.arc(0, 0, 12, Math.PI, 0, false)
  ctx.fill()
  ctx.strokeStyle = "#1e293b"
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(0, -8)
  ctx.lineTo(0, 4)
  ctx.stroke()
  ctx.beginPath()
  ctx.moveTo(-5, -2)
  ctx.lineTo(5, -2)
  ctx.stroke()
  ctx.fillStyle = "#1e293b"
  ctx.font = "bold 8px sans-serif"
  ctx.textAlign = "center"
  ctx.fillText("RIP", 0, 2)
  ctx.restore()

  ctx.fillStyle = "#94a3b8"
  ctx.font = "bold 12px sans-serif"
  ctx.textAlign = "center"
  ctx.fillText(player.name.get() || "Player", x, y - 25)
}
