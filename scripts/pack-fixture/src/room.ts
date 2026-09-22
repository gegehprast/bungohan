import { type Client, Room } from "@bungohan/core"
import { CounterState, counterContract, PlayerState } from "./shared"

export class CounterRoom extends Room<CounterState, typeof counterContract> {
  public static override contract = counterContract
  protected override state = new CounterState()

  protected override async onCreate(): Promise<void> {
    this.onMessage("increment", (client, { by }) => {
      this.state.count.set(this.state.count.get() + by)
      const player = this.state.players.get(client.sessionId)
      player?.score.set(player.score.get() + by)
      this.broadcastMessage("tally", { total: this.state.count.get() })
    })
  }

  protected override async onJoin(client: Client): Promise<void> {
    const player = new PlayerState()
    player.name.set(`player-${this.state.players.size + 1}`)
    this.state.players.set(client.sessionId, player)
  }

  protected override async onLeave(client: Client): Promise<void> {
    this.state.players.delete(client.sessionId)
  }
}
