/**
 * Subprotocol negotiation (spec §6.7.7), shared by every transport. The
 * protocol version is checked when a connection opens, before any frame is
 * read, so it keeps working even if the frame format itself changes.
 */

/** WebSocket close code for a rejected protocol version (RFC 6455 1002). */
export const PROTOCOL_ERROR = 1002

/** Close reasons are limited to 123 bytes of UTF-8 (RFC 6455 §5.5). */
const MAX_REASON_BYTES = 123

export type Negotiation =
  /** Accepted: `protocol` is the one to answer with (and to expose). */
  | { readonly ok: true; readonly protocol: string | undefined }
  /**
   * Rejected: complete the upgrade (answering with `echo`, the client's own
   * first offer, so every client can read the close), then close at once
   * with 1002 and `reason`. The connection never reaches `onConnection`.
   */
  | {
      readonly ok: false
      readonly echo: string | undefined
      readonly reason: string
    }

/** Values of a `Sec-WebSocket-Protocol` header, in the client's order. */
export function parseProtocols(header: string | null): string[] {
  if (header === null) return []
  return header
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value !== "")
}

/**
 * A WebSocket close reason, clipped to the 123 bytes RFC 6455 allows.
 * Longer reasons end in `...`. Shared by version negotiation (below) and
 * by core, which puts the reason for a protocol violation here too
 * (PROTOCOL.md §8.2).
 */
export function clipCloseReason(reason: string): string {
  const bytes = new TextEncoder().encode(reason)
  if (bytes.byteLength <= MAX_REASON_BYTES) return reason
  // Cutting mid-character leaves a U+FFFD replacement character; drop it.
  const head = new TextDecoder()
    .decode(bytes.subarray(0, MAX_REASON_BYTES - 3))
    .replace(/\uFFFD$/, "")
  return `${head}...`
}

/**
 * Picks the protocol for a connection. With no `accepted` list (nothing
 * configured), everything is accepted as before. Otherwise the server's
 * first accepted protocol that the client offered wins (server preference).
 */
export function negotiateProtocol(
  offered: readonly string[],
  accepted: readonly string[] | undefined,
): Negotiation {
  if (accepted === undefined) return { ok: true, protocol: offered[0] }
  const protocol = accepted.find((candidate) => offered.includes(candidate))
  if (protocol !== undefined) return { ok: true, protocol }
  const expected = accepted.join(", ")
  const reason =
    offered.length === 0
      ? `no protocol version offered; expected ${expected}`
      : `unsupported protocol ${offered.join(", ")}; expected ${expected}`
  return { ok: false, echo: offered[0], reason: clipCloseReason(reason) }
}
