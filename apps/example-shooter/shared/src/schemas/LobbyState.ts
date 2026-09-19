import { createSchemaMap, Schema } from "@bungohan/state"
import { f } from "@bungohan/types"
import { RoomInfo } from "./RoomInfo"

/** Lobby state: the public shooter rooms, by room id. */
export class LobbyState extends Schema {
  public static override readonly schemaName = "LobbyState"

  public rooms = createSchemaMap(f.string, RoomInfo)
}
