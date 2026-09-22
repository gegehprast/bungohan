import { createFixedPoint, createString, Schema } from "@bungohan/client-js"

/**
 * A bullet, keyed by a numeric id in `GameState.bullets`. Clients only
 * need where it is and whose it is; its motion stays on the server.
 */
export class Bullet extends Schema {
  public static override readonly schemaName = "Bullet"

  /** A player's sessionId, or `ENEMY_OWNER`. */
  public ownerId = createString("")
  public x = createFixedPoint(1)
  public y = createFixedPoint(1)

  // Server-only: plain fields are never synchronized.
  /** Pixels per second. */
  public vx = 0
  public vy = 0
  public damage = 0
  public ageMs = 0
}
