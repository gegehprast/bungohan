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
