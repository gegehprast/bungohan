import { createSchemaMap, f, Schema } from "@bungohan/schema"
import { RoomInfo } from "./RoomInfo"

/** Lobby state: the public shooter rooms, by room id. */
export class LobbyState extends Schema {
  public static override readonly schemaName = "LobbyState"

  public rooms = createSchemaMap(f.string, RoomInfo)
}
