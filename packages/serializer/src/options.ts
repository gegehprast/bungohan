/**
 * Typed join and create options (PROTOCOL.md §6.2.1). On the wire they are
 * a MessagePack `bin` holding a `schema` contract message (§13.1.6),
 * whatever the room's codec, or `null` for zero bytes. Shared by the server
 * (decoding, and converting options it builds itself) and the clients
 * (encoding).
 */
import { err, ok, type Result } from "@bungohan/result"
import type { MessageDef } from "@bungohan/types"
import { SerializerError } from "./errors"
import { SchemaCodec } from "./schema-codec"

const schema = new SchemaCodec()
const EMPTY = new Uint8Array(0)

/**
 * The `JOIN` element for typed options: the encoded message, or `null`
 * when it encodes to zero bytes (the canonical form). A payload that got
 * past the types is `ENCODE_FAILED`.
 */
export function encodeOptions(
  def: MessageDef,
  payload: unknown,
): Result<Uint8Array | null, SerializerError> {
  const encoded = schema.encodeMessage(def, payload ?? {})
  if (encoded.isErr()) return encoded
  return ok(encoded.value.length === 0 ? null : encoded.value)
}

/**
 * Decodes a typed options element exactly: `bin` bytes, or `null`/absent
 * as zero bytes. Anything else (a MessagePack map from an untyped client)
 * and bytes that don't decode are `DECODE_FAILED`.
 */
export function decodeOptions(
  def: MessageDef,
  element: unknown,
): Result<Record<string, unknown>, SerializerError> {
  let bytes: Uint8Array
  if (element === null || element === undefined) bytes = EMPTY
  else if (element instanceof Uint8Array) bytes = element
  else {
    return err(
      new SerializerError(
        "DECODE_FAILED",
        `${def.name}: typed options must be bin or null`,
      ),
    )
  }
  const decoded = schema.decodeMessage(def, bytes)
  if (decoded.isErr()) return decoded
  // A decoded message is always a plain object of its fields.
  const value: Record<string, unknown> = decoded.value
  return ok(value)
}
