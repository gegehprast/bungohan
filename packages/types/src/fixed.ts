/**
 * Fixed-point quantization shared by `f.fixed(n)` message fields and
 * `createFixedPoint(n)` state fields. The rules are the portable definition
 * every client implementation (C#, GDScript, …) must reproduce bit-for-bit;
 * see REBUILD_SPEC.md §5.7.6.1.
 */

/** Allowed decimal places. Beyond 9, the int32 range would drop below ±2.1. */
export type FixedDecimals = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9

/** Inclusive bounds of the on-wire integer (signed 32-bit). */
export const FIXED_MIN = -2147483648
export const FIXED_MAX = 2147483647

/** `10 ** n` as exact binary64 values, indexed by decimal places. */
const SCALE = [1, 10, 100, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9] as const

/**
 * Encodes a float as its fixed-point integer:
 * `clamp(roundHalfAwayFromZero(value * 10^decimals), FIXED_MIN, FIXED_MAX)`.
 * NaN encodes as 0; ±Infinity saturates. Never returns -0.
 */
export function toFixed(value: number, decimals: FixedDecimals): number {
  if (Number.isNaN(value)) return 0
  const scaled = value * SCALE[decimals]
  const rounded = scaled < 0 ? -Math.round(-scaled) : Math.round(scaled)
  if (rounded <= FIXED_MIN) return FIXED_MIN
  if (rounded >= FIXED_MAX) return FIXED_MAX
  return rounded === 0 ? 0 : rounded
}

/** Decodes a fixed-point integer. Divides (never multiplies by 0.1^n). */
export function fromFixed(scaled: number, decimals: FixedDecimals): number {
  return scaled / SCALE[decimals]
}

/** Round-trips a float through the wire representation. */
export function quantizeFixed(value: number, decimals: FixedDecimals): number {
  return fromFixed(toFixed(value, decimals), decimals)
}
