/**
 * client-js's default transport (the platform `WebSocket`) against core on
 * a real `WebSocketTransport` (Bun.serve): the subprotocol is negotiated
 * for real, and frames cross a real socket as binary messages. Real time,
 * so it only waits for things that happen within one sync interval.
 */
import { afterEach, expect, test } from "bun:test"
import { BungohanClient } from "@bungohan/client-js"
import { BungohanServer } from "@bungohan/core"
import { WebSocketTransport } from "@bungohan/transport"
import {
  GameRoom,
  GameState,
  gameContract,
  resetFaults,
} from "../core/fixtures"

let server: BungohanServer | undefined
let client: BungohanClient | undefined

afterEach(async () => {
  await client?.disconnect()
  if (server?.isRunning()) await server.stop()
  client = undefined
  server = undefined
})

test("joins and exchanges typed messages over a real WebSocket", async () => {
  resetFaults()
  const transport = new WebSocketTransport()
  server = new BungohanServer({
    logger: { level: "silent" },
    gracefulShutdown: { handleSignals: false },
    transport: { provider: transport, config: { port: 0 } },
  })
  server.defineRoomType("game", GameRoom)
  ;(await server.start()).unwrap()

  client = new BungohanClient({
    url: `ws://127.0.0.1:${transport.getPort()}`,
    autoConnect: false,
    pingInterval: 0,
  })
  ;(await client.connect()).unwrap()
  const room = (
    await client.joinOrCreate(
      "game",
      {},
      {
        state: GameState,
        contract: gameContract,
      },
    )
  ).unwrap()
  expect(room.state.players.get(room.sessionId)?.name.get()).toBe(
    room.sessionId,
  )

  const said = new Promise<string>((resolve) => {
    room.onMessage("said", ({ text }) => resolve(text))
  })
  room.send("say", { text: "over the wire" })
  expect(await said).toBe("over the wire")
})
