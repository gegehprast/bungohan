import { err, ok, type Result } from "@bungohan/result"
import { reason, StoreError } from "./errors"

/** Serializes a value for storage; `undefined` has no JSON form. */
export function toJson(value: unknown): Result<string, StoreError> {
  try {
    const json = JSON.stringify(value)
    if (json !== undefined) return ok(json)
  } catch (error) {
    return err(
      new StoreError(
        "SERIALIZATION_FAILED",
        `value is not JSON-serializable: ${reason(error)}`,
      ),
    )
  }
  return err(
    new StoreError(
      "SERIALIZATION_FAILED",
      "cannot store undefined (use delete)",
    ),
  )
}

export function fromJson(
  key: string,
  json: string,
): Result<unknown, StoreError> {
  try {
    const value: unknown = JSON.parse(json)
    return ok(value)
  } catch (error) {
    return err(
      new StoreError(
        "SERIALIZATION_FAILED",
        `stored value of "${key}" is not JSON: ${reason(error)}`,
      ),
    )
  }
}

export function checkTtl(ttl: number | undefined): Result<void, StoreError> {
  if (ttl === undefined || (Number.isInteger(ttl) && ttl > 0)) {
    return ok(undefined)
  }
  return err(
    new StoreError(
      "INVALID_OPTIONS",
      `ttl must be a positive whole number of seconds, got ${ttl}`,
    ),
  )
}
