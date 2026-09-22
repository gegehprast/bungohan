/**
 * What a room file, and the server setup around it, needs from core alone,
 * without depending on the packages core is built from.
 */
import { expect, test } from "bun:test"
import * as state from "@bungohan/state"
import * as store from "@bungohan/store"
import * as types from "@bungohan/types"
import * as core from "./index"

test("re-exports the schema, contract and option building blocks", () => {
  expect(core.Schema).toBe(state.Schema)
  expect(core.SchemaRegistry).toBe(state.SchemaRegistry)
  const factories: [unknown, unknown][] = [
    [core.createArray, state.createArray],
    [core.createBoolean, state.createBoolean],
    [core.createFiltered, state.createFiltered],
    [core.createFixedPoint, state.createFixedPoint],
    [core.createFloat32, state.createFloat32],
    [core.createInt, state.createInt],
    [core.createMap, state.createMap],
    [core.createNumber, state.createNumber],
    [core.createSchemaArray, state.createSchemaArray],
    [core.createSchemaMap, state.createSchemaMap],
    [core.createSchemaSet, state.createSchemaSet],
    [core.createSet, state.createSet],
    [core.createString, state.createString],
  ]
  for (const [ours, theirs] of factories) expect(ours).toBe(theirs)
  expect(core.f).toBe(types.f)
  expect(core.defineMessage).toBe(types.defineMessage)
  expect(core.defineContract).toBe(types.defineContract)
  expect(core.LeaveCode).toBe(types.LeaveCode)
  expect(core.MemoryStore).toBe(store.MemoryStore)
})

test("re-exports the types a room's hooks and options are written with", () => {
  const Hello = core.defineMessage("hello", { name: core.f.string })
  const contract = core.defineContract({
    client: { hello: Hello },
    server: {},
    options: { create: Hello, join: Hello },
  })
  const hello: core.Infer<typeof Hello> = { name: "Ada" }
  const join: core.InferJoinOptions<typeof contract> = hello
  const create: core.InferCreateOptions<typeof contract> = hello
  const arg: core.CreateArg<typeof contract> = { create, join }
  const context: core.ConnectionContext = {
    ip: "127.0.0.1",
    searchParams: new URLSearchParams(),
    headers: new Headers(),
  }
  const timer: core.TimerId | undefined = undefined
  const reservation: core.Reservation | undefined = undefined
  const provider: core.IStore = new core.MemoryStore()
  const typed: core.Contract = contract
  expect([arg, context, timer, reservation, provider, typed]).toBeDefined()
})
