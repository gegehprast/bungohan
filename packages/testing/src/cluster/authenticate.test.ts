/**
 * `ServerOptions.authenticate` in a cluster (spec §10.1): it runs on the
 * process holding the socket, once, and its result travels with every
 * join to the process that owns the room.
 */
import { expect, test } from "bun:test"
import type { ConnectionContext } from "@bungohan/core"
import { createClusterHarness } from "../cluster"
import { GameRoom } from "../core/fixtures"
import { joinOrCreate } from "./helpers"

test("a remote seat inherits the edge's auth; the ticket is redeemed once", async () => {
  const redeemed: (string | undefined)[] = []
  const unused = new Set(["t1"])
  const c = await createClusterHarness({
    size: 2,
    rooms: { game: [GameRoom, { autoDispose: false }] },
    server: {
      authenticate(context: ConnectionContext) {
        redeemed.push(context.token)
        if (context.token === undefined || !unused.delete(context.token)) {
          return false
        }
        return { userId: "u1" }
      },
    },
  })
  const owner = c.node(1).server.getMatchMaker()
  const remote = (await c.run(owner.createRoom("game"))).unwrap()
  const client = await c.connect(0, { token: "t1" })
  const first = (await joinOrCreate(client)).unwrap()
  expect(first.id).toBe(remote.id)
  expect(remote.getClient(first.sessionId)?.auth).toEqual({ userId: "u1" })
  expect(remote.getClient(first.sessionId)?.connection?.auth).toEqual({
    userId: "u1",
  })

  // A second room, wherever it lands: no second redemption.
  const second = (await joinOrCreate(client)).unwrap()
  expect(second.id).not.toBe(first.id)
  const room = c.nodes
    .map((node) => node.server.getMatchMaker().getRoom(second.id))
    .find((found) => found !== undefined)
  expect(room?.getClient(second.sessionId)?.auth).toEqual({ userId: "u1" })
  expect(redeemed).toEqual(["t1"])
  await c.stop()
})
