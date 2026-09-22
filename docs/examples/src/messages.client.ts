import type { IBungohanClient } from "@bungohan/client-js"
import { ChatState, chatContract } from "./messages"

// #region client
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
// #endregion client
