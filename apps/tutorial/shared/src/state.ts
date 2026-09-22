// #region imports
import {
  createFixedPoint,
  createInt,
  createSchemaMap,
  createString,
  Schema,
} from "@bungohan/state"
import { f } from "@bungohan/types"
// #endregion imports

// #region player
export class Player extends Schema {
  public static override readonly schemaName = "Player"

  public name = createString("")
  // Fixed-point with one decimal: 0.1 px is plenty for drawing, and it
  // costs 1–3 bytes on the wire instead of a 9-byte float.
  public x = createFixedPoint(1)
  public y = createFixedPoint(1)
  public score = createInt(f.uint16)
}
// #endregion player

// #region gem
export class Gem extends Schema {
  public static override readonly schemaName = "Gem"

  public x = createFixedPoint(1)
  public y = createFixedPoint(1)
}
// #endregion gem

// #region arena-state
export class ArenaState extends Schema {
  public static override readonly schemaName = "ArenaState"

  /** Keyed by the player's `sessionId`. */
  public players = createSchemaMap(f.string, Player)
  /** Keyed by a small integer id: cheaper on the wire than a string. */
  public gems = createSchemaMap(f.uint32, Gem)
}
// #endregion arena-state
