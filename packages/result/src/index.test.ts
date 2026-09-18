import { describe, expect, test } from "bun:test"
import { Err, err, Ok, ok, type Result, tryCatch, tryCatchAsync } from "./index"

class CodeError extends Error {
  public readonly code: string
  public constructor(code: string) {
    super(code)
    this.code = code
  }
}

function divide(a: number, b: number): Result<number, CodeError> {
  return b === 0 ? err(new CodeError("DIV_ZERO")) : ok(a / b)
}

describe("Ok / Err", () => {
  test("constructors produce the right class", () => {
    expect(ok(1)).toBeInstanceOf(Ok)
    expect(err(new Error("x"))).toBeInstanceOf(Err)
  })

  test("isOk / isErr narrow to .value / .error", () => {
    const good = divide(6, 3)
    const bad = divide(1, 0)

    expect(good.isOk()).toBe(true)
    expect(good.isErr()).toBe(false)
    expect(bad.isOk()).toBe(false)
    expect(bad.isErr()).toBe(true)

    if (good.isOk()) expect(good.value).toBe(2)
    if (bad.isErr()) expect(bad.error.code).toBe("DIV_ZERO")

    // else-branch narrowing
    if (bad.isOk()) throw new Error("unreachable")
    else expect(bad.error.code).toBe("DIV_ZERO")
  })

  test("unwrap returns value, or throws the error itself", () => {
    expect(ok("a").unwrap()).toBe("a")
    const e = new CodeError("BOOM")
    expect(() => err(e).unwrap()).toThrow(e)
    try {
      err(e).unwrap()
    } catch (thrown) {
      expect(thrown).toBe(e)
    }
  })

  test("unwrapOr", () => {
    expect(divide(4, 2).unwrapOr(-1)).toBe(2)
    expect(divide(4, 0).unwrapOr(-1)).toBe(-1)
  })

  test("map only touches Ok", () => {
    expect(
      ok(2)
        .map((v) => v * 10)
        .unwrap(),
    ).toBe(20)
    const e = new CodeError("E")
    const mapped = err(e).map(() => 1)
    expect(mapped.isErr() && mapped.error).toBe(e)
  })

  test("mapErr only touches Err", () => {
    const r = divide(1, 0).mapErr((e) => new Error(`wrapped ${e.code}`))
    expect(r.isErr() && r.error.message).toBe("wrapped DIV_ZERO")
    expect(
      ok(3)
        .mapErr(() => new Error("never"))
        .unwrap(),
    ).toBe(3)
  })

  test("andThen chains and short-circuits", () => {
    expect(
      divide(8, 2)
        .andThen((v) => divide(v, 2))
        .unwrap(),
    ).toBe(2)

    let called = false
    const r = divide(1, 0).andThen((v) => {
      called = true
      return divide(v, 1)
    })
    expect(called).toBe(false)
    expect(r.isErr()).toBe(true)
  })
})

describe("tryCatch", () => {
  test("captures success", () => {
    expect(tryCatch(() => 5).unwrap()).toBe(5)
  })

  test("captures a thrown Error as-is", () => {
    const e = new Error("bad")
    const r = tryCatch(() => {
      throw e
    })
    expect(r.isErr() && r.error).toBe(e)
  })

  test("wraps non-Error throws", () => {
    const r = tryCatch(() => {
      throw "plain string"
    })
    expect(r.isErr()).toBe(true)
    if (r.isErr()) {
      expect(r.error).toBeInstanceOf(Error)
      expect(r.error.message).toBe("plain string")
    }
  })

  test("uses the error handler", () => {
    const r = tryCatch(
      () => {
        throw 42
      },
      (e) => new CodeError(`code-${String(e)}`),
    )
    expect(r.isErr() && r.error.code).toBe("code-42")
  })
})

describe("tryCatchAsync", () => {
  test("captures resolution", async () => {
    expect((await tryCatchAsync(async () => "v")).unwrap()).toBe("v")
  })

  test("captures rejection", async () => {
    const r = await tryCatchAsync(() => Promise.reject(new Error("nope")))
    expect(r.isErr() && r.error.message).toBe("nope")
  })

  test("uses the error handler", async () => {
    const r = await tryCatchAsync(
      async () => {
        throw "x"
      },
      () => new CodeError("HANDLED"),
    )
    expect(r.isErr() && r.error.code).toBe("HANDLED")
  })
})
