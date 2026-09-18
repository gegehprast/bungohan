/**
 * Type-level tests, checked by `tsc --noEmit` (never executed). Each
 * `@ts-expect-error` fails the typecheck if the error it expects disappears.
 */
import { err, ok, type Result } from "./index"

declare function source(): Result<number, RangeError>

export function narrowing(): void {
  const r = source()

  // @ts-expect-error — .value is not reachable before narrowing
  r.value

  if (r.isOk()) {
    const v: number = r.value
    // @ts-expect-error — no .error on the Ok branch
    r.error
    void v
  } else {
    const e: RangeError = r.error
    void e
  }

  if (r.isErr()) {
    const e: RangeError = r.error
    void e
  } else {
    const v: number = r.value
    void v
  }
}

export function combinators(): void {
  const chained: Result<string, RangeError | TypeError> = source().andThen(
    (n) => (n > 0 ? ok(String(n)) : err(new TypeError("neg"))),
  )
  void chained

  // @ts-expect-error — err() only accepts Error subclasses
  err("not an error")
}
