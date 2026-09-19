/**
 * Type-level tests for core's typed rooms, checked by `tsc --noEmit` (never
 * executed). Every `@ts-expect-error` is an assertion.
 */
import { createNumber, Schema } from "@bungohan/state"
import { defineContract, defineMessage, f } from "@bungohan/types"
import type { Client } from "./client"
import { Room } from "./room"
import { BungohanServer } from "./server"

class S extends Schema {
  public static override schemaName = "TD.S"
  public n = createNumber()
}

const Move = defineMessage("move", { x: f.fixed(2) })
const Hit = defineMessage("hit", { by: f.string })
const contract = defineContract({
  client: { move: Move },
  server: { hit: Hit },
})

class Typed extends Room<S, typeof contract> {
  public static override contract = contract
  public override state = new S()

  protected override async onCreate(): Promise<void> {
    this.onMessage("move", (client, msg) => {
      const x: number = msg.x
      this.send(client, "hit", { by: client.sessionId })
      this.broadcast("hit", { by: String(x) }, client)
      // @ts-expect-error — wrong direction
      this.send(client, "move", { x: 1 })
      // @ts-expect-error — wrong payload
      this.broadcast("hit", { by: 1 })
    })
    // @ts-expect-error — not a client message
    this.onMessage("hit", () => {})
  }
}

class Forgot extends Room<S, typeof contract> {
  public override state = new S()
}

class Untyped extends Room<S> {
  public override state = new S()
  protected override async onJoin(client: Client): Promise<void> {
    this.sendRaw(client, "anything", { at: 1 })
    // @ts-expect-error — no contract, no typed send
    this.send(client, "hit", { by: "x" })
  }
}

const server = new BungohanServer({ transport: { config: { port: 0 } } })
server.defineRoomType("typed", Typed)
server.defineRoomType("untyped", Untyped)
// @ts-expect-error — typed with a contract but no `static contract`
server.defineRoomType("forgot", Forgot)

class WrongContract extends Room<S, typeof contract> {
  public static override contract = defineContract({ client: {}, server: {} })
}
// @ts-expect-error — `static contract` is not the typed contract
server.defineRoomType("wrong", WrongContract)

// Typed rooms are rooms.
export const rooms: Room[] = [new Typed(), new Untyped()]
