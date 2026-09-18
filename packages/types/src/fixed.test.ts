import { describe, expect, test } from "bun:test"
import {
  FIXED_MAX,
  FIXED_MIN,
  fromFixed,
  quantizeFixed,
  toFixed,
} from "./fixed"

describe("toFixed", () => {
  test("scales and rounds", () => {
    expect(toFixed(145.5, 2)).toBe(14550)
    expect(toFixed(1.234, 2)).toBe(123)
    expect(toFixed(12, 0)).toBe(12)
  })

  test("rounds half away from zero, symmetric for negatives", () => {
    expect(toFixed(2.5, 0)).toBe(3)
    expect(toFixed(-2.5, 0)).toBe(-3) // Math.round(-2.5) would give -2
    expect(toFixed(0.125, 2)).toBe(13)
    expect(toFixed(-0.125, 2)).toBe(-13)
    expect(toFixed(-145.5, 2)).toBe(-14550)
  })

  test("follows binary64 multiplication, like every other runtime", () => {
    // 1.005 * 100 === 100.49999999999999 in IEEE-754, so this rounds down.
    expect(toFixed(1.005, 2)).toBe(100)
  })

  test("saturates at the int32 range", () => {
    expect(toFixed(1e12, 2)).toBe(FIXED_MAX)
    expect(toFixed(-1e12, 2)).toBe(FIXED_MIN)
    expect(toFixed(Number.POSITIVE_INFINITY, 3)).toBe(FIXED_MAX)
    expect(toFixed(Number.NEGATIVE_INFINITY, 3)).toBe(FIXED_MIN)
    expect(toFixed(21474836.47, 2)).toBe(FIXED_MAX)
    expect(toFixed(-21474836.48, 2)).toBe(FIXED_MIN)
  })

  test("NaN encodes as 0 and -0 never escapes", () => {
    expect(toFixed(Number.NaN, 2)).toBe(0)
    expect(Object.is(toFixed(-0.001, 2), 0)).toBe(true)
    expect(Object.is(toFixed(-0, 2), 0)).toBe(true)
  })
})

describe("fromFixed / quantizeFixed", () => {
  test("divides by the exact scale", () => {
    expect(fromFixed(14550, 2)).toBe(145.5)
    // Multiplying by 0.01 would give 145.50000000000003.
    expect(fromFixed(14551, 2)).toBe(145.51)
    expect(fromFixed(-1, 3)).toBe(-0.001)
  })

  test("round-trips to the nearest representable step", () => {
    expect(quantizeFixed(1.23456, 2)).toBe(1.23)
    expect(quantizeFixed(-1.23456, 3)).toBe(-1.235)
  })
})
