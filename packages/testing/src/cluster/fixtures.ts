/**
 * A room that records exactly what it was handed, so a local join and a
 * remote one can be compared value for value (spec §6.4.1).
 */
import { type Client, Room } from "@bungohan/core"
import { createNumber, Schema } from "@bungohan/state"

export class EchoState extends Schema {
  public static override schemaName = "Cluster.Echo"
  public turn = createNumber()
}

/** Options every `EchoRoom` in the process received, newest last. */
export const received: {
  create: unknown[]
  join: unknown[]
  message: unknown[]
} = { create: [], join: [], message: [] }

export function resetReceived(): void {
  received.create.length = 0
  received.join.length = 0
  received.message.length = 0
}

export class EchoRoom extends Room<EchoState> {
  public override state = new EchoState()

  protected override async onCreate(
    options: Record<string, unknown>,
  ): Promise<void> {
    received.create.push(options)
    this.onMessageRaw("say", (_client, payload) => {
      received.message.push(payload)
    })
  }

  protected override async onJoin(
    _client: Client,
    options: Record<string, unknown>,
  ): Promise<void> {
    received.join.push(options)
  }

  /** Broadcasts a payload to every client, from the owning process. */
  public blast(payload: unknown): void {
    this.broadcastRaw("payload", payload)
  }
}

/**
 * A payload with the values a JSON hop would quietly change: binary, the
 * non-finite numbers, and a `Date`.
 */
export function trickyPayload(): Record<string, unknown> {
  return {
    bytes: new Uint8Array([1, 2, 3]),
    inf: Number.POSITIVE_INFINITY,
    ninf: Number.NEGATIVE_INFINITY,
    nan: Number.NaN,
    date: new Date("2024-03-01T12:00:00.123Z"),
    nested: { bytes: new Uint8Array([255, 0, 128]), list: [Number.NaN, 1.5] },
    plain: "text",
  }
}

/** Asserts a payload came through with every value intact. */
export function expectTricky(
  value: unknown,
  expect: (actual: unknown) => {
    toEqual(expected: unknown): void
    toBeInstanceOf(ctor: unknown): void
    toBe(expected: unknown): void
  },
): void {
  const payload = value as Record<string, unknown>
  expect(payload["bytes"]).toBeInstanceOf(Uint8Array)
  expect([...(payload["bytes"] as Uint8Array)]).toEqual([1, 2, 3])
  expect(payload["inf"]).toBe(Number.POSITIVE_INFINITY)
  expect(payload["ninf"]).toBe(Number.NEGATIVE_INFINITY)
  expect(Number.isNaN(payload["nan"])).toBe(true)
  expect(payload["date"]).toBeInstanceOf(Date)
  expect((payload["date"] as Date).toISOString()).toBe(
    "2024-03-01T12:00:00.123Z",
  )
  const nested = payload["nested"] as Record<string, unknown>
  expect(nested["bytes"]).toBeInstanceOf(Uint8Array)
  expect([...(nested["bytes"] as Uint8Array)]).toEqual([255, 0, 128])
  expect(payload["plain"]).toBe("text")
}
