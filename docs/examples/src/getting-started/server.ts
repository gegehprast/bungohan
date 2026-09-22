// #region server
import { createBungohanServer, Room } from "@bungohan/core"
import { CounterState, counterContract } from "./shared"

class CounterRoom extends Room<CounterState, typeof counterContract> {
  public static override contract = counterContract
  public override state = new CounterState()

  protected override async onCreate(): Promise<void> {
    this.onMessage("increment", (_client, { by }) => {
      this.state.count.set(this.state.count.get() + by)
    })
  }
}

const port = Number(process.env["PORT"] ?? 6060)
const server = createBungohanServer({ transport: { config: { port } } })
server.defineRoomType("counter", CounterRoom)

const started = await server.start()
if (started.isErr()) throw started.error
console.log(`listening on ws://localhost:${port}`)
// #endregion server
