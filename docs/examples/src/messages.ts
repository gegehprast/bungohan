import {
  type Clock,
  createString,
  defineContract,
  defineMessage,
  f,
  type Infer,
  Room,
  Schema,
  type TimerId,
} from "@bungohan/core"

// #region builders
export const Say = defineMessage("say", {
  text: f.string,
  channel: f.enum("all", "team"), // "all" | "team", sent as an index
  replyTo: f.optional(f.uint32), // an optional property: replyTo?: number
})

export const Said = defineMessage("said", {
  from: f.string,
  text: f.string,
  at: f.float64,
})

export const Scoreboard = defineMessage("scoreboard", {
  rows: f.array(
    f.nested(defineMessage("row", { name: f.string, score: f.int32 })),
  ),
  byTeam: f.map(f.uint16), // { [team: string]: number }
})

// Infer turns a declaration into its payload type.
export type SayPayload = Infer<typeof Say>
// { text: string; channel: "all" | "team"; replyTo?: number }

export const chatContract = defineContract({
  client: { say: Say }, // client → server
  server: { said: Said, scoreboard: Scoreboard }, // server → client
})
// #endregion builders

export class ChatState extends Schema {
  public static override readonly schemaName = "ChatState"
  public topic = createString("")
}

// #region room
export class ChatRoom extends Room<ChatState, typeof chatContract> {
  public static override contract = chatContract
  protected override state = new ChatState()

  protected override async onCreate(): Promise<void> {
    // `text` is a string, `channel` is "all" | "team": decoded, not trusted.
    this.onMessage("say", (client, { text, channel }) => {
      if (text.length === 0 || text.length > 200) return // game rules
      const said = { from: client.sessionId, text, at: this.clock.now() }
      if (channel === "all") this.broadcast("said", said)
      else this.send(client, "said", said)
    })

    // Raw messages: any MessagePack value, typed `unknown`. Narrow it.
    this.onMessageRaw("emote", (client, payload) => {
      if (typeof payload !== "string") return
      this.broadcastRaw("emote", { from: client.sessionId, emote: payload })
    })
  }
}
// #endregion room

const announcement = { from: "server", text: "a minute passed", at: 0 }

// #region ordered
/**
 * Handlers aren't awaited: if one awaits, a later message's handler can
 * run (and finish) first, even from the same client. `serial: true`
 * puts a handler on the room's queue, so each starts after the last one
 * has finished.
 */
export class OrderedRoom extends Room<ChatState, typeof chatContract> {
  public static override contract = chatContract
  protected override state = new ChatState()
  private timer: TimerId | undefined

  protected override async onCreate(): Promise<void> {
    this.onMessage(
      "say",
      async (client, message) => {
        const clean = await moderate(this.clock, message.text) // slow, async
        const said = { from: client.sessionId, text: clean, at: 0 }
        this.broadcast("said", said)
      },
      { serial: true },
    )
    // A timer joins the same queue, so it never lands mid-handler.
    this.timer = this.clock.setInterval(() => {
      void this.serial(() => this.broadcast("said", announcement))
    }, 60_000)
  }

  protected override async onDispose(): Promise<void> {
    if (this.timer !== undefined) this.clock.clearInterval(this.timer)
  }
}
// #endregion ordered

/**
 * Stand-in for a slow external check (an HTTP call, say): longer texts
 * take longer. On the room's clock, so tests drive it.
 */
export async function moderate(clock: Clock, text: string): Promise<string> {
  await new Promise<void>((resolve) => {
    clock.setTimeout(() => resolve(), text.length)
  })
  return text
}
