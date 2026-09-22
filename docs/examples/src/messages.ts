import { type Client, type Clock, Room } from "@bungohan/core"
import { createString, Schema } from "@bungohan/state"
// #region builders
import { defineContract, defineMessage, f, type Infer } from "@bungohan/types"

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
  public override state = new ChatState()

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

// #region ordered
/**
 * Handlers aren't awaited: if one awaits, a later message's handler can
 * run (and finish) first, even from the same client. Chain per client
 * when order matters.
 */
export class OrderedRoom extends Room<ChatState, typeof chatContract> {
  public static override contract = chatContract
  public override state = new ChatState()
  private readonly queues = new Map<string, Promise<void>>()

  protected override async onCreate(): Promise<void> {
    this.onMessage("say", (client, message) =>
      this.inOrder(client, async () => {
        const clean = await moderate(this.clock, message.text) // slow, async
        const said = { from: client.sessionId, text: clean, at: 0 }
        this.broadcast("said", said)
      }),
    )
  }

  protected override async onLeave(client: Client): Promise<void> {
    this.queues.delete(client.sessionId)
  }

  /** Runs `work` after this client's previous work has finished. */
  private inOrder(client: Client, work: () => Promise<void>): Promise<void> {
    const previous = this.queues.get(client.sessionId) ?? Promise.resolve()
    const next = previous.then(work, work)
    this.queues.set(client.sessionId, next)
    return next
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
