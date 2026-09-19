/**
 * Codegen golden fixture: messages covering every field kind, nested
 * messages, enums of strings and numbers, and names that collide with
 * members of the generated classes.
 */
import { defineContract, defineMessage, f } from "@bungohan/types"

export const Point = defineMessage("point", { x: f.fixed(2), y: f.fixed(2) })

export const Everything = defineMessage("everything", {
  i8: f.int8,
  i16: f.int16,
  i32: f.int32,
  u8: f.uint8,
  u16: f.uint16,
  u32: f.uint32,
  f32: f.float32,
  f64: f.float64,
  fx: f.fixed(3),
  text: f.string,
  flag: f.bool,
  color: f.enum("red", "green", "dark blue"),
  level: f.enum(1, 5, 10),
  list: f.array(f.int16),
  names: f.map(f.string),
  maybe: f.optional(f.fixed(1)),
  maybeFlag: f.optional(f.bool),
  maybeColor: f.optional(f.enum("north", "south")),
  maybePoint: f.optional(f.nested(Point)),
  holes: f.array(f.optional(f.uint8)),
  sparse: f.map(f.optional(f.bool)),
  point: f.nested(Point),
  path: f.array(f.nested(Point)),
  grid: f.array(f.array(f.float64)),
  tagged: f.map(f.array(f.nested(Point))),
  palette: f.array(f.enum("red", "blue")),
  definition: f.string,
  encode: f.bool,
})

export const Ping = defineMessage("ping", {})

export const fixtureContract = defineContract({
  client: { everything: Everything, ping: Ping },
  server: { point: Point, everything: Everything },
})
