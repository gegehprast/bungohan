/**
 * @bungohan/testing, installed from its tarball: a real server and real
 * client-js clients in one process on a manual clock.
 */
import { expect, test } from "bun:test"
import { createTestHarness } from "@bungohan/testing"
import { CounterRoom } from "./room"
import { CounterState, counterContract } from "./shared"

const join = { state: CounterState, contract: counterContract }

test("two clients share one room's state", async () => {
  const harness = await createTestHarness({
    rooms: { counter: CounterRoom },
    client: { pingInterval: 0, logger: { warn() {}, error() {} } },
  })
  try {
    const ada = (
      await (await harness.connect()).joinOrCreate("counter", undefined, join)
    ).unwrap()
    const bob = (
      await (await harness.connect()).joinOrCreate("counter", undefined, join)
    ).unwrap()

    ada.send("increment", { by: 2 })
    await harness.tick(50)

    expect(ada.state.count.get()).toBe(2)
    expect(bob.state.count.get()).toBe(2)
    expect(bob.state.players.size).toBe(2)
    // One @bungohan/state: the replica's class is the shared module's.
    expect(bob.state).toBeInstanceOf(CounterState)
  } finally {
    await harness.stop()
  }
})
