/**
 * A real client over a real WebSocket to a real server process: the join
 * handshake, a message, and the state patch that comes back.
 */
import { createBungohanClient } from "@bungohan/client-js"
import { CounterState, counterContract } from "./shared"

const url = process.env["SERVER_URL"]
if (url === undefined) throw new Error("SERVER_URL is required")

const client = createBungohanClient({ url, reconnection: { enabled: false } })
const joined = await client.joinOrCreate("counter", undefined, {
  state: CounterState,
  contract: counterContract,
})
if (joined.isErr()) throw joined.error
const room = joined.value

const reached = Promise.withResolvers<number>()
room.state.count.onChange((count) => {
  if (count >= 3) reached.resolve(count)
})
const tallied = Promise.withResolvers<number>()
room.onMessage("tally", ({ total }) => {
  if (total >= 3) tallied.resolve(total)
})

for (let i = 0; i < 3; i++) room.send("increment", { by: 1 })

const timeout = setTimeout(() => {
  throw new Error("the server never sent the state back")
}, 10_000)
const count = await reached.promise
const total = await tallied.promise
clearTimeout(timeout)

if (!(room.state instanceof CounterState)) {
  throw new Error("the replica is not the shared module's CounterState")
}
const me = room.state.players.get(room.sessionId)
if (me === undefined) throw new Error("no player in the replicated map")

console.log(
  JSON.stringify({
    count,
    total,
    score: me.score.get(),
    name: me.name.get(),
    players: room.state.players.size,
  }),
)
await client.disconnect()
