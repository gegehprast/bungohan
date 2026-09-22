/**
 * The React examples, rendered with react-dom into a happy-dom document
 * against a real server and client.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test"
import type { BungohanClient } from "@bungohan/client-js"
import { createTestHarness, type TestHarness } from "@bungohan/testing"
import { ArenaRoom } from "@bungohan/tutorial-server/ArenaRoom"
import { GlobalRegistrator } from "@happy-dom/global-registrator"

type ReactModule = typeof import("react")
type DomModule = typeof import("react-dom/client")
type Examples = typeof import("./react")

let React: ReactModule
let ReactDOM: DomModule
let examples: Examples
let provider: typeof import("@bungohan/client-js/react").BungohanProvider

beforeAll(async () => {
  // react-dom needs a document, and must see it when it loads.
  GlobalRegistrator.register()
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)
  React = await import("react")
  ReactDOM = await import("react-dom/client")
  examples = await import("./react")
  provider = (await import("@bungohan/client-js/react")).BungohanProvider
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

let h: TestHarness
let created: number
let root: import("react-dom/client").Root | undefined

beforeEach(async () => {
  h = await createTestHarness({
    rooms: { arena: ArenaRoom },
    client: { pingInterval: 0, logger: { warn() {}, error() {} } },
  })
  created = 0
  h.server.getRoomManager().onRoomCreated(() => created++)
})

afterEach(async () => {
  const current = root
  if (current !== undefined) await React.act(async () => current.unmount())
  root = undefined
  await h.stop()
})

async function render(client: BungohanClient, element: React.ReactElement) {
  const container = document.createElement("div")
  const r = ReactDOM.createRoot(container)
  root = r
  const tree = React.createElement(
    React.StrictMode,
    null,
    React.createElement(provider, { client }, element),
  )
  await React.act(async () => r.render(tree))
  await React.act(() => h.tick(50))
  return container
}

test("StrictMode + useRoom('create') creates two rooms", async () => {
  const client = await h.connect()
  const container = await render(
    client,
    React.createElement(examples.CreateOnMount, { name: "Ada" }),
  )
  expect(container.textContent).toBe("connected")
  expect(created).toBe(2)
  // The first seat was given back, so its empty room disposed itself.
  expect(h.server.getMatchMaker().getRoomCount()).toBe(1)
})

test("creating from an event creates one room", async () => {
  const client = await h.connect()
  const container = await render(
    client,
    React.createElement(examples.CreateOnClick, { name: "Ada" }),
  )
  const button = container.querySelector("button")
  if (button === null) throw new Error("no button")
  await React.act(async () => button.click())
  await React.act(() => h.tick(50))
  expect(created).toBe(1)
  expect(container.textContent).toContain("1 players (Ada), 5 gems")
})
