import { describe, expect, spyOn, test } from "bun:test"
import { createNumber, Schema } from "@bungohan/state"
import { defineContract, defineMessage, f } from "@bungohan/types"
import { Client } from "./client"
import { SystemClock } from "./clock"
import { Room } from "./room"

class S extends Schema {
  public static override schemaName = "Unit.S"
  public n = createNumber()
}

const Ping = defineMessage("ping", { n: f.uint8 })
const contract = defineContract({ client: {}, server: { ping: Ping } })

class Standalone extends Room<S, typeof contract> {
  public static override contract = contract
  public override state = new S()
}

describe("a room no server set up", () => {
  test("never throws; it reports and drops", async () => {
    const error = spyOn(console, "error").mockImplementation(() => {})
    const room = new Standalone()
    const client = new Client("c1")
    expect(() => room.broadcastMessage("ping", { n: 1 })).not.toThrow()
    expect(() => room.disconnectClient(client)).not.toThrow()
    const left = await room.leave(client)
    expect(left.isErr() && left.error.code).toBe("CLIENT_NOT_FOUND")
    expect(room.getClientCount()).toBe(0)
    error.mockRestore()
  })
})

describe("SystemClock", () => {
  test("epoch milliseconds, timers with numeric ids", async () => {
    const clock = new SystemClock()
    expect(Math.abs(clock.now() - Date.now())).toBeLessThan(50)
    const fired = await new Promise<boolean>((resolve) => {
      clock.setTimeout(() => resolve(true), 1)
    })
    expect(fired).toBe(true)
    let runs = 0
    const id = clock.setInterval(() => runs++, 1)
    clock.clearInterval(id)
    const cancelled = clock.setTimeout(() => runs++, 1)
    clock.clearTimeout(cancelled)
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(runs).toBe(0)
  })
})
