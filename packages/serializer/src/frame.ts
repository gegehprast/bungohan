/**
 * Frame codec (spec §6.7.1): `type:u8`, then a fixed number of unsigned
 * LEB128 header varints for that type, then the body (the rest of the
 * frame). Language-neutral and independent of the body's serializer, so a
 * state frame carries its codec bytes with no second encoding layer.
 *
 * Browser-safe: no Bun/Node APIs (client-js uses this too).
 */
import { err, ok, type Result } from "@bungohan/result"
import { SerializerError } from "./errors"

/** Largest header value: varints are at most 5 bytes / 32 bits. */
const MAX_VARINT = 0xffffffff

/** Bytes `value` takes as a varint. */
export function varintSize(value: number): number {
  let size = 1
  let rest = value
  while (rest >= 0x80) {
    rest = Math.floor(rest / 0x80)
    size++
  }
  return size
}

/**
 * Writes `value` (an integer in `0..0xFFFFFFFF`) at `offset`; returns the
 * offset after it. Uses division, not bit shifts, so values ≥ 2^31 work.
 */
export function writeVarint(
  out: Uint8Array,
  offset: number,
  value: number,
): number {
  let rest = value
  let at = offset
  while (rest >= 0x80) {
    out[at++] = (rest % 0x80) | 0x80
    rest = Math.floor(rest / 0x80)
  }
  out[at++] = rest
  return at
}

/**
 * Reads a varint at `offset`: `[value, nextOffset]`, or `undefined` if it is
 * truncated, longer than 5 bytes or above `0xFFFFFFFF`.
 */
export function readVarint(
  data: Uint8Array,
  offset: number,
): [value: number, next: number] | undefined {
  let value = 0
  let scale = 1
  for (let i = 0; i < 5; i++) {
    const byte = data[offset + i]
    if (byte === undefined) return undefined
    value += (byte & 0x7f) * scale
    if ((byte & 0x80) === 0) {
      return value > MAX_VARINT ? undefined : [value, offset + i + 1]
    }
    scale *= 0x80
  }
  return undefined
}

/** A parsed frame. `body` is a view into the frame's bytes (no copy). */
export interface Frame {
  readonly type: number
  readonly header: readonly number[]
  readonly body: Uint8Array
}

function isHeaderValue(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= MAX_VARINT
}

/**
 * Builds a frame. Fails (`ENCODE_FAILED`) only for a type outside `0..255`
 * or a header value that isn't an integer in `0..0xFFFFFFFF`.
 */
export function encodeFrame(
  type: number,
  header: readonly number[],
  body?: Uint8Array,
): Result<Uint8Array, SerializerError> {
  if (!Number.isInteger(type) || type < 0 || type > 255) {
    return err(new SerializerError("ENCODE_FAILED", `bad frame type ${type}`))
  }
  let size = 1 + (body?.byteLength ?? 0)
  for (const value of header) {
    if (!isHeaderValue(value)) {
      return err(
        new SerializerError("ENCODE_FAILED", `bad header value ${value}`),
      )
    }
    size += varintSize(value)
  }
  const out = new Uint8Array(size)
  out[0] = type
  let at = 1
  for (const value of header) at = writeVarint(out, at, value)
  if (body !== undefined) out.set(body, at)
  return ok(out)
}

/**
 * Parses a frame. `headerCount` maps a frame type to its number of header
 * varints (`CLIENT_FRAME_HEADERS` / `SERVER_FRAME_HEADERS` from
 * `@bungohan/types`); an unknown type or a bad header is `DECODE_FAILED`.
 */
export function decodeFrame(
  data: Uint8Array,
  headerCount: Readonly<Record<number, number>>,
): Result<Frame, SerializerError> {
  const type = data[0]
  if (type === undefined) {
    return err(new SerializerError("DECODE_FAILED", "empty frame"))
  }
  const count = headerCount[type]
  if (count === undefined) {
    return err(new SerializerError("DECODE_FAILED", `unknown frame ${type}`))
  }
  const header: number[] = []
  let at = 1
  for (let i = 0; i < count; i++) {
    const read = readVarint(data, at)
    if (read === undefined) {
      return err(new SerializerError("DECODE_FAILED", "bad frame header"))
    }
    header.push(read[0])
    at = read[1]
  }
  return ok({ type, header, body: data.subarray(at) })
}
