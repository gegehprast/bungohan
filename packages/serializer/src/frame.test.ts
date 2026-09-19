import { describe, expect, test } from "bun:test"
import { CLIENT_FRAME_HEADERS, SERVER_FRAME_HEADERS } from "@bungohan/types"
import {
  decodeFrame,
  encodeFrame,
  readVarint,
  varintSize,
  writeVarint,
} from "./frame"

describe("varint", () => {
  test("LEB128 round trips across byte boundaries", () => {
    const values = [0, 1, 127, 128, 300, 16383, 16384, 2 ** 31, 0xffffffff]
    for (const value of values) {
      const out = new Uint8Array(5)
      const end = writeVarint(out, 0, value)
      expect(end).toBe(varintSize(value))
      expect(readVarint(out, 0)).toEqual([value, end])
    }
    const out = new Uint8Array(2)
    writeVarint(out, 0, 300)
    expect([...out]).toEqual([0xac, 0x02]) // the LEB128 textbook example
  })

  test("rejects truncated, over-long and over-range input", () => {
    expect(readVarint(new Uint8Array([0x80]), 0)).toBeUndefined()
    expect(
      readVarint(new Uint8Array([0x80, 0x80, 0x80, 0x80, 0x80, 0x01]), 0),
    ).toBeUndefined()
    // 0x1_0000_0000 needs 33 bits.
    expect(
      readVarint(new Uint8Array([0x80, 0x80, 0x80, 0x80, 0x10]), 0),
    ).toBeUndefined()
  })
})

describe("frames", () => {
  test("header then body, with no other overhead", () => {
    const body = new Uint8Array([1, 2, 3])
    const frame = encodeFrame(3, [1], body).unwrap()
    expect([...frame]).toEqual([3, 1, 1, 2, 3])
    const parsed = decodeFrame(frame, SERVER_FRAME_HEADERS).unwrap()
    expect(parsed.type).toBe(3)
    expect(parsed.header).toEqual([1])
    expect([...parsed.body]).toEqual([1, 2, 3])
  })

  test("header counts come from the per-direction tables", () => {
    const frame = encodeFrame(4, [7, 300]).unwrap() // PING nonce, rtt
    const parsed = decodeFrame(frame, CLIENT_FRAME_HEADERS).unwrap()
    expect(parsed.header).toEqual([7, 300])
    expect(parsed.body.byteLength).toBe(0)
  })

  test("malformed frames are errors, never throws", () => {
    expect(decodeFrame(new Uint8Array(), CLIENT_FRAME_HEADERS).isErr()).toBe(
      true,
    )
    expect(
      decodeFrame(new Uint8Array([99]), CLIENT_FRAME_HEADERS).isErr(),
    ).toBe(true)
    // ROOM_MESSAGE needs two varints.
    expect(
      decodeFrame(new Uint8Array([0, 1]), CLIENT_FRAME_HEADERS).isErr(),
    ).toBe(true)
    expect(encodeFrame(256, []).isErr()).toBe(true)
    expect(encodeFrame(0, [-1]).isErr()).toBe(true)
    expect(encodeFrame(0, [1.5]).isErr()).toBe(true)
  })
})
