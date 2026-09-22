// #region shared
import { createInt, Schema } from "@bungohan/state"
import { defineContract, defineMessage, f } from "@bungohan/types"

/** The state every client sees, kept in sync by the server. */
export class CounterState extends Schema {
  public static override readonly schemaName = "CounterState"
  public count = createInt(f.uint32)
}

/** The messages each side may send, and their payloads. */
export const counterContract = defineContract({
  client: { increment: defineMessage("increment", { by: f.uint8 }) },
  server: {},
})
// #endregion shared
