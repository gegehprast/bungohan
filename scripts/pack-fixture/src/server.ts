/** A real Bun server on the published @bungohan/core tarball. */
import { createBungohanServer } from "@bungohan/core"
import { CounterRoom } from "./room"

const port = Number(process.env["PORT"] ?? 6061)
const server = createBungohanServer({ transport: { config: { port } } })
server.defineRoomType("counter", CounterRoom)

const started = await server.start()
if (started.isErr()) throw started.error
console.log(`listening ${port}`)
