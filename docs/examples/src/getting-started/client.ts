// #region client
import { createBungohanClient } from "@bungohan/client-js"
import { CounterState, counterContract } from "./shared"

const url = process.env["SERVER_URL"] ?? "ws://localhost:6060"
const client = createBungohanClient({ url })

const joined = await client.joinOrCreate("counter", undefined, {
  state: CounterState,
  contract: counterContract,
})
if (joined.isErr()) throw joined.error
const room = joined.value

room.state.count.onChange((count) => {
  console.log(`count is now ${count}`)
  if (count >= 3) void client.disconnect()
})

for (let i = 0; i < 3; i++) room.send("increment", { by: 1 })
// #endregion client
