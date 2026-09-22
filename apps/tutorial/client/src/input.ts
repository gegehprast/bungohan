// #region input
export interface Direction {
  dx: number
  dy: number
}

const KEYS: Record<string, Direction> = {
  ArrowUp: { dx: 0, dy: -1 },
  ArrowDown: { dx: 0, dy: 1 },
  ArrowLeft: { dx: -1, dy: 0 },
  ArrowRight: { dx: 1, dy: 0 },
  w: { dx: 0, dy: -1 },
  s: { dx: 0, dy: 1 },
  a: { dx: -1, dy: 0 },
  d: { dx: 1, dy: 0 },
}

/** The direction a set of held keys points in (each axis -1, 0 or 1). */
export function directionOf(held: Iterable<string>): Direction {
  let dx = 0
  let dy = 0
  for (const key of held) {
    dx += KEYS[key]?.dx ?? 0
    dy += KEYS[key]?.dy ?? 0
  }
  return { dx: Math.sign(dx), dy: Math.sign(dy) }
}

/**
 * Calls `onChange` whenever the held keys point somewhere new, and only
 * then: sending on every keydown repeat would waste bandwidth.
 */
export function watchKeys(onChange: (direction: Direction) => void) {
  const held = new Set<string>()
  let last: Direction = { dx: 0, dy: 0 }
  const update = () => {
    const next = directionOf(held)
    if (next.dx === last.dx && next.dy === last.dy) return
    last = next
    onChange(next)
  }
  const down = (event: KeyboardEvent) => {
    held.add(event.key)
    update()
  }
  const up = (event: KeyboardEvent) => {
    held.delete(event.key)
    update()
  }
  window.addEventListener("keydown", down)
  window.addEventListener("keyup", up)
  return () => {
    window.removeEventListener("keydown", down)
    window.removeEventListener("keyup", up)
  }
}
// #endregion input
