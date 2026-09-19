/**
 * A registered room type: resolved options, the runtime contract with its
 * message tables and hash, and the startup validation (spec §6.8).
 */
import { Schema, validateSchemaClass } from "@bungohan/state"
import {
  type Contract,
  contractHash,
  type MessageDef,
  validateContract,
} from "@bungohan/types"
import type { Room } from "./room"
import type {
  DefineRoomOptions,
  ResolvedRoomOptions,
  RoomConstructor,
} from "./types"

const EMPTY_CONTRACT: Contract = Object.freeze({
  client: Object.freeze({}),
  server: Object.freeze({}),
})

export interface RoomTypeDef {
  readonly name: string
  readonly ctor: RoomConstructor
  readonly options: ResolvedRoomOptions
  readonly contract: Contract
  readonly contractHash: string
  /** Client → server messages; the id is the index. */
  readonly clientMessages: readonly MessageDef[]
  readonly clientNames: readonly string[]
  /** Server → client messages; the id is the index. */
  readonly serverNames: readonly string[]
  readonly serverIds: ReadonlyMap<string, number>
  readonly serverDefs: ReadonlyMap<string, MessageDef>
  /** Handler names for client messages, for handler registration checks. */
  readonly clientIds: ReadonlyMap<string, number>
}

export function resolveOptions(
  options: DefineRoomOptions = {},
): ResolvedRoomOptions {
  return {
    maxClients: options.maxClients ?? Number.POSITIVE_INFINITY,
    autoDispose: options.autoDispose ?? true,
    allowReconnection: options.allowReconnection ?? true,
    reconnectionTimeout: options.reconnectionTimeout ?? 30,
    visibility: options.visibility ?? "public",
    locked: options.locked ?? false,
    metadata: { ...options.metadata },
    reservationTimeout: options.reservationTimeout ?? 60,
  }
}

/** Schema classes already validated (validation runs once per class). */
const validatedStates = new WeakSet<object>()

/**
 * Validates a room's state class, once. Returns the problems (empty if
 * fine). Used at definition time and, for a room that only assigns its
 * state in `onCreate`, when its first room is created.
 */
export function validateStateClass(state: unknown): string[] {
  if (!(state instanceof Schema)) {
    return ["state must be a Schema instance"]
  }
  const ctor = state.constructor
  if (validatedStates.has(ctor)) return []
  const problems = validateSchemaClass(state.constructor as new () => Schema)
  if (problems.length === 0) validatedStates.add(ctor)
  return problems
}

/**
 * Builds a room type and validates everything checkable at startup: every
 * message of its contract and every Schema class reachable from its state.
 * Throws a `TypeError` listing every problem. That is a deliberate,
 * definition-time exception to the no-throw rule (CLAUDE.md rule 1): it
 * runs once, when the server is being set up, and failing loudly there
 * beats desynchronizing every client later.
 */
export function createRoomType(
  name: string,
  ctor: RoomConstructor,
  options: DefineRoomOptions | undefined,
): RoomTypeDef {
  const problems: string[] = []
  if (typeof name !== "string" || name === "") {
    problems.push("room type name must be a non-empty string")
  }
  if (typeof ctor !== "function") {
    throw new TypeError(`defineRoomType("${name}"): not a room class`)
  }

  const declared: unknown = Reflect.get(ctor, "contract")
  const contract: Contract =
    declared === undefined ? EMPTY_CONTRACT : (declared as Contract)
  if (declared !== undefined) {
    problems.push(...validateContract(declared).map((p) => `contract ${p}`))
  }

  // Room classes take no constructor arguments and do nothing on `new`
  // beyond field initializers, so a probe instance shows the state class.
  let probe: Room | undefined
  try {
    probe = new ctor()
  } catch (error) {
    problems.push(`constructor threw: ${String(error)}`)
  }
  const state = probe?._peekState()
  if (state !== undefined) {
    problems.push(...validateStateClass(state).map((p) => `state: ${p}`))
  }

  if (problems.length > 0) {
    throw new TypeError(
      `defineRoomType("${name}") is invalid:\n  - ${problems.join("\n  - ")}`,
    )
  }

  const clientMessages = Object.values(contract.client)
  const serverNames = Object.keys(contract.server)
  return {
    name,
    ctor,
    options: resolveOptions(options),
    contract,
    contractHash: contractHash(contract),
    clientMessages,
    clientNames: Object.keys(contract.client),
    clientIds: new Map(Object.keys(contract.client).map((n, i) => [n, i])),
    serverNames,
    serverIds: new Map(serverNames.map((n, i) => [n, i])),
    serverDefs: new Map(Object.entries(contract.server)),
  }
}

/** Type of a room no server set up (see `Room`'s detached host). */
export const DETACHED_TYPE: RoomTypeDef = {
  name: "",
  ctor: class {} as unknown as RoomConstructor,
  options: resolveOptions(),
  contract: EMPTY_CONTRACT,
  contractHash: contractHash(EMPTY_CONTRACT),
  clientMessages: [],
  clientNames: [],
  clientIds: new Map(),
  serverNames: [],
  serverIds: new Map(),
  serverDefs: new Map(),
}
