/**
 * The shooter's rooms end to end: a real server and real client-js clients
 * over the loopback, on a manual clock (spec §11.2).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { BungohanClient, IRoom } from "@bungohan/client-js"
import {
  GAME_CONFIG,
  GameState,
  LobbyState,
  lobbyContract,
  type PlayerInput,
  ROOM_TYPE,
  shooterContract,
} from "@bungohan/example-shooter-shared"
import { createTestHarness, type TestHarness } from "@bungohan/testing"
import { setupShooterServer, TICK_RATES } from "../app"

type ShooterView = IRoom<GameState, typeof shooterContract>

const shooter = { state: GameState, contract: shooterContract }
const lobby = { state: LobbyState, contract: lobbyContract }

const idle: PlayerInput = {
  up: false,
  down: false,
  left: false,
  right: false,
  rotation: 0,
  shooting: false,
}

let h: TestHarness

beforeEach(async () => {
  h = await createTestHarness({
    define: (server) => setupShooterServer(server, { log: false }),
    server: TICK_RATES,
    client: { pingInterval: 0, logger: { warn() {}, error() {} } },
  })
})

afterEach(async () => {
  await h.stop()
})

/**
 * Delivers what clients sent, then advances time. (`tick` alone advances
 * first and delivers after, so a message sent right before it would only
 * take effect at the next tick's sync.)
 */
async function step(ms: number): Promise<void> {
  await h.flush()
  await h.tick(ms)
}

async function player(): Promise<BungohanClient> {
  return h.connect()
}

async function createGame(
  client: BungohanClient,
  playerName: string,
  isPrivate = false,
): Promise<ShooterView> {
  const options = { playerName, maxPlayers: 4, isPrivate }
  return (await client.create(ROOM_TYPE.SHOOTER, options, shooter)).unwrap()
}

function names(room: ShooterView): string[] {
  return [...room.state.players.values()].map((p) => p.name.get()).sort()
}

describe("shooter room", () => {
  test("two players join, ready up, start, and see each other move", async () => {
    const alice = await createGame(await player(), "Alice")
    const bob = (
      await (await player()).joinById(alice.id, { playerName: "Bob" }, shooter)
    ).unwrap()
    await step(50)

    expect(names(alice)).toEqual(["Alice", "Bob"])
    expect(names(bob)).toEqual(["Alice", "Bob"])
    expect(bob.state.hostId.get()).toBe(alice.sessionId)
    expect(bob.state.roomCode.get()).toMatch(/^[A-Z2-9]{6}$/)

    // Nobody ready: the host can't start yet.
    alice.send("startGame", {})
    await step(50)
    expect(alice.state.gameStatus.get()).toBe("waiting")

    alice.send("ready", { isReady: true })
    bob.send("ready", { isReady: true })
    await step(50)
    expect(alice.state.canStart.get()).toBe(true)

    // Only the host may start.
    bob.send("startGame", {})
    await step(50)
    expect(bob.state.gameStatus.get()).toBe("waiting")

    let started = 0
    bob.onMessage("gameStarted", () => started++)
    alice.send("startGame", {})
    await step(50)
    expect(bob.state.gameStatus.get()).toBe("playing")
    expect(started).toBe(1)

    // Alice runs toward the middle for half a second; Bob sees it.
    const seen = bob.state.players.get(alice.sessionId)
    if (seen === undefined) throw new Error("Bob can't see Alice")
    const x0 = seen.x.get()
    const toRight = x0 < GAME_CONFIG.ARENA_WIDTH / 2
    alice.send("input", { ...idle, right: toRight, left: !toRight })
    await step(500)

    const moved = seen.x.get() - x0
    const expected = (GAME_CONFIG.PLAYER_SPEED * 500) / 1000
    expect(Math.abs(moved)).toBeGreaterThan(expected * 0.8)
    expect(Math.sign(moved)).toBe(toRight ? 1 : -1)
    // Positions are fixed-point: one decimal on the wire.
    expect(Math.round(seen.x.get() * 10) / 10).toBe(seen.x.get())
  })

  test("the host leaving hands the room to the next player", async () => {
    const aliceClient = await player()
    const alice = await createGame(aliceClient, "Alice")
    const bob = (
      await (await player()).joinById(alice.id, { playerName: "Bob" }, shooter)
    ).unwrap()

    const left: string[] = []
    bob.onMessage("playerLeft", ({ playerId }) => left.push(playerId))
    await alice.leave()
    await step(50)

    expect(left).toEqual([alice.sessionId])
    expect(names(bob)).toEqual(["Bob"])
    expect(bob.state.hostId.get()).toBe(bob.sessionId)
  })

  test("a round ends on time, reports results, then reopens", async () => {
    const room = await createGame(await player(), "Solo")
    const results: unknown[] = []
    room.onMessage("gameEnded", (message) => results.push(message.results))
    room.send("ready", { isReady: true })
    await step(50)
    room.send("startGame", {})
    await step(50)
    expect(room.state.gameStatus.get()).toBe("playing")

    await step(GAME_CONFIG.GAME_DURATION_S * 1000)
    expect(room.state.gameStatus.get()).toBe("finished")
    expect(room.state.gameTime.get()).toBe(GAME_CONFIG.GAME_DURATION_S)
    expect(results).toEqual([
      [
        {
          playerId: room.sessionId,
          playerName: "Solo",
          score: 0,
          rank: 1,
          color: GAME_CONFIG.PLAYER_COLORS[0],
        },
      ],
    ])

    await step(GAME_CONFIG.RESULTS_DURATION_MS)
    expect(room.state.gameStatus.get()).toBe("waiting")
    expect(room.state.players.get(room.sessionId)?.isReady.get()).toBe(false)
    expect(room.state.enemies.size).toBe(0)
  })

  test("a full room starts on its own after the countdown", async () => {
    const options = { playerName: "Solo", maxPlayers: 1, isPrivate: false }
    const room = (
      await (await player()).create(ROOM_TYPE.SHOOTER, options, shooter)
    ).unwrap()
    await step(GAME_CONFIG.AUTO_START_DELAY_MS - 100)
    expect(room.state.gameStatus.get()).toBe("waiting")
    await step(200)
    expect(room.state.gameStatus.get()).toBe("playing")
  })
})

describe("lobby", () => {
  test("lists public rooms and finds private ones by code", async () => {
    const watcher = (
      await (await player()).joinOrCreate(ROOM_TYPE.LOBBY, {}, lobby)
    ).unwrap()
    const open = await createGame(await player(), "Alice")
    const hidden = await createGame(await player(), "Dave", true)
    await step(50)

    const listed = watcher.state.rooms.get(open.id)
    expect([...watcher.state.rooms.keys()]).toEqual([open.id])
    expect(listed?.hostName.get()).toBe("Alice")
    expect(listed?.code.get()).toBe(open.state.roomCode.get())
    expect(listed?.playerCount.get()).toBe(1)
    expect(listed?.maxPlayers.get()).toBe(4)

    const found: string[] = []
    const errors: string[] = []
    watcher.onMessage("roomFound", ({ roomId }) => found.push(roomId))
    watcher.onMessage("error", ({ message }) => errors.push(message))
    const code = hidden.state.roomCode.get().toLowerCase()
    watcher.send("joinByCode", { roomCode: code })
    watcher.send("joinByCode", { roomCode: "NOPE22" })
    await step(50)
    expect(found).toEqual([hidden.id])
    expect(errors).toEqual(["No room with code NOPE22"])

    // The emptied room disappears from the list.
    await open.leave()
    await step(GAME_CONFIG.LOBBY_REFRESH_MS)
    expect(watcher.state.rooms.size).toBe(0)
  })
})
