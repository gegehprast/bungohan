import {
  createBoolean,
  createFixedPoint,
  createInt,
  createString,
  f,
  Schema,
} from "@bungohan/client-js"

/**
 * A player, keyed by `sessionId` in `GameState.players`.
 *
 * Positions are fixed-point (spec §5.7.6): 0.1 px on the wire, so a
 * coordinate in the 1000 px arena costs at most 3 bytes instead of 9. The
 * server keeps full precision; clients see the quantized value.
 */
export class Player extends Schema {
  public static override readonly schemaName = "Player"

  public name = createString("")
  public color = createString("")
  public x = createFixedPoint(1)
  public y = createFixedPoint(1)
  /** Radians, 0.01 on the wire. */
  public rotation = createFixedPoint(2)
  public score = createInt(f.int32)
  /** 0 to PLAYER_MAX_HEALTH. */
  public health = createInt(f.uint8)
  public isDead = createBoolean(false)
  public isReady = createBoolean(false)

  /** Server-only: plain fields are never synchronized. */
  public lastShotAt = Number.NEGATIVE_INFINITY
}
