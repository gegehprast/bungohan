import { createInt, createString, Schema } from "@bungohan/state"
import { f } from "@bungohan/types"
import type { GameStatus } from "../types"

/** A shooter room as the lobby lists it, keyed by room id. */
export class RoomInfo extends Schema {
  public static override readonly schemaName = "RoomInfo"

  public name = createString("")
  public code = createString("")
  public hostName = createString("")
  public playerCount = createInt(f.uint8)
  public maxPlayers = createInt(f.uint8)
  public status = createString<GameStatus>("waiting")
}
