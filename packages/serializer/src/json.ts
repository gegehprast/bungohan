import { err, ok, type Result } from "@bungohan/result"
import { reason, SerializerError } from "./errors"
import type { ISerializer } from "./serializer"

interface WrappedBytes {
  __type: "Uint8Array"
  data: number[]
}

function isWrappedBytes(value: unknown): value is WrappedBytes {
  if (typeof value !== "object" || value === null) return false
  const data: unknown = Reflect.get(value, "data")
  return (
    Reflect.get(value, "__type") === "Uint8Array" &&
    Array.isArray(data) &&
    data.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
  )
}

function replacer(_key: string, value: unknown): unknown {
  return value instanceof Uint8Array
    ? { __type: "Uint8Array", data: Array.from(value) }
    : value
}

function reviver(_key: string, value: unknown): unknown {
  return isWrappedBytes(value) ? new Uint8Array(value.data) : value
}

/**
 * JSON serializer. **Debug/dev only**: readable in browser devtools, but
 * several times larger than MessagePack and lossy for non-JSON numbers
 * (`NaN`/`Infinity` become `null`). `Uint8Array`s round-trip as
 * `{ __type: "Uint8Array", data: [...] }`. A top-level `undefined` encodes as
 * `null`, matching MessagePack's `nil`.
 */
export class JsonSerializer implements ISerializer {
  private readonly _encoder = new TextEncoder()
  private readonly _decoder = new TextDecoder("utf-8", { fatal: true })

  public encode(message: unknown): Result<Uint8Array, SerializerError> {
    try {
      const json = JSON.stringify(message, replacer) ?? "null"
      return ok(this._encoder.encode(json))
    } catch (error) {
      return err(
        new SerializerError(
          "ENCODE_FAILED",
          `JSON encode failed: ${reason(error)}`,
        ),
      )
    }
  }

  public decode(data: Uint8Array): Result<unknown, SerializerError> {
    try {
      const parsed: unknown = JSON.parse(this._decoder.decode(data), reviver)
      return ok(parsed)
    } catch (error) {
      return err(
        new SerializerError(
          "DECODE_FAILED",
          `JSON decode failed: ${reason(error)}`,
        ),
      )
    }
  }

  public getName(): string {
    return "json"
  }
}
