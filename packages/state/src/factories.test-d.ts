/**
 * Type-level tests for the state factories, checked by `tsc --noEmit`.
 */
import {
  createFiltered,
  createFixedPoint,
  createMap,
  createNumber,
  createSchemaMap,
  createSet,
  createString,
} from "./factories"
import { Schema } from "./schema"

class Owned extends Schema {
  public static override schemaName = "TD.Owned"
  public ownerId = createString()
  public score = createNumber()

  // `this` is typed as the owning class via the annotation…
  public a = createFiltered(createNumber(), function (this: Owned, client) {
    return this.ownerId.get() === client.id
  })
  // …or captured lexically by an arrow function.
  public b = createFiltered(
    createString(),
    (client) => this.ownerId.get() === client.id,
  )
  // A custom client type.
  public c = createFiltered(
    createNumber(),
    (client: { team: number }) => client.team === this.score.get(),
  )
}

export function checks(o: Owned): void {
  // createFiltered keeps the wrapper's own API.
  o.a.set(1)
  o.b.set("x")

  // @ts-expect-error — collection elements must be wire primitives
  createMap<string, { nested: true }>()
  // @ts-expect-error — map keys are strings or numbers
  createMap<boolean, number>()
  // @ts-expect-error — schema collections hold Schema instances
  createSchemaMap<string, number>()
  // @ts-expect-error — sets of primitives only
  createSet<Owned>()
  // @ts-expect-error — at most 9 decimal places (int32 range)
  createFixedPoint(10)

  const status = createString<"idle" | "busy">("idle")
  // @ts-expect-error — not in the literal union
  status.set("done")
}
