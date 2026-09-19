import { err, ok, type Result } from "@bungohan/result"
import { Decoder, Encoder } from "@msgpack/msgpack"
import { decodeUtf8, wireString } from "./bytes"
import { reason, SerializerError } from "./errors"
import type { ISerializer } from "./serializer"

/**
 * MessagePack serializer: the default for room messages and envelopes, and
 * the Phase 1 state codec's encoding (spec §8.1.1).
 *
 * One `Encoder`/`Decoder` pair lives per instance and is reused on every
 * call. `undefined` object properties are dropped (`ignoreUndefined`).
 *
 * `encode` returns a fresh `Uint8Array` that the caller owns: it is safe to
 * queue, retain, or hand to an async send. (`@msgpack/msgpack`'s `encode()`
 * copies out of its reused internal buffer; only `encodeSharedRef()`
 * aliases it, and this class never uses that.) Encode once and pass the same
 * array to `transport.broadcast()`; never re-encode per client.
 */
export class MessagePackSerializer implements ISerializer {
  private readonly _encoder = new Encoder({ ignoreUndefined: true })
  private readonly _decoder = new Decoder()

  public encode(message: unknown): Result<Uint8Array, SerializerError> {
    try {
      return ok(this._encoder.encode(wireStrings(message)))
    } catch (error) {
      return err(
        new SerializerError(
          "ENCODE_FAILED",
          `MessagePack encode failed: ${reason(error)}`,
        ),
      )
    }
  }

  /**
   * Rejects truncated input, trailing bytes, `__proto__` keys and strings
   * that aren't valid UTF-8 (PROTOCOL.md §4).
   */
  public decode(data: Uint8Array): Result<unknown, SerializerError> {
    if (!stringsAreUtf8(data)) {
      return err(
        new SerializerError(
          "DECODE_FAILED",
          "MessagePack decode failed: a string isn't valid UTF-8",
        ),
      )
    }
    try {
      return ok(this._decoder.decode(data))
    } catch (error) {
      return err(
        new SerializerError(
          "DECODE_FAILED",
          `MessagePack decode failed: ${reason(error)}`,
        ),
      )
    }
  }

  public getName(): string {
    return "messagepack"
  }
}

/**
 * `value` with every string (and map key) as the protocol holds it
 * (PROTOCOL.md §1.3, via {@link wireString}). `@msgpack/msgpack` writes a
 * lone surrogate in a short string as invalid UTF-8, and keeps U+0000.
 * Copies only what changes, so the common case allocates nothing.
 */
function wireStrings(value: unknown): unknown {
  if (typeof value === "string") return wireString(value)
  if (typeof value !== "object" || value === null) return value
  if (Array.isArray(value)) {
    let out: unknown[] | undefined
    for (let i = 0; i < value.length; i++) {
      const element: unknown = value[i]
      const fixed = wireStrings(element)
      if (fixed !== element) {
        out ??= [...value]
        out[i] = fixed
      }
    }
    return out ?? value
  }
  if (value instanceof Map) {
    let changed = false
    const entries: [unknown, unknown][] = []
    for (const [key, element] of value) {
      const fixedKey = wireStrings(key)
      const fixed = wireStrings(element)
      if (fixedKey !== key || fixed !== element) changed = true
      entries.push([fixedKey, fixed])
    }
    return changed ? new Map(entries) : value
  }
  const proto: unknown = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return value
  let out: Record<string, unknown> | undefined
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) {
    const element = record[key]
    const fixedKey = wireString(key)
    const fixed = wireStrings(element)
    if (fixedKey !== key || fixed !== element) {
      if (out === undefined) {
        out = {}
        // Rebuild in order, so entries keep their insertion order.
        for (const earlier of Object.keys(record)) {
          if (earlier === key) break
          out[earlier] = record[earlier]
        }
      }
    }
    if (out !== undefined) out[fixedKey] = fixed
  }
  return out ?? value
}

/** Byte length of a big-endian unsigned integer of `size` bytes at `at`. */
function readLength(data: Uint8Array, at: number, size: number): number {
  let value = 0
  for (let i = 0; i < size; i++) value = value * 256 + (data[at + i] ?? 0)
  return value
}

/**
 * Walks the MessagePack structure and checks every string with a strict
 * UTF-8 decoder. `@msgpack/msgpack` decodes invalid UTF-8 leniently (a lone
 * `ff` becomes "ÿ"), which the protocol forbids. Structural errors are left
 * to the real decoder: this returns true for anything it can't walk.
 */
function stringsAreUtf8(data: Uint8Array): boolean {
  let at = 0
  let pending = 1 // values still to read
  while (pending > 0 && at < data.length) {
    pending--
    const head = data[at++] ?? 0
    let strLength = -1
    if (head <= 0x7f || head >= 0xe0) continue // fixint
    if (head <= 0x8f) {
      pending += 2 * (head & 0x0f) // fixmap
      continue
    }
    if (head <= 0x9f) {
      pending += head & 0x0f // fixarray
      continue
    }
    if (head <= 0xbf)
      strLength = head & 0x1f // fixstr
    else {
      switch (head) {
        case 0xd9:
        case 0xda:
        case 0xdb: {
          const size = 1 << (head - 0xd9) // str 8/16/32
          strLength = readLength(data, at, size)
          at += size
          break
        }
        case 0xc4:
        case 0xc5:
        case 0xc6: {
          const size = 1 << (head - 0xc4) // bin 8/16/32
          at += size + readLength(data, at, size)
          break
        }
        case 0xc7:
        case 0xc8:
        case 0xc9: {
          const size = 1 << (head - 0xc7) // ext 8/16/32 (+ type byte)
          at += size + 1 + readLength(data, at, size)
          break
        }
        case 0xdc:
        case 0xdd: {
          const size = head === 0xdc ? 2 : 4 // array 16/32
          pending += readLength(data, at, size)
          at += size
          break
        }
        case 0xde:
        case 0xdf: {
          const size = head === 0xde ? 2 : 4 // map 16/32
          pending += 2 * readLength(data, at, size)
          at += size
          break
        }
        case 0xca:
          at += 4
          break
        case 0xcb:
          at += 8
          break
        case 0xcc:
        case 0xd0:
          at += 1
          break
        case 0xcd:
        case 0xd1:
          at += 2
          break
        case 0xce:
        case 0xd2:
          at += 4
          break
        case 0xcf:
        case 0xd3:
          at += 8
          break
        case 0xd4:
        case 0xd5:
        case 0xd6:
        case 0xd7:
        case 0xd8:
          at += 1 + (1 << (head - 0xd4)) // fixext (+ type byte)
          break
        default:
          break // nil, bool, 0xc1: nothing to skip
      }
    }
    if (strLength >= 0) {
      if (at + strLength > data.length) return true // truncated: decoder's job
      if (decodeUtf8(data.subarray(at, at + strLength)) === undefined) {
        return false
      }
      at += strLength
    }
  }
  return true
}
