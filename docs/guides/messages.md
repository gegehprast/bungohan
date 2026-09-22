# Messages and contracts

State covers what everyone should *see*. Messages cover what happens:
a player's input, a chat line, "the round is over". A **contract**
declares every message a room accepts and sends, and TypeScript checks
both ends against it.

## Declaring messages

<!-- snippet: docs/examples/src/messages.ts#builders -->
[`docs/examples/src/messages.ts`](../examples/src/messages.ts)

```ts
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
```
<!-- /snippet -->

`defineMessage(name, fields)` declares one message. `defineContract`
groups them by direction: `client` is client → server, `server` is
server → client. Each key must equal its message's name (a compile error
otherwise), so the name you write at a call site is the name on the wire.

The field builders:

| Builder | TypeScript type | Notes |
|---|---|---|
| `f.int8` `f.int16` `f.int32` `f.uint8` `f.uint16` `f.uint32` | `number` | truncated toward zero and saturated to the range |
| `f.float32` `f.float64` | `number` | |
| `f.fixed(n)` | `number` | `n` decimals (0–9), sent as a scaled integer |
| `f.string` `f.bool` | `string` `boolean` | bools are packed into bits |
| `f.enum("a", "b")` | `"a" \| "b"` | sent as the index; numbers work too |
| `f.array(X)` `f.map(X)` | `X[]`, `{ [key: string]: X }` | |
| `f.optional(X)` | an optional property (`key?: X`) | |
| `f.nested(OtherMessage)` | that message's payload | |

`Infer<typeof Say>` gives you the payload type, for helper functions and
components.

Why builders and not an interface? An interface disappears at compile
time. The builder is a value, so the same declaration gives TypeScript
its type *and* gives the encoder a field-by-field layout. That's why a
message has no field names or type tags on the wire: `{ x: 145.5, y: -3 }`
as two `f.fixed(1)` fields is 3 bytes of payload.

## Sending and receiving

On the server, the room binds the contract as its second type parameter
and as `static contract`:

<!-- snippet: docs/examples/src/messages.ts#room -->
[`docs/examples/src/messages.ts`](../examples/src/messages.ts)

```ts
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
```
<!-- /snippet -->

- `this.onMessage(type, (client, payload) => …)` handles a client
  message. It's usually registered in `onCreate`, and returns a function
  that removes the handler.
- `this.send(client, type, payload)` sends to one client.
  `this.broadcast(type, payload, except?)` sends to everyone (encoded once,
  whatever the number of clients). From outside the room, use
  `room.broadcastMessage(…)`.

On the client, the same contract, mirrored:

<!-- snippet: docs/examples/src/messages.client.ts#client -->
[`docs/examples/src/messages.client.ts`](../examples/src/messages.client.ts)

```ts
export async function chat(client: IBungohanClient) {
  const joined = await client.joinOrCreate("chat", undefined, {
    state: ChatState,
    contract: chatContract,
  })
  if (joined.isErr()) return joined
  const room = joined.value

  // Checked against chatContract.client: the name and the payload.
  room.send("say", { text: "hello", channel: "all" })
  // room.send("say", { text: 1 })  ← compile error

  // Typed from chatContract.server.
  room.onMessage("said", ({ from, text }) => console.log(`${from}: ${text}`))

  // Raw messages carry their name inline and an `unknown` payload.
  room.sendRaw("emote", "wave")
  room.onMessageRaw((type, payload) => console.log(type, payload))
  return joined
}
```
<!-- /snippet -->

`room.send` returns a `Result`. It fails with `NOT_JOINED` after the room
was left, and with `NOT_CONNECTED` while the connection is being
re-established. Nothing is queued in the meantime: like state, messages
are about *now*.

## Compile-time only, and why that's safe

There is no runtime validation of messages. It isn't needed to guarantee
their types: a contract message is decoded from its bytes *using the
declaration*. A field declared `f.fixed(2)` is read as an integer and
divided by 100, so it can only come out as a number. A malformed or
truncated message fails to decode, and the server closes that client's
connection. It never reaches your handler. Once your handler runs, the
payload has the declared shape.

What the framework can't know is what a *valid* value is in your game. A
`uint16` score can be 65,535, and a `string` can be 10 MB of text or empty.
**Treat clients as hostile** and check game rules in the handler: is the
text a sensible length, is this player allowed to do this right now, is
that target in range? The tutorial clamps `dx` to -1…1 for exactly this
reason.

## Raw messages

`sendRaw`, `broadcastRaw` and `onMessageRaw` send any value MessagePack
can carry, with no contract. The payload arrives typed `unknown`, so you
narrow it yourself, and it costs more bytes, since the message name and
every key travel with it. Use them for prototyping and for payloads that
are genuinely dynamic. A room without a contract can only use these.

## Handlers aren't awaited

The server calls each handler as its message arrives and doesn't wait for
it to finish. A slow async handler doesn't hold up the next message, but
**async handlers can finish out of order, even for one client**. If a
handler awaits something (a database, an HTTP call) and ordering matters,
chain each client's work yourself:

<!-- snippet: docs/examples/src/messages.ts#ordered -->
[`docs/examples/src/messages.ts`](../examples/src/messages.ts)

```ts
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
```
<!-- /snippet -->

A handler that throws, or whose promise rejects, is reported to
`server.onError` and doesn't affect the room.

## Version skew

The contract's hash is sent with every join. A client built against an
older contract (a stale browser tab after you deploy) fails its join with
`CONTRACT_MISMATCH` instead of mis-reading messages. Any change to any
message of the contract changes the hash, so deploy the client and server
together, and handle `CONTRACT_MISMATCH` by asking the player to reload.

## Next

- [Join and create options](options.md)
- [Rooms and their lifecycle](rooms.md)
