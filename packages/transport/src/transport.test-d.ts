/**
 * Type-level tests, checked by `tsc --noEmit` (never executed). Each
 * `@ts-expect-error` fails the typecheck if the error it expects disappears.
 */
import { ok, type Result } from "@bungohan/result"
import type { ITransport } from "./transport"

const base = {
  listen: async (): Promise<Result<void, Error>> => ok(undefined),
  close: async (): Promise<Result<void, Error>> => ok(undefined),
  send: (): Result<void, Error> => ok(undefined),
  broadcast: (): Result<void, Error> => ok(undefined),
  disconnect: (): Result<void, Error> => ok(undefined),
  getName: () => "custom",
}

/** A transport that negotiates the protocol version compiles. */
export const complete: ITransport = {
  ...base,
  acceptProtocols: (_protocols: readonly string[]) => {},
}

/**
 * Without `acceptProtocols` it doesn't: core would reject every connection
 * it accepts (no `context.protocol`), so the omission is a compile error
 * rather than a server that silently lets nobody in (spec §6.7.7).
 */
// @ts-expect-error — acceptProtocols is required
export const missing: ITransport = { ...base }

/** Also enforced for classes. */
// @ts-expect-error — class is missing acceptProtocols
export class MissingTransport implements ITransport {
  public listen = base.listen
  public close = base.close
  public send = base.send
  public broadcast = base.broadcast
  public disconnect = base.disconnect
  public getName = base.getName
}
