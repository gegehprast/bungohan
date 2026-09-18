/**
 * A successful result. Narrow a `Result` with `isOk()` and read `.value`.
 */
export class Ok<T> {
  /** Discriminant; lets `Ok<T> & Err<E>` reduce to `never` when narrowing. */
  public readonly ok = true as const
  public readonly value: T

  public constructor(value: T) {
    this.value = value
  }

  public isOk(): this is Ok<T> {
    return true
  }

  public isErr(): this is Err<never> {
    return false
  }

  public unwrap(): T {
    return this.value
  }

  public unwrapOr(_fallback: T): T {
    return this.value
  }

  public map<U>(fn: (value: T) => U): Result<U, never> {
    return ok(fn(this.value))
  }

  public mapErr<F extends Error>(_fn: (error: never) => F): Result<T, F> {
    return this
  }

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
  public readonly error: E

  public constructor(error: E) {
    this.error = error
  }

  public isOk(): this is Ok<never> {
    return false
  }

  public isErr(): this is Err<E> {
    return true
  }

  /** Throws the contained `error` itself (not a wrapper). */
  public unwrap(): never {
    throw this.error
  }

  public unwrapOr<T>(fallback: T): T {
    return fallback
  }

  public map<U>(_fn: (value: never) => U): Result<U, E> {
    return this
  }

  public mapErr<F extends Error>(fn: (error: E) => F): Result<never, F> {
    return err(fn(this.error))
  }

  public andThen<U, F extends Error>(
    _fn: (value: never) => Result<U, F>,
  ): Result<never, E | F> {
    return this
  }
}

export type Result<T, E extends Error> = Ok<T> | Err<E>

export function ok<T>(value: T): Ok<T> {
  return new Ok(value)
}

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
