/**
 * A successful result. Narrow a `Result` with `isOk()` and read `.value`.
 */
export class Ok<T> {
  /** Discriminant; lets `Ok<T> & Err<E>` reduce to `never` when narrowing. */
  public readonly ok = true as const
  /** The success value. Only reachable once narrowed to `Ok`. */
  public readonly value: T

  public constructor(value: T) {
    this.value = value
  }

  /** True here; narrows the `Result` to `Ok` so `.value` is readable. */
  public isOk(): this is Ok<T> {
    return true
  }

  /** False here; in an `else` branch the `Result` is narrowed to `Ok`. */
  public isErr(): this is Err<never> {
    return false
  }

  /**
   * The value. On an `Err` this throws, so prefer narrowing with `isOk()`
   * outside tests and prototypes.
   */
  public unwrap(): T {
    return this.value
  }

  /** The value; `fallback` is only returned by an `Err`. */
  public unwrapOr(_fallback: T): T {
    return this.value
  }

  /** A new `Ok` holding `fn(value)`. `fn` must not throw. */
  public map<U>(fn: (value: T) => U): Result<U, never> {
    return ok(fn(this.value))
  }

  /** This same `Ok`: only an `Err` is transformed. */
  public mapErr<F extends Error>(_fn: (error: never) => F): Result<T, F> {
    return this
  }

  /**
   * Chains a step that can fail: returns `fn(value)`, whose `Err` (if
   * any) becomes the result.
   */
  public andThen<U, F extends Error>(
    fn: (value: T) => Result<U, F>,
  ): Result<U, F> {
    return fn(this.value)
  }
}

/**
 * A failed result. Narrow a `Result` with `isErr()` and read `.error`.
 */
export class Err<E extends Error> {
  /** Discriminant; lets `Ok<T> & Err<E>` reduce to `never` when narrowing. */
  public readonly ok = false as const
  /** Why it failed. Only reachable once narrowed to `Err`. */
  public readonly error: E

  public constructor(error: E) {
    this.error = error
  }

  /** False here; in an `else` branch the `Result` is narrowed to `Err`. */
  public isOk(): this is Ok<never> {
    return false
  }

  /** True here; narrows the `Result` to `Err` so `.error` is readable. */
  public isErr(): this is Err<E> {
    return true
  }

  /** Throws the contained `error` itself (not a wrapper). */
  public unwrap(): never {
    throw this.error
  }

  /** Returns `fallback`, since there is no value. */
  public unwrapOr<T>(fallback: T): T {
    return fallback
  }

  /** This same `Err`: `fn` isn't called. */
  public map<U>(_fn: (value: never) => U): Result<U, E> {
    return this
  }

  /** A new `Err` holding `fn(error)`, e.g. to wrap it in your own type. */
  public mapErr<F extends Error>(fn: (error: E) => F): Result<never, F> {
    return err(fn(this.error))
  }

  /** This same `Err`: the chain stops here and `fn` isn't called. */
  public andThen<U, F extends Error>(
    _fn: (value: never) => Result<U, F>,
  ): Result<never, E | F> {
    return this
  }
}

/**
 * What every Bungohan operation that can fail returns, instead of
 * throwing: either `Ok` with a `value` or `Err` with an `error`. Narrow it
 * with `isOk()`/`isErr()` before reading either:
 *
 * ```ts
 * const joined = await client.joinOrCreate("lobby")
 * if (joined.isErr()) return console.warn(joined.error.code)
 * const room = joined.value
 * ```
 */
export type Result<T, E extends Error> = Ok<T> | Err<E>

/** Wraps a success value in a `Result`. */
export function ok<T>(value: T): Ok<T> {
  return new Ok(value)
}

/** Wraps an error in a failed `Result`. */
export function err<E extends Error>(error: E): Err<E> {
  return new Err(error)
}

/** Normalizes a thrown value into an `Error` instance. */
function toError(thrown: unknown): Error {
  return thrown instanceof Error ? thrown : new Error(String(thrown))
}

/**
 * Runs `fn`, capturing a throw as `Err`. Without an `errorHandler`, the thrown
 * value is passed through as `E` (non-`Error` throws are wrapped in `Error`),
 * so a custom `E` is only sound if you pass a handler.
 */
export function tryCatch<T, E extends Error = Error>(
  fn: () => T,
  errorHandler?: (e: unknown) => E,
): Result<T, E> {
  try {
    return ok(fn())
  } catch (e) {
    return err(errorHandler ? errorHandler(e) : (toError(e) as E))
  }
}

/** Async counterpart of {@link tryCatch}; also captures promise rejections. */
export async function tryCatchAsync<T, E extends Error = Error>(
  fn: () => Promise<T>,
  errorHandler?: (e: unknown) => E,
): Promise<Result<T, E>> {
  try {
    return ok(await fn())
  } catch (e) {
    return err(errorHandler ? errorHandler(e) : (toError(e) as E))
  }
}
