import {
  createBoolean,
  createFixedPoint,
  createSchemaMap,
  createString,
  Schema,
} from "@bungohan/state"
import { f } from "@bungohan/types"
import type { GameStatus } from "../types"
import { Bullet } from "./Bullet"
import { Enemy } from "./Enemy"
import { Loot } from "./Loot"
import { Player } from "./Player"

/** State of one shooter room. */
export class GameState extends Schema {
  public static override readonly schemaName = "GameState"

  /** By sessionId. */
  public players = createSchemaMap(f.string, Player)
  // Entities are keyed by small integers: an int key costs 1–3 bytes where
  // a generated string id would cost ~20 on every add and remove.
  public enemies = createSchemaMap(f.uint32, Enemy)
  public bullets = createSchemaMap(f.uint32, Bullet)
  public loot = createSchemaMap(f.uint32, Loot)
  public roomCode = createString("")
  public roomName = createString("")
  public hostId = createString("")
  /** Whole seconds elapsed, so it goes out once a second, not every tick. */
  public gameTime = createFixedPoint(0)
  public gameStatus = createString<GameStatus>("waiting")
  public maxPlayers = createFixedPoint(0, 8)
  /** The host may start: enough players, all ready. */
  public canStart = createBoolean(false)
}
