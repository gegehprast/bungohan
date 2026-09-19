import { err, ok, type Result } from "@bungohan/result"
import { Decoder, Encoder } from "@msgpack/msgpack"
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
      return ok(this._encoder.encode(message))
    } catch (error) {
      return err(
        new SerializerError(
          "ENCODE_FAILED",
          `MessagePack encode failed: ${reason(error)}`,
        ),
      )
    }
  }

  /** Rejects truncated input, trailing bytes and `__proto__` keys. */
  public decode(data: Uint8Array): Result<unknown, SerializerError> {
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
