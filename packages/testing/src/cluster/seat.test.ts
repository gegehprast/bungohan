/**
 * A seat whose socket is on one process and whose room is on another
 * (spec §6.4): state, messages both ways, filtering, leaving and kicking.
 * Everything here goes over the real wire protocol — clustering is
 * invisible to the client.
 */
import { describe, expect, test } from "bun:test"
import { type BungohanClient, LeaveCode } from "@bungohan/client-js"
import type { DefineRoomOptions } from "@bungohan/core"
import { type ClusterHarness, createClusterHarness } from "../cluster"
import { GameRoom, type Player } from "../core/fixtures"
import { type GameRoomView, joinOrCreate } from "./helpers"

async function cluster(
  size = 2,
  room: DefineRoomOptions = {},
): Promise<ClusterHarness> {
  return createClusterHarness({ size, rooms: { game: [GameRoom, room] } })
}

/** The one `GameRoom` in the cluster, and the node that owns it. */
function owner(c: ClusterHarness): { room: GameRoom; index: number } {
  for (const [index, node] of c.nodes.entries()) {
    for (const room of node.server.getRoomManager().getRooms()) {
      if (room instanceof GameRoom) return { room, index }
    }
  }
  throw new Error("no GameRoom in the cluster")
}

/** Puts the cluster's only room on node 1 and seats a client from node 0. */
async function remoteSeat(
  c: ClusterHarness,
): Promise<{ client: BungohanClient; room: GameRoomView }> {
  ;(await c.run(c.node(1).server.getMatchMaker().createRoom("game"))).unwrap()
  const client = await c.connect(0)
  return { client, room: (await joinOrCreate(client)).unwrap() }
}

describe("state", () => {
  test("the joiner's own snapshot arrives from the owning process", async () => {
    const c = await cluster()
    const { room } = await remoteSeat(c)
    expect(owner(c).index).toBe(1)
    expect(room.state.players.size).toBe(1)
    expect(room.state.turn.get()).toBe(0)
    await c.stop()
  })

  test("two clients on different processes see each other", async () => {
    const c = await cluster(3)
    ;(await c.run(c.node(2).server.getMatchMaker().createRoom("game"))).unwrap()
    const first = await joinOrCreate(await c.connect(0))
    const second = await joinOrCreate(await c.connect(1))
    const a = first.unwrap()
    const b = second.unwrap()
    expect(a.id).toBe(b.id)
    expect(owner(c).index).toBe(2)

    await c.flushSync()
    expect(a.state.players.size).toBe(2)
    expect(b.state.players.size).toBe(2)
    expect([...a.state.players.keys()].sort()).toEqual(
      [a.sessionId, b.sessionId].sort(),
    )
    await c.stop()
  })

  test("a message from one process moves state the other sees", async () => {
    const c = await cluster(3)
    ;(await c.run(c.node(2).server.getMatchMaker().createRoom("game"))).unwrap()
    const a = (await joinOrCreate(await c.connect(0))).unwrap()
    const b = (await joinOrCreate(await c.connect(1))).unwrap()
    await c.flushSync()

    a.send("move", { dx: 2.5 })
    await c.flushSync()
    await c.flushSync()

    expect(owner(c).room.game.players.get(a.sessionId)?.x.get()).toBe(2.5)
    expect(a.state.players.get(a.sessionId)?.x.get()).toBe(2.5)
    expect(b.state.players.get(a.sessionId)?.x.get()).toBe(2.5)
    await c.stop()
  })

  test("per-client filtering still works through a proxy", async () => {
    const c = await cluster(3)
    ;(await c.run(c.node(2).server.getMatchMaker().createRoom("game"))).unwrap()
    const a = (await joinOrCreate(await c.connect(0))).unwrap()
    const b = (await joinOrCreate(await c.connect(1))).unwrap()
    await c.flushSync()
    await c.flushSync()

    const secret = (view: GameRoomView, of: string): string | undefined =>
      (view.state.players.get(of) as Player | undefined)?.secret.get()
    expect(secret(a, a.sessionId)).toBe(`secret-of-${a.sessionId}`)
    expect(secret(a, b.sessionId)).toBe("")
    expect(secret(b, b.sessionId)).toBe(`secret-of-${b.sessionId}`)
    expect(secret(b, a.sessionId)).toBe("")
    await c.stop()
  })
})

describe("messages", () => {
  test("a message sent in onJoin reaches a client on another process", async () => {
    const c = await cluster()
    ;(await c.run(c.node(1).server.getMatchMaker().createRoom("game"))).unwrap()
    const client = await c.connect(0)
    const room = (await joinOrCreate(client)).unwrap()
    const welcomes: { sessionId: string; players: number }[] = []
    room.onMessage("welcome", (message) => welcomes.push(message))
    await c.flush()
    expect(welcomes).toEqual([{ sessionId: room.sessionId, players: 1 }])
    await c.stop()
  })

  test("a broadcast reaches clients on every process", async () => {
    const c = await cluster(3)
    ;(await c.run(c.node(2).server.getMatchMaker().createRoom("game"))).unwrap()
    const a = (await joinOrCreate(await c.connect(0))).unwrap()
    const b = (await joinOrCreate(await c.connect(1))).unwrap()
    const heardByA: string[] = []
    const heardByB: string[] = []
    a.onMessage("said", (message) => heardByA.push(message.text))
    b.onMessage("said", (message) => heardByB.push(message.text))
    await c.flush()

    a.send("say", { text: "hello" })
    await c.flush()
    expect(heardByA).toEqual(["hello"])
    expect(heardByB).toEqual(["hello"])
    await c.stop()
  })

  test("raw messages round-trip across processes", async () => {
    const c = await cluster()
    const { room } = await remoteSeat(c)
    const echoes: [string, unknown][] = []
    room.onMessageRaw((type, payload) => echoes.push([type, payload]))
    await c.flush()

    room.sendRaw("echo", { n: 7 })
    await c.flush()
    expect(echoes).toEqual([["echo", { n: 7 }]])
    await c.stop()
  })

  test("a broadcast from a RoomProxy reaches the room's clients", async () => {
    const c = await cluster()
    const { room } = await remoteSeat(c)
    const said: string[] = []
    room.onMessage("said", (message) => said.push(message.text))
    await c.flush()

    const proxy = (
      await c.run(c.node(0).server.getMatchMaker().joinById(room.id))
    ).unwrap()
    proxy.broadcastMessage(
      "said" as never,
      {
        from: "system",
        text: "from the proxy",
      } as never,
    )
    await c.flush()
    expect(said).toEqual(["from the proxy"])
    await c.stop()
  })
})

describe("leaving", () => {
  test("a consented leave releases the seat on the owning process", async () => {
    const c = await cluster(2, { autoDispose: false })
    const { room } = await remoteSeat(c)
    const owned = owner(c).room
    const codes: number[] = []
    room.onLeave((code) => codes.push(code))

    await room.leave()
    await c.flush()
    expect(codes).toEqual([LeaveCode.CONSENTED])
    expect(owned.getClientCount()).toBe(0)
    await c.stop()
  })

  test("a kick ends the seat but not the connection", async () => {
    const c = await cluster(2, { autoDispose: false })
    const { room } = await remoteSeat(c)
    const codes: number[] = []
    room.onLeave((code) => codes.push(code))

    const seat = owner(c).room.getClients()[0]
    if (seat === undefined) throw new Error("no seat")
    owner(c).room.disconnectClient(seat, LeaveCode.KICKED)
    await c.flush()

    expect(codes).toEqual([LeaveCode.KICKED])
    expect(c.node(0).server.getMatchMaker().getRoomCount()).toBe(0)
    // The connection survived: it can join again and get a new roomRef.
    const again = (await joinOrCreate(await c.connect(0))).unwrap()
    expect(again.id).toBe(room.id)
    await c.stop()
  })

  test("a room disposed on its own process ends remote seats too", async () => {
    const c = await cluster()
    const { room } = await remoteSeat(c)
    const codes: number[] = []
    room.onLeave((code) => codes.push(code))

    await owner(c).room.dispose()
    await c.flush()
    expect(codes).toEqual([LeaveCode.ROOM_DISPOSED])
    await c.stop()
  })

  test("a dropped connection holds the seat on the owning process", async () => {
    const c = await cluster()
    const { client, room } = await remoteSeat(c)
    await c.node(0).dropConnection(client, 1006)
    await c.flush()

    const seat = owner(c).room.getClients()[0]
    expect(seat?.connected).toBe(false)
    expect(seat?.status).toBe("reconnecting")
    expect(owner(c).room.getClientCount()).toBe(1)
    expect(room.id).toBe(owner(c).room.id)
    await c.stop()
  })
})
