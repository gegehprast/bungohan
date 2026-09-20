/**
 * Bytes over a transport that only carries strings.
 *
 * Bun's `RedisClient` publishes a `string` and hands a subscriber a
 * `string`; its own typings say buffer subscriptions "are not yet
 * implemented", and `publish` rejects a `Uint8Array` or a `Buffer`
 * outright (`ERR_INVALID_ARG_TYPE`). So the bytes have to travel as a
 * string, and the only question is which one.
 *
 * **latin1 (one code unit per byte) is byte-exact and costs nothing**,
 * where base64 would cost a third more on every cluster message. Measured
 * on Bun 1.3.13 against a real Redis: all 256 byte values, sequences that
 * are valid UTF-8 (`c3 a9`, `e2 82 ac`) and 4 KB of random bytes all come
 * back with the same code points they went out with, so Bun decodes a
 * pub/sub payload as binary rather than as UTF-8.
 *
 * That last part is an implementation detail rather than a documented
 * guarantee, so `redis.integration.test.ts` pins it: it pushes all 256
 * byte values through a real Redis and compares. If Bun ever switches to
 * decoding pub/sub payloads as UTF-8, that test fails — and in the
 * meantime a corrupted payload would fail the receiving `ISerializer`'s
 * decode and be dropped with a log, not silently mis-read.
 */

/** Bytes as a latin1 string: one code unit per byte, no expansion. */
export function toBinaryString(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(
    "latin1",
  )
}

/**
 * The bytes of a latin1 string. A code unit above `0xff` (a publisher that
 * put real text on the channel) keeps only its low byte, which the
 * receiver's decode then rejects.
 */
export function fromBinaryString(text: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(Buffer.from(text, "latin1"))
}
