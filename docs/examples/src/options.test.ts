import { afterEach, expect, spyOn, test } from "bun:test"
import { createTestHarness, type TestHarness } from "@bungohan/testing"
import { openRace, RaceRoom, SandboxRoom } from "./options"
import { hostRace, joinRace } from "./options.client"

let h: TestHarness | undefined

afterEach(async () => {
  await h?.stop()
  h = undefined
})

test("typed create and join options from a client", async () => {
  h = await createTestHarness({ rooms: { race: RaceRoom } })
  const log = spyOn(console, "log").mockImplementation(() => {})
  const host = (await hostRace(await h.connect(), "Ada")).unwrap()
  const rival = (await joinRace(await h.connect(), host.id, "Rival")).unwrap()
  await h.tick(50)
  expect(rival.state.track.get()).toBe("oval")
  expect(rival.state.laps.get()).toBe(5)
  expect(rival.state.drivers.get()).toBe(2)
  expect(log).toHaveBeenCalledWith("Rival: red")
  log.mockRestore()
})

test("server-built options go through the same declaration", async () => {
  h = await createTestHarness({ rooms: { race: RaceRoom } })
  const room = (await openRace(h.server)).unwrap()
  expect(room).toBeInstanceOf(RaceRoom)
  expect(h.stateOf(RaceRoom, room).track.get()).toBe("canyon")
})

test("untyped options arrive as sent", async () => {
  h = await createTestHarness({ rooms: { sandbox: SandboxRoom } })
  const client = await h.connect()
  const joined = await client.create("sandbox", { mode: "chaos" })
  const room = h.server.getMatchMaker().getRoom(joined.unwrap().id)
  expect(room instanceof SandboxRoom && room.mode).toBe("chaos")
})
