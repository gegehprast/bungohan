import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import { createTestHarness, type TestHarness } from "@bungohan/testing"
import { redeemTicket, TableRoom, type Tickets, VipRoom } from "./authenticate"
import { fetchTicket } from "./authenticate.client"

let h: TestHarness
let issued: string[]
let log: ReturnType<typeof spyOn>
let fetchSpy: ReturnType<typeof spyOn>

/** A ticket store whose tickets each work once. */
function tickets(): Tickets {
  const owners = new Map<string, string>()
  let next = 0
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => {
    const ticket = `ticket-${++next}`
    owners.set(ticket, "ada")
    issued.push(ticket)
    return new Response(ticket)
  }) as unknown as typeof fetch)
  return {
    async redeem(ticket) {
      const owner = owners.get(ticket)
      owners.delete(ticket)
      return owner
    },
  }
}

beforeEach(async () => {
  issued = []
  log = spyOn(console, "log").mockImplementation(() => {})
  h = await createTestHarness({
    rooms: { table: TableRoom, vip: VipRoom },
    server: { authenticate: redeemTicket(tickets()) },
    client: { pingInterval: 0, logger: { warn() {}, error() {} } },
  })
})

afterEach(async () => {
  await h.stop()
  log.mockRestore()
  fetchSpy.mockRestore()
})

test("one ticket admits the connection to every room", async () => {
  const client = await h.connect({ token: fetchTicket })
  const table = (await client.joinOrCreate("table")).unwrap()
  const vip = (await client.joinOrCreate("vip")).unwrap()
  expect(issued).toEqual(["ticket-1"])
  expect(log).toHaveBeenCalledWith("ada sat down")

  // A dropped connection comes back with a fresh ticket and resumes.
  await h.dropConnection(client)
  await h.tick(1000)
  expect(issued).toEqual(["ticket-1", "ticket-2"])
  expect(table.status).toBe("joined")
  expect(vip.status).toBe("joined")
})

test("a spent or missing ticket is refused", async () => {
  const anonymous = await h.connect()
  const refused = await anonymous.joinOrCreate("table")
  expect(refused.isErr() && refused.error.code).toBe("AUTH_FAILED")

  VipRoom.vips.delete("ada")
  const client = await h.connect({ token: fetchTicket })
  const vip = await client.joinOrCreate("vip")
  expect(vip.isErr() && vip.error.code).toBe("AUTH_FAILED")
  VipRoom.vips.add("ada")
})
