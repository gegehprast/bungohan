import { createBungohanServer } from "@bungohan/core"
import {
  DEFAULT_SERVER_PORT,
  ROOM_TYPE,
} from "@bungohan/example-shooter-shared"
import { setupShooterServer, TICK_RATES } from "./app"

const port = Number(process.env["PORT"] ?? DEFAULT_SERVER_PORT)

const server = createBungohanServer({
  transport: { config: { port } },
  ...TICK_RATES,
})
setupShooterServer(server)

// SIGINT/SIGTERM stop the server gracefully (gracefulShutdown defaults).
const started = await server.start()
if (started.isErr()) {
  console.error("✖ Could not start the server:", started.error.message)
  process.exit(1)
}

const lobby = await server.getMatchMaker().createRoom(ROOM_TYPE.LOBBY)
if (lobby.isErr()) {
  console.error("✖ Could not create the lobby:", lobby.error.message)
  process.exit(1)
}

console.log(`✨ Bungohan Shooter server on ws://localhost:${port}`)
console.log(`   lobby ${lobby.value.id}; Ctrl+C stops it gracefully`)
