/**
 * One-time credentials end to end (spec §10.1): the server's
 * `authenticate` redeems a ticket once per connection, and client-js's
 * token provider fetches a fresh one for every connection it opens.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  BungohanClient,
  type IBungohanClient,
  type TokenProvider,
} from "@bungohan/client-js"
import type { AuthResult, ConnectionContext } from "@bungohan/core"
import { LoopbackClientTransport } from "../client-transport"
import { GameRoom, GameState, gameContract } from "../core/fixtures"
import { createTestHarness, type TestHarness } from "../harness"

const game = { state: GameState, contract: gameContract }

let h: TestHarness
/** Every token `authenticate` saw, in order. */
let seen: (string | undefined)[]
let unused: Set<string>

beforeEach(async () => {
  seen = []
  unused = new Set(["t1", "t2", "t3"])
  h = await createTestHarness({
    rooms: { game: GameRoom },
    client: {
      pingInterval: 0,
      logger: { warn: () => {}, error: () => {} },
    },
    server: {
      authenticate(context: ConnectionContext): AuthResult {
        seen.push(context.token)
        const token = context.token
        return token !== undefined && unused.delete(token)
      },
    },
  })
})

afterEach(async () => {
  await h.stop()
})

/** Hands out the given tokens in turn; a function entry is called. */
function provider(
  ...tokens: (string | (() => Promise<string>))[]
): TokenProvider {
  let next = 0
  return () => {
    const token = tokens[next++]
    return typeof token === "function" ? token() : token
  }
}

async function joinGame(client: IBungohanClient) {
  return (await client.joinOrCreate("game", {}, game)).unwrap()
}

describe("token provider", () => {
  test("each reconnection carries a fresh ticket, so the seat resumes", async () => {
    const client = await h.connect({ token: provider("t1", "t2") })
    const room = await joinGame(client)
    await h.dropConnection(client)
    await h.tick(1000)
    expect(client.connectionState).toBe("connected")
    expect(room.status).toBe("joined")
    expect(seen).toEqual(["t1", "t2"])
  })

  test("a fixed one-time ticket is spent by the time the client reconnects", async () => {
    const client = await h.connect({ token: "t1" })
    const room = await joinGame(client)
    await h.dropConnection(client)
    await h.tick(1000)
    // The socket is back, but the resume was refused, so the seat is gone.
    expect(client.connectionState).toBe("connected")
    expect(room.status).toBe("left")
    expect(seen).toEqual(["t1", "t1"])
  })

  test("a failing provider costs one reconnection attempt, then backoff", async () => {
    const client = await h.connect({
      token: provider("t1", () => Promise.reject(new Error("offline")), "t2"),
    })
    const room = await joinGame(client)
    await h.dropConnection(client)
    await h.tick(1000) // the provider fails: no socket
    expect(client.connectionState).toBe("reconnecting")
    expect(seen).toEqual(["t1"])
    await h.tick(2000) // delay × factor
    expect(client.connectionState).toBe("connected")
    expect(room.status).toBe("joined")
    expect(seen).toEqual(["t1", "t2"])
  })

  test("a first connect fails with CONNECTION_FAILED when the provider throws", async () => {
    const client = new BungohanClient({
      url: "ws://loopback.test/",
      token: () => {
        throw new Error("no session")
      },
      autoConnect: false,
      transport: new LoopbackClientTransport(h.transport),
      clock: h.clock,
      logger: { warn: () => {}, error: () => {} },
    })
    const connected = await client.connect()
    expect(connected.isErr() && connected.error.code).toBe("CONNECTION_FAILED")
    expect(client.connectionState).toBe("disconnected")
    expect(seen).toEqual([])
  })

  test("disconnect() while the provider is pending opens no socket", async () => {
    let release: (token: string) => void = () => {}
    const client = new BungohanClient({
      url: "ws://loopback.test/",
      token: () =>
        new Promise<string>((resolve) => {
          release = resolve
        }),
      autoConnect: false,
      transport: new LoopbackClientTransport(h.transport),
      clock: h.clock,
    })
    const connecting = client.connect()
    await client.disconnect()
    expect((await connecting).isErr()).toBe(true)
    release("t1")
    await h.flush()
    expect(client.connectionState).toBe("disconnected")
    expect(seen).toEqual([])
  })
})
