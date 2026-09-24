/**
 * The room's serial queue: `serial(task)` and `onMessage(…, { serial })`.
 * Each task starts only after every earlier one has finished.
 */
import { expect, test } from "bun:test"
import type { Client, ErrorContext } from "@bungohan/core"
import { Room } from "@bungohan/core"
import { defineContract, defineMessage, f } from "@bungohan/types"
import { createServerHarness } from "../harness"

const Act = defineMessage("act", { n: f.uint8 })
const contract = defineContract({ client: { act: Act }, server: {} })

/** What ran, in order; `start n`/`end n` bracket each handler. */
const log: string[] = []

class QueueRoom extends Room<never, typeof contract> {
  public static override contract = contract
  public static serialHandlers = true

  protected override async onCreate(): Promise<void> {
    this.onMessage(
      "act",
      async (_client: Client, { n }) => {
        log.push(`start ${n}`)
        if (n === 9) throw new Error("bad act")
        // The first one waits on the clock, so a later one would overtake it.
        await this.wait(n === 1 ? 100 : 10)
        log.push(`end ${n}`)
      },
      { serial: QueueRoom.serialHandlers },
    )
  }

  public queueTimer(): void {
    this.clock.setTimeout(() => {
      void this.serial(() => log.push("timer"))
    }, 50)
  }

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => this.clock.setTimeout(resolve, ms))
  }
}

async function setup(serialHandlers = true) {
  log.length = 0
  QueueRoom.serialHandlers = serialHandlers
  const h = await createServerHarness({
    define: (s) => s.defineRoomType("queue", QueueRoom),
  })
  const errors: [Error, ErrorContext][] = []
  h.server.onError((error, context) => errors.push([error, context]))
  const a = (await h.connect().create("queue", {}, { contract })).unwrap()
  const b = (await h.connect().joinById(a.roomId, {}, { contract })).unwrap()
  const room = h.server.getMatchMaker().getRoom(a.roomId)
  if (!(room instanceof QueueRoom)) throw new Error("no room")
  return { h, a, b, room, errors }
}

test("serial handlers run one at a time, in arrival order, across clients", async () => {
  const { h, a, b } = await setup()
  a.send("act", { n: 1 })
  b.send("act", { n: 2 })
  await h.flush()
  await h.tick(200)
  expect(log).toEqual(["start 1", "end 1", "start 2", "end 2"])
  await h.stop()
})

test("without serial, a slow handler is overtaken", async () => {
  const { h, a, b } = await setup(false)
  a.send("act", { n: 1 })
  b.send("act", { n: 2 })
  await h.flush()
  await h.tick(200)
  expect(log).toEqual(["start 1", "start 2", "end 2", "end 1"])
  await h.stop()
})

test("a timer's task waits for the task in progress", async () => {
  const { h, a, room } = await setup()
  a.send("act", { n: 1 })
  await h.flush()
  room.queueTimer() // due at 50 ms, while act 1 runs until 100 ms
  await h.tick(200)
  expect(log).toEqual(["start 1", "end 1", "timer"])
  await h.stop()
})

test("a throw is reported and the queue carries on", async () => {
  const { h, a, errors } = await setup()
  a.send("act", { n: 9 })
  a.send("act", { n: 2 })
  await h.flush()
  await h.tick(50)
  expect(log).toEqual(["start 9", "start 2", "end 2"])
  expect(errors.map(([e, c]) => [e.message, c.source, c.messageType])).toEqual([
    ["bad act", "onMessage", "act"],
  ])
  await h.stop()
})

test("tasks that haven't started when the room disposes are dropped", async () => {
  const { h, a, b, room } = await setup()
  a.send("act", { n: 1 })
  b.send("act", { n: 2 })
  await h.flush()
  void room.dispose()
  await h.tick(200)
  expect(log).toEqual(["start 1", "end 1"])
  await h.stop()
})
