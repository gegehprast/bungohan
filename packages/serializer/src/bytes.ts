/**
 * Byte-level primitives of PROTOCOL.md §1: varints, zigzag, UTF-8 strings,
 * little-endian IEEE 754 floats. Used by the `schema` codec.
 *
 * Browser-safe: no Bun/Node APIs (client-js uses this too).
 */

const MAX_UINT32 = 0xffffffff

const utf8Encoder = new TextEncoder()
// ignoreBOM keeps a leading U+FEFF as data; fatal rejects invalid UTF-8.
const utf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })

// biome-ignore lint/suspicious/noControlCharactersInRegex: U+0000 is matched on purpose (PROTOCOL.md §1.3)
const MAY_NEED_REPLACING = /[\u0000\ud800-\udfff]/
const NOT_SCALAR =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: as above
  /\u0000|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g

/**
 * `value` as the protocol's strings hold it (PROTOCOL.md §1.3): U+0000 and
 * lone surrogates become U+FFFD, so every client, whatever its engine's
 * strings can hold, decodes the same value.
 */
export function wireString(value: string): string {
  return MAY_NEED_REPLACING.test(value)
    ? value.replace(NOT_SCALAR, "\ufffd")
    : value
}

/** Zigzag-maps an int32 to a uint32 (PROTOCOL.md §1.2). */
export function zigzag(value: number): number {
  return ((value << 1) ^ (value >> 31)) >>> 0
}

/** Inverse of {@link zigzag}. */
export function unzigzag(value: number): number {
  return (value >>> 1) ^ -(value & 1)
}

/** Strict UTF-8 decode; `undefined` for invalid input. */
export function decodeUtf8(bytes: Uint8Array): string | undefined {
  // Short ASCII strings (names, keys, ids) skip the TextDecoder call.
  if (bytes.length <= 32) {
    let ascii = ""
    for (let i = 0; i < bytes.length; i++) {
      const byte = bytes[i] ?? 0
      if (byte >= 0x80) return decodeUtf8Slow(bytes)
      ascii += String.fromCharCode(byte)
    }
    return ascii
  }
  return decodeUtf8Slow(bytes)
}

function decodeUtf8Slow(bytes: Uint8Array): string | undefined {
  try {
    return utf8Decoder.decode(bytes)
  } catch {
    return undefined
  }
}

/** A growable output buffer. Reused across encodes by its owner. */
export class ByteWriter {
  private _bytes = new Uint8Array(256)
  private _view = new DataView(this._bytes.buffer)
  private _length = 0

  public get length(): number {
    return this._length
  }

  /** Discards the contents (keeps the allocation). */
  public reset(): void {
    this._length = 0
  }

  /** Cuts the contents back to `length` bytes. */
  public truncate(length: number): void {
    this._length = length
  }

  /** A copy of the contents, owned by the caller. */
  public toBytes(): Uint8Array<ArrayBuffer> {
    return this._bytes.slice(0, this._length)
  }

  /** Overwrites one already-written byte. */
  public patch(at: number, byte: number): void {
    this._bytes[at] = byte
  }

  public u8(byte: number): void {
    this._reserve(1)
    this._bytes[this._length++] = byte
  }

  /** Unsigned LEB128; `value` must be an integer in `0..0xFFFFFFFF`. */
  public varint(value: number): void {
    this._reserve(5)
    let rest = value
    while (rest >= 0x80) {
      this._bytes[this._length++] = (rest % 0x80) | 0x80
      rest = Math.floor(rest / 0x80)
    }
    this._bytes[this._length++] = rest
  }

  /** Zigzag varint of an int32. */
  public zigzag(value: number): void {
    this.varint(zigzag(value))
  }

  public float64(value: number): void {
    this._reserve(8)
    if (Number.isNaN(value)) {
      // The canonical quiet NaN, whatever payload the engine carries.
      this._view.setUint32(this._length, 0, true)
      this._view.setUint32(this._length + 4, 0x7ff80000, true)
    } else {
      this._view.setFloat64(this._length, value, true)
    }
    this._length += 8
  }

  public float32(value: number): void {
    this._reserve(4)
    if (Number.isNaN(value)) {
      this._view.setUint32(this._length, 0x7fc00000, true)
    } else {
      this._view.setFloat32(this._length, value, true)
    }
    this._length += 4
  }

  /**
   * Varint byte length, then UTF-8. U+0000 and lone surrogates become
   * U+FFFD (PROTOCOL.md §1.3).
   */
  public string(text: string): void {
    const value = wireString(text)
    // Worst case 3 bytes per UTF-16 unit, plus the length prefix.
    this._reserve(5 + value.length * 3)
    const start = this._length
    const lengthSize = value.length < 43 ? 1 : 5
    const { written } = utf8Encoder.encodeInto(
      value,
      this._bytes.subarray(start + lengthSize),
    )
    if (lengthSize === 1) {
      this._bytes[start] = written
      this._length = start + 1 + written
      return
    }
    // Long string: write the real length, then move the bytes down to it.
    const body = start + lengthSize
    this._length = start
    this.varint(written)
    this._bytes.copyWithin(this._length, body, body + written)
    this._length += written
  }

  private _reserve(extra: number): void {
    const needed = this._length + extra
    if (needed <= this._bytes.length) return
    let size = this._bytes.length * 2
    while (size < needed) size *= 2
    const grown = new Uint8Array(size)
    grown.set(this._bytes.subarray(0, this._length))
    this._bytes = grown
    this._view = new DataView(grown.buffer)
  }
}

/**
 * Reads PROTOCOL.md §1 primitives from a body. Errors are sticky: the first
 * failed read records a message in `error`, and every later read returns a
 * zero value, so a caller checks `error` once per op instead of per read.
 */
export class ByteReader {
  public error: string | undefined
  private readonly _bytes: Uint8Array
  private readonly _view: DataView
  private _pos = 0

  public constructor(bytes: Uint8Array) {
    this._bytes = bytes
    this._view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }

  public get pos(): number {
    return this._pos
  }

  /** Bytes left to read. */
  public get remaining(): number {
    return this._bytes.length - this._pos
  }

  public get done(): boolean {
    return this._pos >= this._bytes.length
  }

  /** Records a failure (the first one wins). */
  public fail(message: string): void {
    if (this.error === undefined) {
      this.error = `${message} (at byte ${this._pos})`
    }
    this._pos = this._bytes.length
  }

  public u8(): number {
    const byte = this._bytes[this._pos]
    if (byte === undefined) {
      this.fail("unexpected end of data")
      return 0
    }
    this._pos++
    return byte
  }

  /** Unsigned LEB128, at most 5 bytes, at most `0xFFFFFFFF`. */
  public varint(): number {
    let value = 0
    let scale = 1
    for (let i = 0; i < 5; i++) {
      const byte = this._bytes[this._pos]
      if (byte === undefined) {
        this.fail("truncated varint")
        return 0
      }
      this._pos++
      value += (byte & 0x7f) * scale
      if ((byte & 0x80) === 0) {
        if (value > MAX_UINT32) {
          this.fail("varint above 2^32-1")
          return 0
        }
        return value
      }
      scale *= 0x80
    }
    this.fail("varint longer than 5 bytes")
    return 0
  }

  /** A varint count or length, which can't exceed the bytes left. */
  public count(): number {
    const count = this.varint()
    if (count > this.remaining) {
      this.fail(`count ${count} exceeds the ${this.remaining} bytes left`)
      return 0
    }
    return count
  }

  public zigzag(): number {
    return unzigzag(this.varint())
  }

  public float64(): number {
    if (this.remaining < 8) {
      this.fail("truncated float64")
      return 0
    }
    const value = this._view.getFloat64(this._pos, true)
    this._pos += 8
    return value
  }

  public float32(): number {
    if (this.remaining < 4) {
      this.fail("truncated float32")
      return 0
    }
    const value = this._view.getFloat32(this._pos, true)
    this._pos += 4
    return value
  }

  public string(): string {
    const length = this.count()
    if (this.error !== undefined) return ""
    const text = decodeUtf8(this._bytes.subarray(this._pos, this._pos + length))
    if (text === undefined) {
      this.fail("invalid UTF-8")
      return ""
    }
    this._pos += length
    return text
  }
}
