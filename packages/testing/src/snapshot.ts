import { SchemaCodec } from "@bungohan/serializer"
import {
  applyDelta,
  clearChangeTrees,
  encodeSnapshot,
  type FilterClient,
  generateDeltas,
  type Schema,
} from "@bungohan/state"

/**
 * What one client would hold after joining a room with this state: the
 * join snapshot encoded for that client (every `createFiltered` filter
 * applied), through the wire codec, and decoded into a new instance of
 * the state's class. A hidden field reads as its zero value (`""`, `0`,
 * an empty collection), exactly as on that client. That makes
 * per-client visibility a plain unit test, with no server or room:
 *
 * ```ts
 * const party = new PartyState()
 * party.heroes.set("alice", heroOf("alice", { quest: "find the map" }))
 * expect(snapshotFor(party, "bob").heroes.get("alice")?.quest.get()).toBe("")
 * ```
 *
 * `client` is the `sessionId` your filters compare `client.sessionId`
 * against, or the object they receive when they read more than the id.
 *
 * Pass a state the test built. The call counts its pending changes as
 * synced, which is harmless there but would cost a running room's real
 * clients those changes, so for a room's state (`harness.stateOf`) join
 * harness clients and read their replicas instead. Throws (fails the
 * test) if the state can't be encoded or decoded.
 */
export function snapshotFor<S extends Schema>(
  state: S,
  client: string | FilterClient,
): S {
  // A snapshot is taken at a sync boundary: settle what's pending first.
  generateDeltas(state)
  clearChangeTrees(state)
  const viewer =
    typeof client === "string" ? { sessionId: client, id: client } : client
  const ops = encodeSnapshot(state, viewer).unwrap()
  const codec = new SchemaCodec()
  const bytes = codec.createSession().encodeOps(ops).unwrap()
  const received = codec.createSession().decodeOps(bytes).unwrap()
  // A Schema subclass is constructed with no arguments (the codec's rule).
  const ctor = state.constructor as new () => S
  const view = new ctor()
  applyDelta(view, received).unwrap()
  return view
}
