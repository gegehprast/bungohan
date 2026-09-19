/**
 * `@bungohan/client-js/react` against a real server and client (spec
 * §7.4), rendered with react-dom into a happy-dom document.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"
import type { BungohanClient, IRoom } from "@bungohan/client-js"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import {
  calls,
  GameRoom,
  GameState,
  gameContract,
  resetFaults,
} from "../core/fixtures"
import { createTestHarness, type TestHarness } from "../harness"

type ReactModule = typeof import("react")
type ClientModule = typeof import("react-dom/client")
type HooksModule = typeof import("@bungohan/client-js/react")

let React: ReactModule
let ReactDOM: ClientModule
let hooks: HooksModule

type GameView = IRoom<GameState, typeof gameContract>
const game = { state: GameState, contract: gameContract }

beforeAll(async () => {
  // Only for this file: react-dom needs a document, and must see it when
  // it loads.
  GlobalRegistrator.register()
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)
  React = await import("react")
  ReactDOM = await import("react-dom/client")
  hooks = await import("@bungohan/client-js/react")
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

let h: TestHarness
let root: import("react-dom/client").Root | undefined

beforeEach(async () => {
  resetFaults()
  calls.length = 0
  h = await createTestHarness({
    rooms: { game: GameRoom },
    client: { pingInterval: 0, logger: { warn() {}, error() {} } },
  })
})

afterEach(async () => {
  if (root !== undefined) {
    const current = root
    await React.act(async () => current.unmount())
    root = undefined
  }
  await h.stop()
})

/** Runs harness work inside `act`, so React commits what it caused. */
async function act(work: () => Promise<void>): Promise<void> {
  await React.act(work)
}

async function render(element: React.ReactNode): Promise<void> {
  const container = document.createElement("div")
  const created = ReactDOM.createRoot(container)
  root = created
  await React.act(async () => created.render(element))
}

function serverRoom(view: { id: string }): GameRoom {
  const room = h.server.getMatchMaker().getRoom(view.id)
  if (!(room instanceof GameRoom)) throw new Error("no such room")
  return room
}

async function joined(client: BungohanClient): Promise<GameView> {
  return (await client.joinOrCreate("game", {}, game)).unwrap()
}

/** Moves a player on the server and delivers the resulting patch. */
async function move(room: GameView, sessionId: string, dx: number) {
  const player = serverRoom(room).game.players.get(sessionId)
  if (player === undefined) throw new Error("no player")
  player.x.set(player.x.get() + dx)
  await act(() => h.flushSync())
}

describe("provider and useRoom", () => {
  test("joins on mount, reports status, leaves on unmount", async () => {
    const client = await h.connect()
    const seen: string[] = []
    let current:
      | ReturnType<typeof hooks.useRoom<GameState, typeof gameContract>>
      | undefined

    function Game() {
      const result = hooks.useRoom(
        "game",
        { from: "react" },
        "joinOrCreate",
        game,
      )
      current = result
      seen.push(result.status)
      return null
    }
    await render(
      React.createElement(
        hooks.BungohanProvider,
        { client },
        React.createElement(Game),
      ),
    )
    await act(() => h.flush())

    expect(seen[0]).toBe("connecting")
    expect(current?.status).toBe("connected")
    const room = current?.room
    if (room === undefined) throw new Error("no room")
    expect(room.state.players.has(room.sessionId)).toBe(true)
    expect(serverRoom(room).hasClient(room.sessionId)).toBe(true)

    const r = root
    if (r === undefined) throw new Error("no root")
    await React.act(async () => r.unmount())
    root = undefined
    await h.flush()
    expect(room.status).toBe("left")
    expect(calls).toContain(`onLeave ${room.sessionId} true`)
  })

  test("a failed join reports status error", async () => {
    const client = await h.connect()
    let current: { status: string; error?: { code: string } } | undefined
    function Game() {
      current = hooks.useRoom("game", {}, "join")
      return null
    }
    await render(
      React.createElement(
        hooks.BungohanProvider,
        { client },
        React.createElement(Game),
      ),
    )
    await act(() => h.flush())
    expect(current?.status).toBe("error")
    expect(current?.error?.code).toBe("ROOM_NOT_FOUND")
  })

  test("joinById joins the room with that id", async () => {
    const host = await joined(await h.connect())
    const client = await h.connect()
    let current:
      | ReturnType<typeof hooks.useRoom<GameState, typeof gameContract>>
      | undefined
    function Guest(props: { roomId: string }) {
      current = hooks.useRoom(props.roomId, {}, "joinById", game)
      return null
    }
    await render(
      React.createElement(
        hooks.BungohanProvider,
        { client },
        React.createElement(Guest, { roomId: host.id }),
      ),
    )
    await act(() => h.flush())
    expect(current?.status).toBe("connected")
    expect(current?.room?.id).toBe(host.id)
    expect(current?.room?.state.players.size).toBe(2)
  })

  test("useBungohan outside a provider throws", async () => {
    let caught: unknown
    function Orphan() {
      try {
        hooks.useBungohan()
      } catch (error) {
        caught = error
      }
      return null
    }
    await render(React.createElement(Orphan))
    expect(String(caught)).toContain("BungohanProvider")
  })
})

describe("useRoomState", () => {
  test("with a selector, re-renders only when the selected value changes", async () => {
    const me = await joined(await h.connect())
    const other = await joined(await h.connect())
    await act(() => h.flushSync())

    let renders = 0
    let shown: number | undefined
    function MyX(props: { room: GameView }) {
      renders++
      shown = hooks.useRoomState(
        props.room,
        (s) => s.players.get(props.room.sessionId)?.x.get() ?? -1,
      )
      return null
    }
    await render(React.createElement(MyX, { room: me }))
    expect(renders).toBe(1)
    expect(shown).toBe(0)

    // Three patches that change state, but not the selected value.
    await move(me, other.sessionId, 1)
    await move(me, other.sessionId, 1)
    await move(me, other.sessionId, 1)
    expect(me.state.players.get(other.sessionId)?.x.get()).toBe(3)
    expect(renders).toBe(1)

    // One that does: exactly one more render.
    await move(me, me.sessionId, 2.5)
    expect(shown).toBe(2.5)
    expect(renders).toBe(2)
  })

  test("a selector returning a fresh array re-renders only on a shallow change", async () => {
    const me = await joined(await h.connect())
    let renders = 0
    let ids: string[] | undefined
    function Players(props: { room: GameView }) {
      renders++
      ids = hooks.useRoomState(props.room, (s) => [...s.players.keys()].sort())
      return null
    }
    await render(React.createElement(Players, { room: me }))
    await move(me, me.sessionId, 1) // same keys, new array each time
    expect(renders).toBe(1)

    let other = ""
    await act(async () => {
      other = (await joined(await h.connect())).sessionId
      await h.flushSync()
    })
    expect(renders).toBe(2)
    expect(ids).toEqual([me.sessionId, other].sort())
  })

  test("an equality function decides when a selection changed", async () => {
    const me = await joined(await h.connect())
    const other = await joined(await h.connect())
    await act(() => h.flushSync())
    let renders = 0
    type Row = { id: string; x: number }
    let rows: Row[] | undefined
    const sameRows = (a: Row[], b: Row[]) =>
      a.length === b.length &&
      a.every((row, i) => row.id === b[i]?.id && row.x === b[i]?.x)
    function Board(props: { room: GameView }) {
      renders++
      rows = hooks.useRoomState(
        props.room,
        (s) => [...s.players].map(([id, p]) => ({ id, x: p.x.get() })),
        sameRows,
      )
      return null
    }
    await render(React.createElement(Board, { room: me }))
    expect(renders).toBe(1)
    // A patch that leaves every row equal (fresh objects, same values).
    serverRoom(me).game.turn.set(1)
    await act(() => h.flushSync())
    expect(renders).toBe(1)
    await move(me, other.sessionId, 2)
    expect(renders).toBe(2)
    expect(rows?.find((row) => row.id === other.sessionId)?.x).toBe(2)
  })

  test("without a selector, re-renders on every applied state frame", async () => {
    const me = await joined(await h.connect())
    let renders = 0
    function Whole(props: { room: GameView }) {
      renders++
      hooks.useRoomState(props.room)
      return null
    }
    await render(React.createElement(Whole, { room: me }))
    await move(me, me.sessionId, 1)
    await move(me, me.sessionId, 1)
    expect(renders).toBe(3)
  })

  test("follows a replica reset (mid-game snapshot)", async () => {
    const me = await joined(await h.connect())
    let count: number | undefined
    function Count(props: { room: GameView }) {
      count = hooks.useRoomState(props.room, (s) => s.players.size)
      return null
    }
    await render(React.createElement(Count, { room: me }))
    expect(count).toBe(1)
    serverRoom(me).state = new GameState()
    await act(() => h.flushSync())
    expect(count).toBe(0)
  })
})

describe("useRoomMessage", () => {
  test("delivers typed messages with the latest callback", async () => {
    const me = await joined(await h.connect())
    const heard: string[] = []
    function Chat(props: { room: GameView; prefix: string }) {
      hooks.useRoomMessage(props.room, "said", ({ text }) => {
        heard.push(`${props.prefix}${text}`)
      })
      return null
    }
    await render(React.createElement(Chat, { room: me, prefix: "a:" }))
    me.send("say", { text: "one" })
    await act(() => h.flush())
    const r = root
    if (r === undefined) throw new Error("no root")
    await React.act(async () =>
      r.render(React.createElement(Chat, { room: me, prefix: "b:" })),
    )
    me.send("say", { text: "two" })
    await act(() => h.flush())
    expect(heard).toEqual(["a:one", "b:two"])
  })

  test("gets a message sent during the join, subscribed from an effect", async () => {
    const client = await h.connect()
    const welcomes: number[] = []
    function Game() {
      const { room } = hooks.useRoom("game", {}, "joinOrCreate", game)
      hooks.useRoomMessage(room, "welcome", ({ players }) =>
        welcomes.push(players),
      )
      return null
    }
    await render(
      React.createElement(
        hooks.BungohanProvider,
        { client },
        React.createElement(Game),
      ),
    )
    await act(() => h.flush())
    await act(() => h.flush())
    expect(welcomes).toEqual([1])
  })
})
