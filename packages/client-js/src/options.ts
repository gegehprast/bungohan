/**
 * The `JOIN` body (PROTOCOL.md §6.2), with typed options when the contract
 * declares them (§6.2.1): each a `bin` of a `schema`-encoded message, or
 * `null` for zero bytes.
 */
import { err, ok, type Result } from "@bungohan/result"
import { encodeOptions } from "@bungohan/serializer"
import {
  type Contract,
  JoinMode,
  type MessageDef,
  optionsDef,
} from "@bungohan/types"
import { ClientError } from "./errors"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function encode(
  def: MessageDef,
  payload: unknown,
  kind: string,
): Result<Uint8Array | null, ClientError> {
  const encoded = encodeOptions(def, payload)
  return encoded.isErr()
    ? err(
        new ClientError(
          "ENCODE_FAILED",
          `${kind} options: ${encoded.error.message}`,
        ),
      )
    : ok(encoded.value)
}

/**
 * The elements of a `JOIN` body. `options` is what the caller passed:
 * untyped, anything; typed, the join options, or `{ create, join }` in
 * the creating modes when the contract declares create options.
 */
export function joinBody(
  mode: number,
  target: string,
  options: unknown,
  hash: string | null,
  contract: Contract | undefined,
): Result<unknown[], ClientError> {
  const joinDef = optionsDef(contract, "join")
  const createDef = optionsDef(contract, "create")
  const creates = mode === JoinMode.JOIN_OR_CREATE || mode === JoinMode.CREATE
  const reads =
    creates || mode === JoinMode.JOIN || mode === JoinMode.JOIN_BY_ID
  if (joinDef === undefined || createDef === undefined || !reads) {
    return ok([mode, target, options ?? null, hash])
  }
  let joinPayload = options
  let createPayload: unknown = {}
  if (creates && contract?.options?.create !== undefined) {
    if (!isRecord(options)) {
      return err(
        new ClientError(
          "ENCODE_FAILED",
          "options must be { create, join } when the contract declares " +
            "create options",
        ),
      )
    }
    joinPayload = options["join"]
    createPayload = options["create"]
  }
  const join = encode(joinDef, joinPayload, "join")
  if (join.isErr()) return join
  if (!creates) return ok([mode, target, join.value, hash, null])
  const create = encode(createDef, createPayload, "create")
  if (create.isErr()) return create
  return ok([mode, target, join.value, hash, create.value])
}
