/**
 * What an app needs from client-js alone, without depending on the
 * packages it is built from.
 */
import { expect, test } from "bun:test"
import * as result from "@bungohan/result"
import * as state from "@bungohan/state"
import * as types from "@bungohan/types"
import * as client from "./index"

test("re-exports SchemaRegistry, LeaveCode and the Result helpers", () => {
  expect(client.SchemaRegistry).toBe(state.SchemaRegistry)
  expect(client.LeaveCode).toBe(types.LeaveCode)
  expect(client.ok).toBe(result.ok)
  expect(client.err).toBe(result.err)
  expect(client.Ok).toBe(result.Ok)
  expect(client.Err).toBe(result.Err)
  expect(client.tryCatch).toBe(result.tryCatch)
  expect(client.tryCatchAsync).toBe(result.tryCatchAsync)
  const typed: client.Result<number, Error> = client.ok(1)
  expect(typed.isOk()).toBe(true)
})

test("re-exports what a shared state and contract module needs", () => {
  // A module imported by both server and browser builds its schema and
  // contract from client-js alone (core would pull the server into the
  // browser bundle). Same objects as the underlying packages, so the
  // server's re-exports and these are interchangeable.
  expect(client.Schema).toBe(state.Schema)
  const factories: [unknown, unknown][] = [
    [client.createArray, state.createArray],
    [client.createBoolean, state.createBoolean],
    [client.createFiltered, state.createFiltered],
    [client.createFixedPoint, state.createFixedPoint],
    [client.createFloat32, state.createFloat32],
    [client.createInt, state.createInt],
    [client.createMap, state.createMap],
    [client.createNumber, state.createNumber],
    [client.createSchemaArray, state.createSchemaArray],
    [client.createSchemaMap, state.createSchemaMap],
    [client.createSchemaSet, state.createSchemaSet],
    [client.createSet, state.createSet],
    [client.createString, state.createString],
  ]
  for (const [ours, theirs] of factories) expect(ours).toBe(theirs)
  expect(client.f).toBe(types.f)
  expect(client.defineMessage).toBe(types.defineMessage)
  expect(client.defineContract).toBe(types.defineContract)

  // And the types that go with them.
  const Hello = client.defineMessage("hello", { name: client.f.string })
  const contract = client.defineContract({
    client: { hello: Hello },
    server: {},
    options: { join: Hello },
  })
  const hello: client.Infer<typeof Hello> = { name: "Ada" }
  const join: client.InferJoinOptions<typeof contract> = hello
  const create: client.InferCreateOptions<typeof contract> = {}
  const arg: client.CreateArg<typeof contract> = join // no create options
  const reservation: client.Reservation | undefined = undefined
  const typed: client.Contract = contract
  expect([create, arg, reservation, typed.client]).toBeDefined()
})
