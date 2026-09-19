/**
 * Integer kinds shared by map keys (`KeyFieldType`) and message fields
 * (`f.int8` … `f.uint32`).
 */
import type { IntKind } from "./contract"

/** Inclusive `[min, max]` of each integer kind. */
export const INT_RANGE: Readonly<Record<IntKind, readonly [number, number]>> = {
  int8: [-128, 127],
  int16: [-32768, 32767],
  int32: [-2147483648, 2147483647],
  uint8: [0, 255],
  uint16: [0, 65535],
  uint32: [0, 4294967295],
}

export function isIntKind(kind: string): kind is IntKind {
  return Object.hasOwn(INT_RANGE, kind)
}

/** True if `value` is an integer inside `kind`'s range. */
export function isIntOf(value: unknown, kind: IntKind): value is number {
  if (typeof value !== "number" || !Number.isInteger(value)) return false
  const [min, max] = INT_RANGE[kind]
  return value >= min && value <= max
}

/**
 * Coerces a number into `kind`, following the fixed-point rules
 * (spec §5.7.6.1): truncate toward zero, saturate at the range, NaN → 0,
 * never -0.
 */
export function toInt(value: number, kind: IntKind): number {
  if (Number.isNaN(value)) return 0
  const [min, max] = INT_RANGE[kind]
  if (value <= min) return min
  if (value >= max) return max
  const truncated = Math.trunc(value)
  return truncated === 0 ? 0 : truncated
}
