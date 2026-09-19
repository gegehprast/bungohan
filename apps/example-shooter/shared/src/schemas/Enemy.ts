import { createFixedPoint, createInt, Schema } from "@bungohan/state"
import { f } from "@bungohan/types"

/** An enemy, keyed by a numeric id in `GameState.enemies`. */
export class Enemy extends Schema {
  public static override readonly schemaName = "Enemy"

  public x = createFixedPoint(1)
  public y = createFixedPoint(1)
  public health = createInt(f.uint8)

  /** Server-only: plain fields are never synchronized. */
  public lastShotAt = 0
}
