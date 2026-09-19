import type { PlayerInput } from "@bungohan/example-shooter-shared"
import { type RefObject, useEffect } from "react"
import type { GameRoom } from "../rooms"

type Direction = "up" | "down" | "left" | "right"

const KEYS: Readonly<Record<string, Direction>> = {
  w: "up",
  arrowup: "up",
  s: "down",
  arrowdown: "down",
  a: "left",
  arrowleft: "left",
  d: "right",
  arrowright: "right",
}

const IDLE: PlayerInput = {
  up: false,
  down: false,
  left: false,
  right: false,
  rotation: 0,
  shooting: false,
}

/** How often controls are checked; input is sent only when it changed. */
const POLL_MS = 1000 / 60

/**
 * Keyboard and mouse → `input` messages. The aim is the angle from the
 * player (as the replica has it) to the mouse. It's rounded to the
 * contract's `f.fixed(2)` before comparing, so a still mouse sends nothing.
 */
export function useGameInput(
  room: GameRoom,
  canvasRef: RefObject<HTMLCanvasElement | null>,
): void {
  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas === null) return undefined

    const held = { up: false, down: false, left: false, right: false }
    const mouse = { x: 0, y: 0, down: false }
    let lastSent = JSON.stringify(IDLE)

    const onKey = (pressed: boolean) => (event: KeyboardEvent) => {
      const direction = KEYS[event.key.toLowerCase()]
      if (direction === undefined) return
      event.preventDefault()
      held[direction] = pressed
    }
    const onKeyDown = onKey(true)
    const onKeyUp = onKey(false)
    const onMouseMove = (event: MouseEvent) => {
      // Canvas pixels, even if CSS scaled the canvas.
      const rect = canvas.getBoundingClientRect()
      mouse.x = ((event.clientX - rect.left) * canvas.width) / rect.width
      mouse.y = ((event.clientY - rect.top) * canvas.height) / rect.height
    }
    const onMouseDown = (event: MouseEvent) => {
      if (event.button !== 0) return
      event.preventDefault()
      mouse.down = true
    }
    const onMouseUp = (event: MouseEvent) => {
      if (event.button === 0) mouse.down = false
    }
    // Keys released while the window is unfocused never send a keyup.
    const onBlur = () => {
      held.up = held.down = held.left = held.right = false
      mouse.down = false
    }

    const send = (input: PlayerInput) => {
      const key = JSON.stringify(input)
      if (key !== lastSent && room.send("input", input).isOk()) lastSent = key
    }

    const poll = () => {
      const me = room.state.players.get(room.sessionId)
      const aim =
        me === undefined
          ? 0
          : Math.atan2(mouse.y - me.y.get(), mouse.x - me.x.get())
      send({
        ...held,
        rotation: Math.round(aim * 100) / 100,
        shooting: mouse.down,
      })
    }

    const timer = window.setInterval(poll, POLL_MS)
    window.addEventListener("keydown", onKeyDown)
    window.addEventListener("keyup", onKeyUp)
    window.addEventListener("mousemove", onMouseMove)
    window.addEventListener("mouseup", onMouseUp)
    window.addEventListener("blur", onBlur)
    canvas.addEventListener("mousedown", onMouseDown)

    return () => {
      window.clearInterval(timer)
      window.removeEventListener("keydown", onKeyDown)
      window.removeEventListener("keyup", onKeyUp)
      window.removeEventListener("mousemove", onMouseMove)
      window.removeEventListener("mouseup", onMouseUp)
      window.removeEventListener("blur", onBlur)
      canvas.removeEventListener("mousedown", onMouseDown)
      // Don't leave the server holding our keys down into the next round.
      if (room.status === "joined") send(IDLE)
    }
  }, [room, canvasRef])
}
