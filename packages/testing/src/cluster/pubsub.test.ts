/**
 * Application pub/sub over the backplane: `server.publish` reaches every
 * process's `subscribe` handlers, the publisher's own included.
 */
import { expect, test } from "bun:test"
import type { ErrorContext } from "@bungohan/core"
import { createClusterHarness } from "../cluster"
import { createServerHarness } from "../harness"

test("a message published on one process reaches every process", async () => {
  const c = await createClusterHarness({ size: 3 })
  const got: [number, unknown, string][] = []
  for (const [index, node] of c.nodes.entries()) {
    node.server.subscribe("events", (message, from) => {
      got.push([index, message, from])
    })
    node.server.subscribe("other", () => got.push([index, "wrong", ""]))
  }
  const from = c.node(1).server.getMatchMaker().getProcessId()
  c.node(1)
    .server.publish("events", { opened: "a", ids: [1, 2] })
    .unwrap()
  expect(got).toEqual([]) // never inside publish()
  await c.flush()
  const message = { opened: "a", ids: [1, 2] }
  expect(got.sort()).toEqual([
    [0, message, from],
    [1, message, from],
    [2, message, from],
  ])
  await c.stop()
})

test("without cluster mode, this process's handlers get a copy", async () => {
  const h = await createServerHarness()
  const sent = { at: 1 }
  const got: unknown[] = []
  const off = h.server.subscribe("ch", (message) => {
    got.push(message)
  })
  h.server.publish("ch", sent).unwrap()
  await h.flush()
  expect(got).toEqual([{ at: 1 }])
  expect(got[0]).not.toBe(sent)
  off()
  h.server.publish("ch", sent).unwrap()
  await h.flush()
  expect(got).toHaveLength(1)
  await h.stop()
})

test("a handler that throws is reported and the others still run", async () => {
  const h = await createServerHarness()
  const errors: ErrorContext[] = []
  h.server.onError((_error, context) => errors.push(context))
  const got: unknown[] = []
  h.server.subscribe("ch", () => {
    throw new Error("handler failed")
  })
  h.server.subscribe("ch", async (message) => {
    got.push(message)
  })
  h.server.publish("ch", 1).unwrap()
  await h.flush()
  expect(got).toEqual([1])
  expect(errors.map((context) => context.source)).toEqual(["callback"])
  await h.stop()
})
