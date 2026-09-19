import type { Result } from "@bungohan/result"
import type { SerializerError } from "./errors"

/**
 * Encodes room messages and envelopes (spec §8, §8.1.1). Pluggable: users
 * can supply their own.
 *
 * Both directions return a `Result` rather than throwing. `decode` runs on
 * every inbound frame, which is untrusted input, and framework code does not
 * throw on a per-message path.
 */
export interface ISerializer {
  encode(message: unknown): Result<Uint8Array, SerializerError>
  decode(data: Uint8Array): Result<unknown, SerializerError>
  getName(): string
}
