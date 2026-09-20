/**
 * Cluster mode relays finished client frames as binary inside backplane
 * messages (spec §6.4.1), so the server's `ISerializer` must round-trip a
 * `Uint8Array`. One that doesn't would break frame relay at runtime, in
 * cluster mode only, and the only symptom would be that clients whose room
 * lives on another process stop receiving state.
 *
 * So it is checked once, when cluster mode starts. These tests pin that it
 * fires on a broken serializer, says which one, doesn't fire on a working
 * one that simply isn't MessagePack, and never runs without cluster mode.
 */
import { describe, expect, test } from "bun:test"
import { MemoryBackplane, MemoryBus } from "@bungohan/backplane"
import type { ServerOptions } from "@bungohan/core"
import { err, ok, type Result } from "@bungohan/result"
import {
  type ISerializer,
  JsonSerializer,
  MessagePackSerializer,
  SerializerError,
} from "@bungohan/serializer"
import { GameRoom } from "../core/fixtures"
import { TestHarness } from "../harness"

/** What a naive custom serializer looks like: JSON, and no binary. */
class NaiveJsonSerializer implements ISerializer {
  public encode(message: unknown): Result<Uint8Array, SerializerError> {
    return ok(new TextEncoder().encode(JSON.stringify(message)))
  }

  public decode(data: Uint8Array): Result<unknown, SerializerError> {
    try {
      return ok(JSON.parse(new TextDecoder().decode(data)))
    } catch {
      return err(new SerializerError("DECODE_FAILED", "not JSON"))
    }
  }

  public getName(): string {
    return "naive-json"
  }
}

/** One that mangles the bytes rather than losing the type. */
class LossyBinarySerializer implements ISerializer {
  private readonly _inner = new JsonSerializer()

  public encode(message: unknown): Result<Uint8Array, SerializerError> {
    return this._inner.encode(message)
  }

  public decode(data: Uint8Array): Result<unknown, SerializerError> {
    const decoded = this._inner.decode(data)
    if (decoded.isErr()) return decoded
    const value = decoded.value as Record<string, unknown>
    const probe = value["probe"]
    // Drops the high bytes, the way a UTF-8 round trip would.
    if (probe instanceof Uint8Array) {
      value["probe"] = probe.map((byte) => (byte > 0x7f ? 0x3f : byte))
    }
    return ok(value)
  }

  public getName(): string {
    return "lossy-binary"
  }
}

function harness(server: Omit<ServerOptions, "transport" | "clock">) {
  return new TestHarness({ rooms: { game: GameRoom }, server })
}

function clustered(
  serializer: ISerializer,
): Omit<ServerOptions, "transport" | "clock"> {
  return {
    serializer,
    cluster: {
      enabled: true,
      processId: "p0",
      backplane: { provider: new MemoryBackplane(new MemoryBus()) },
    },
  }
}

describe("the serializer must carry binary in cluster mode", () => {
  test("a serializer that loses the type refuses to start", async () => {
    const h = harness(clustered(new NaiveJsonSerializer()))
    const started = await h.server.start()

    expect(started.isErr() && started.error.code).toBe("INVALID_OPTIONS")
    const message = started.isErr() ? started.error.message : ""
    expect(message).toContain("naive-json")
    expect(message).toContain("Uint8Array")
    expect(message).toContain("plain object")
    expect(h.server.isRunning()).toBe(false)
    expect(h.server.getCluster()).toBeUndefined()
  })

  test("a serializer that mangles the bytes refuses to start", async () => {
    const h = harness(clustered(new LossyBinarySerializer()))
    const started = await h.server.start()

    expect(started.isErr() && started.error.code).toBe("INVALID_OPTIONS")
    const message = started.isErr() ? started.error.message : ""
    expect(message).toContain("lossy-binary")
    // It names the bytes it got back and the ones it sent.
    expect(message).toContain("63, 63, 63")
    expect(message).toContain("128, 195, 169, 255")
    expect(h.server.isRunning()).toBe(false)
  })

  test("a non-MessagePack serializer that does carry binary is fine", async () => {
    // JsonSerializer wraps a Uint8Array rather than flattening it, so the
    // check is about the guarantee, not about being MessagePack.
    const h = harness(clustered(new JsonSerializer()))
    expect((await h.server.start()).isOk()).toBe(true)
    expect(h.server.getCluster()?.isRunning).toBe(true)
    await h.stop()
  })

  test("the default serializer starts, as every other cluster test shows", async () => {
    const h = harness(clustered(new MessagePackSerializer()))
    expect((await h.server.start()).isOk()).toBe(true)
    await h.stop()
  })

  test("without cluster mode a binary-less serializer is nobody's business", async () => {
    // Nothing relays frames, so the check must not fire: a single-process
    // server never puts bytes inside another encoding.
    const h = harness({ serializer: new NaiveJsonSerializer() })
    expect((await h.server.start()).isOk()).toBe(true)
    expect(h.server.isRunning()).toBe(true)
    await h.stop()
  })
})
