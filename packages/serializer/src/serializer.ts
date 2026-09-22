import type { Result } from "@bungohan/result"
import type { SerializerError } from "./errors"

/**
 * Encodes the bodies that aren't state or contract messages: raw room
 * messages (`sendRaw`/`onMessageRaw`), control bodies such as join options,
 * the join handshake and errors, and, in cluster mode, backplane messages.
 * The default is `MessagePackSerializer`; `JsonSerializer` is readable but
 * larger and lossy. Server and client must use the same one
 * (`ServerOptions.serializer`, `ClientOptions.serializer`): nothing on the
 * wire says which is in use, so a mismatch shows up as decode errors.
 *
 * What an implementation must do:
 *
 * - Return an array from `encode` that the caller owns: it is queued,
 *   retained and broadcast to many clients as is, so never a view into a
 *   buffer the serializer reuses.
 * - Treat `decode` input as untrusted (it is whatever a client sent) and
 *   reject anything malformed with an `err`. Neither method may throw:
 *   they run on every frame.
 * - In cluster mode, round-trip a `Uint8Array` exactly: client frames
 *   travel inside backplane messages. The cluster checks this when it
 *   starts and refuses a serializer that doesn't.
 */
export interface ISerializer {
  /** Encodes one value; one the format can't represent is `ENCODE_FAILED`. */
  encode(message: unknown): Result<Uint8Array, SerializerError>
  /** Decodes one whole body; malformed or trailing bytes: `DECODE_FAILED`. */
  decode(data: Uint8Array): Result<unknown, SerializerError>
  /** A short name for errors and logs, such as `"messagepack"`. */
  getName(): string
}
