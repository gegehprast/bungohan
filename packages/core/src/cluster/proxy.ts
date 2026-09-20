/**
 * A handle on a room that lives on another process (spec §6.4).
 *
 * `matchMaker.createRoom` / `joinRoom` / `joinById` return a `Room`, so a
 * room found elsewhere in the cluster comes back as a `RoomProxy`: the same
 * type, forwarding what it can over the backplane. What it deliberately
 * does *not* do is pretend to hold the room's state or its clients — those
 * exist once, on the owning process, and a replica here would be a second
 * source of truth that could disagree with it.
 *
 * So a proxy is **control and description, not simulation**:
 *
 * - forwarded: `lock`/`unlock`, `makePrivate`/`makePublic`, `dispose`,
 *   `broadcastMessage`, `disconnectClient` (a kick), the presence calls;
 * - **cached** from the owning process, as of the last `refresh()`: `id`,
 *   `roomType`, `metadata`, the option fields, `getClientCount()`,
 *   `getSeatCount()`, `locked`, `visibility`, `isDisposed`;
 * - refused with a clear error: `join`/`leave` (a `Client` belongs to the
 *   process that holds its connection) and `onMessage` (messages are
 *   dispatched where the room runs).
 *
 * Clients never touch a proxy: a client's join is routed to the owning
 * process, which seats it in the real room (see `cluster/remote.ts`).
 */
import { err, ok, type Result } from "@bungohan/result"
import type { Clock } from "@bungohan/types"
import type { Client } from "../client"
import { BungohanError, type ErrorCode } from "../errors"
import type { Logger } from "../logger"
import { Room } from "../room"
import type { RoomInfo, RoomOp } from "./protocol"

export interface ProxyHost {
  readonly clock: Clock
  readonly logger: Logger
  call(
    processId: string,
    roomId: string,
    op: RoomOp,
  ): Promise<Result<unknown, BungohanError>>
}

export class RoomProxy extends Room {
  /** The process the room actually runs on. */
  public readonly processId: string

  private readonly _proxyHost: ProxyHost
  private _info: RoomInfo

  public constructor(host: ProxyHost, info: RoomInfo) {
    super()
    this._proxyHost = host
    this._info = info
    this.processId = info.processId
    this._adopt(info)
  }

  // ==========================================================================
  // Description (cached; `refresh()` re-reads it)
  // ==========================================================================

  /** Always true on a proxy; `false` on a `Room` this process owns. */
  public override get isRemote(): boolean {
    return true
  }

  public override get id(): string {
    return this._info.id
  }

  public override get roomType(): string {
    return this._info.roomType
  }

  public override get visibility(): "public" | "private" {
    return this._info.visibility
  }

  public override get locked(): boolean {
    return this._info.locked
  }

  public override get isDisposed(): boolean {
    return this._info.disposed
  }

  /** Pausing is a property of the owning process's loops, never seen here. */
  public override get isPaused(): boolean {
    return false
  }

  public override getClientCount(): number {
    return this._info.clientCount
  }

  public override getSeatCount(): number {
    return this._info.seatCount
  }

  public override isAvailable(): boolean {
    return (
      !this._info.disposed &&
      !this._info.locked &&
      this._info.visibility === "public" &&
      this._info.seatCount < this._info.maxClients
    )
  }

  /** Re-reads the room's description from the process that owns it. */
  public async refresh(): Promise<Result<void, BungohanError>> {
    const info = await this._call<RoomInfo>({ op: "info" })
    if (info.isErr()) return info
    this._info = info.value
    this._adopt(info.value)
    return ok(undefined)
  }

  // ==========================================================================
  // Forwarded control
  // ==========================================================================

  public override lock(): void {
    this._info = { ...this._info, locked: true }
    this._fireAndForget({ op: "lock", locked: true })
  }

  public override unlock(): void {
    this._info = { ...this._info, locked: false }
    this._fireAndForget({ op: "lock", locked: false })
  }

  public override makePrivate(): void {
    this._info = { ...this._info, visibility: "private" }
    this._fireAndForget({ op: "visibility", visibility: "private" })
  }

  public override makePublic(): void {
    this._info = { ...this._info, visibility: "public" }
    this._fireAndForget({ op: "visibility", visibility: "public" })
  }

  public override async dispose(): Promise<void> {
    this._info = { ...this._info, disposed: true }
    const done = await this._call({ op: "dispose" })
    if (done.isErr()) this._warn("dispose", done.error)
  }

  /** Kicks a seat by `sessionId` (the `Client` itself lives elsewhere). */
  public override disconnectClient(
    client: Client,
    code = 4000,
    reason?: string,
  ): void {
    this._fireAndForget({
      op: "kick",
      sessionId: client.sessionId,
      code,
      ...(reason === undefined ? {} : { reason }),
    })
  }

  public override broadcastMessage(
    type: never,
    message: never,
    except?: Client,
  ): void {
    this._fireAndForget({
      op: "broadcast",
      type: String(type),
      message,
      ...(except === undefined ? {} : { except: except.sessionId }),
    })
  }

  /** Untyped broadcast to a remote room (the `sendRaw` payload shape). */
  public broadcastRawMessage(
    type: string,
    message: unknown,
    except?: Client,
  ): void {
    this._fireAndForget({
      op: "broadcastRaw",
      type,
      message,
      ...(except === undefined ? {} : { except: except.sessionId }),
    })
  }

  public override setPresence(clientId: string, data: unknown): void {
    this._fireAndForget({ op: "presenceSet", clientId, data })
  }

  public override removePresence(clientId: string): void {
    this._fireAndForget({ op: "presenceRemove", clientId })
  }

  /** Presence lives on the owning process, so reading it is a round trip. */
  public async fetchPresence(): Promise<
    Result<Map<string, unknown>, BungohanError>
  > {
    const all = await this._call<[string, unknown][]>({ op: "presenceAll" })
    return all.isErr() ? all : ok(new Map(all.value))
  }

  // ==========================================================================
  // Refused: these need the process the room runs on
  // ==========================================================================

  /** Always `undefined`: a proxy holds no local presence. Use `fetchPresence`. */
  public override getPresence(_clientId: string): unknown {
    this._refusedSync("getPresence", "use fetchPresence()")
    return undefined
  }

  /** Always empty. Use `fetchPresence`. */
  public override getAllPresence(): Map<string, unknown> {
    this._refusedSync("getAllPresence", "use fetchPresence()")
    return new Map()
  }

  public override async join(
    _client: Client,
    _options?: unknown,
  ): Promise<Result<void, BungohanError>> {
    return err(this._refused("join"))
  }

  public override async leave(
    _client: Client,
    _consented = true,
  ): Promise<Result<void, BungohanError>> {
    return err(this._refused("leave"))
  }

  public override onMessage(): () => void {
    this._refusedSync(
      "onMessage",
      "register it in the room class, which runs on the owning process",
    )
    return () => {}
  }

  public override onMessageRaw(): () => void {
    this._refusedSync(
      "onMessageRaw",
      "register it in the room class, which runs on the owning process",
    )
    return () => {}
  }

  /** Always empty: the seats belong to the owning process. */
  public override getClients(): Client[] {
    return []
  }

  public override getClient(_clientId: string): Client | undefined {
    return undefined
  }

  public override hasClient(_clientId: string): boolean {
    return false
  }

  // ==========================================================================
  // Internals
  // ==========================================================================

  private _adopt(info: RoomInfo): void {
    this.maxClients = info.maxClients
    this.autoDispose = info.autoDispose
    this.allowReconnection = info.allowReconnection
    this.reconnectionTimeout = info.reconnectionTimeout
    this.metadata = { ...info.metadata }
  }

  private async _call<T>(op: RoomOp): Promise<Result<T, BungohanError>> {
    const done = await this._proxyHost.call(this.processId, this._info.id, op)
    // The owning process answered with what its handler returned for `op`.
    return done.isErr() ? done : ok(done.value as T)
  }

  private _fireAndForget(op: RoomOp): void {
    void this._call(op).then((done) => {
      if (done.isErr()) this._warn(op.op, done.error)
    })
  }

  private _warn(op: string, error: BungohanError): void {
    this._proxyHost.logger.error(
      `[cluster] ${op} on remote room ${this._info.id} ` +
        `(process ${this.processId}) failed: ${error.message}`,
    )
  }

  private _refused(method: string): BungohanError {
    const message =
      `room ${this._info.id} runs on process ${this.processId}; ` +
      `${method}() needs a Client of this process. Seat clients by ` +
      "routing their JOIN, which the server already does."
    this._proxyHost.logger.error(`[cluster] ${message}`)
    return this._proxyError("INVALID_STATE", message)
  }

  private _refusedSync(method: string, hint: string): void {
    this._proxyHost.logger.error(
      `[cluster] ${method}() is not available on a remote room ` +
        `(${this._info.id} on process ${this.processId}): ${hint}`,
    )
  }

  private _proxyError(code: ErrorCode, message: string): BungohanError {
    return new BungohanError(code, message, this._proxyHost.clock.now())
  }
}
