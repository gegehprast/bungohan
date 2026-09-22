// #region server
import { createBungohanServer } from "@bungohan/core"
import { DEFAULT_PORT, ROOM_TYPE } from "@bungohan/tutorial-shared"
import { ArenaRoom } from "./ArenaRoom"

const port = Number(process.env["PORT"] ?? DEFAULT_PORT)

const server = createBungohanServer({ transport: { config: { port } } })
server.defineRoomType(ROOM_TYPE, ArenaRoom, { maxClients: 16 })

server.onJoin((client, room) => {
  console.log(`${client.sessionId} joined ${room.roomType} ${room.id}`)
})
server.onError((error, context) => {
  console.error(`error in ${context.source}:`, error)
})

// start() returns a Result instead of throwing.
const started = await server.start()
if (started.isErr()) {
  console.error("could not start:", started.error.message)
  process.exit(1)
}
console.log(`Gem Grab server on ws://localhost:${port}`)
// Ctrl+C (SIGINT) or SIGTERM stops it gracefully.
// #endregion server
