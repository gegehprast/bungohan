import { createFixedPoint, createString, Schema } from "@bungohan/state"
import type { GameStatus } from "../types"

/** A shooter room as the lobby lists it, keyed by room id. */
export class RoomInfo extends Schema {
  public static override readonly schemaName = "RoomInfo"

  public name = createString("")
  public code = createString("")
  public hostName = createString("")
  public playerCount = createFixedPoint(0)
  public maxPlayers = createFixedPoint(0)
  public status = createString<GameStatus>("waiting")
}
