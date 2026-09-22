/**
 * The module a game shares between its server and its browser (spec §6.10).
 * It imports `@bungohan/schema` and nothing else — that's what keeps server
 * code out of the browser, and it's asserted by the browser audit below.
 */
import {
  createInt,
  createSchemaMap,
  createString,
  defineContract,
  defineMessage,
  f,
  Schema,
} from "@bungohan/schema"

export class PlayerState extends Schema {
  public static override readonly schemaName = "PlayerState"
  public name = createString()
  public score = createInt(f.uint16)
}

export class CounterState extends Schema {
  public static override readonly schemaName = "CounterState"
  public count = createInt(f.uint32)
  public players = createSchemaMap(f.string, PlayerState)
}

export const counterContract = defineContract({
  client: { increment: defineMessage("increment", { by: f.uint8 }) },
  server: { tally: defineMessage("tally", { total: f.uint32 }) },
})
