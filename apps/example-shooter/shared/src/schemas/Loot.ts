import { createFixedPoint, createInt, Schema } from "@bungohan/state"
import { f } from "@bungohan/types"

/** A pickup dropped by a dead enemy, keyed by a numeric id in `GameState.loot`. */
export class Loot extends Schema {
  public static override readonly schemaName = "Loot"

  public x = createFixedPoint(1)
  public y = createFixedPoint(1)
  public value = createInt(f.uint8)

  /** Server-only: plain fields are never synchronized. */
  public spawnedAt = 0
}
