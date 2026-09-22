import { Room } from "@bungohan/core"
import { createInt, createNumber, Schema } from "@bungohan/state"
import { f } from "@bungohan/types"

// #region schemaname-bad
// ✗ No schemaName: clients can't match the class by name.
export class Enemy extends Schema {
  public hp = createNumber(100)
}
// #endregion schemaname-bad

// #region schemaname-good
// ✓ Its own static schemaName, unique among the room's classes.
export class Monster extends Schema {
  public static override readonly schemaName = "Monster"
  public hp = createNumber(100)
}
// #endregion schemaname-good

export class EnemyRoom extends Room<Enemy> {
  public override state = new Enemy()
}

// #region plain-field
export class Tower extends Schema {
  public static override readonly schemaName = "Tower"

  public hp = 100 // ✗ a plain field: stays on the server, never synced
  public armor = createInt(f.uint8, 5) // ✓ a wrapper: synced
}
// #endregion plain-field

export class TowerRoom extends Room<Tower> {
  public override state = new Tower()
}
