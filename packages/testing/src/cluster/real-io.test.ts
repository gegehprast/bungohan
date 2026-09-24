/**
 * Join hooks awaiting real I/O in a cluster: `joinRealWait` holds the
 * shared clock for them, whether the test awaits the join directly or
 * through `cluster.run`.
 */
import { describe, expect, test } from "bun:test"
import { Room } from "@bungohan/core"
import { createClusterHarness } from "../cluster"

/** Both auth hooks wait on something that isn't the harness clock. */
class RemoteCheckRoom extends Room {
  protected static override async onAuth() {
    await Bun.sleep(20)
    return true
  }

  protected override async onAuth() {
    await Bun.sleep(20)
    return true
  }
}

async function cluster() {
  return createClusterHarness({
    size: 2,
    rooms: { checked: RemoteCheckRoom },
    joinRealWait: 2000,
  })
}

describe("joinRealWait in a cluster", () => {
  test("a join awaited directly completes", async () => {
    const c = await cluster()
    const joined = await (await c.connect(0)).joinOrCreate("checked")
    expect(joined.isOk()).toBe(true)
    await c.stop()
  })

  test("a join through cluster.run completes, into a room on another process too", async () => {
    const c = await cluster()
    const created = await c.run((await c.connect(0)).joinOrCreate("checked"))
    expect(created.isOk()).toBe(true)
    const there = c.node(1).server.getMatchMaker()
    const room = (await c.run(there.createRoom("checked"))).unwrap()
    const joined = await c.run((await c.connect(0)).joinById(room.id))
    expect(joined.isOk() && joined.value.id).toBe(room.id)
    await c.stop()
  })
})
