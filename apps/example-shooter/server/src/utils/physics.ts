export interface Vector2D {
  x: number
  y: number
}

export function distance(a: Vector2D, b: Vector2D): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

export function circleCollision(
  a: Vector2D,
  aRadius: number,
  b: Vector2D,
  bRadius: number,
): boolean {
  return distance(a, b) < aRadius + bRadius
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}
