import { describe, expect, test } from "bun:test"
import { negotiateProtocol, parseProtocols } from "./protocol"

describe("protocol negotiation", () => {
  test("parses the Sec-WebSocket-Protocol header", () => {
    expect(parseProtocols(null)).toEqual([])
    expect(parseProtocols(" a , b,,c ")).toEqual(["a", "b", "c"])
  })

  test("without a configured list, anything is accepted", () => {
    expect(negotiateProtocol([], undefined)).toEqual({
      ok: true,
      protocol: undefined,
    })
    expect(negotiateProtocol(["x"], undefined)).toEqual({
      ok: true,
      protocol: "x",
    })
  })

  test("the server's first accepted version the client offered wins", () => {
    expect(negotiateProtocol(["v1", "v2"], ["v2", "v1"])).toEqual({
      ok: true,
      protocol: "v2",
    })
  })

  test("a mismatch echoes the client's offer and explains the rejection", () => {
    expect(negotiateProtocol(["v0", "v9"], ["v1"])).toEqual({
      ok: false,
      echo: "v0",
      reason: "unsupported protocol v0, v9; expected v1",
    })
    expect(negotiateProtocol([], ["v1"])).toEqual({
      ok: false,
      echo: undefined,
      reason: "no protocol version offered; expected v1",
    })
  })

  test("reasons fit a WebSocket close frame (123 bytes)", () => {
    const result = negotiateProtocol(["é".repeat(200)], ["v1"])
    if (result.ok) throw new Error("expected a rejection")
    expect(
      new TextEncoder().encode(result.reason).byteLength,
    ).toBeLessThanOrEqual(123)
    expect(result.reason.endsWith("...")).toBe(true)
  })
})
