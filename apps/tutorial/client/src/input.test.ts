import { expect, test } from "bun:test"
import { directionOf } from "./input"

test("held keys give one step per axis", () => {
  expect(directionOf([])).toEqual({ dx: 0, dy: 0 })
  expect(directionOf(["d"])).toEqual({ dx: 1, dy: 0 })
  expect(directionOf(["ArrowUp", "ArrowLeft"])).toEqual({ dx: -1, dy: -1 })
  // WASD and arrows together don't double the speed.
  expect(directionOf(["d", "ArrowRight"])).toEqual({ dx: 1, dy: 0 })
  expect(directionOf(["a", "d"])).toEqual({ dx: 0, dy: 0 })
  expect(directionOf(["x"])).toEqual({ dx: 0, dy: 0 })
})
