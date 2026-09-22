/**
 * The React entry point, `@bungohan/client-js/react`. It is only ever
 * bundled here — the point is that the subpath export resolves, its types
 * resolve, and it pulls in no server code.
 */
import { createBungohanClient } from "@bungohan/client-js"
import {
  BungohanProvider,
  useRoom,
  useRoomState,
} from "@bungohan/client-js/react"
import type { ReactNode } from "react"
import { CounterState, counterContract } from "./shared"

const client = createBungohanClient({
  url: process.env["SERVER_URL"] ?? "ws://localhost:6061",
})

function Counter(): ReactNode {
  const { room, status } = useRoom("counter", undefined, "joinOrCreate", {
    state: CounterState,
    contract: counterContract,
  })
  const count = useRoomState(room, (state) => state.count.get())
  if (status !== "connected") return <p>{status}</p>
  return (
    <button type="button" onClick={() => room?.send("increment", { by: 1 })}>
      count: {count}
    </button>
  )
}

export function App(): ReactNode {
  return (
    <BungohanProvider client={client}>
      <Counter />
    </BungohanProvider>
  )
}
