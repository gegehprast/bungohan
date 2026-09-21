/**
 * The language-neutral input of every emitter, built by walking the
 * runtime descriptors of a contract module and a state module (spec §4.2):
 * no TypeScript compiler API, no parsing.
 */
import {
  reachableSchemaClasses,
  Schema,
  type SchemaConstructor,
  validateSchemaClass,
} from "@bungohan/state"
import {
  type Contract,
  contractHash,
  type Field,
  type MessageDef,
  messageLayout,
  type SchemaFieldType,
  validateContract,
} from "@bungohan/types"

export interface ContractModel {
  /** The export name, e.g. `shooterContract`. */
  readonly name: string
  /** Baked into clients (spec §6.7.4); ids are never baked in. */
  readonly hash: string
  /** Client → server messages, in the contract's key order. */
  readonly client: readonly MessageDef[]
  /** Server → client messages, in the contract's key order. */
  readonly server: readonly MessageDef[]
  /**
   * Typed join and create options (spec §4.1.2), or `undefined` when the
   * contract declares none. A kind left out of a typed contract is absent
   * here and means the empty message.
   */
  readonly options:
    | { readonly create?: MessageDef; readonly join?: MessageDef }
    | undefined
}

export interface SchemaFieldModel {
  readonly name: string
  readonly type: SchemaFieldType
}

export interface SchemaModel {
  /** The class's `schemaName`: the name on the wire. */
  readonly name: string
  readonly fields: readonly SchemaFieldModel[]
}

export interface CodegenModel {
  /** Contracts, sorted by export name. */
  readonly contracts: readonly ContractModel[]
  /** Every message the contracts reach (nested ones too), sorted by name. */
  readonly messages: readonly MessageDef[]
  /** Every schema class the state module reaches, sorted by name. */
  readonly schemas: readonly SchemaModel[]
}

/** A definition problem found while walking the modules. */
export class CodegenError extends Error {
  public override readonly name = "CodegenError"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

export function isMessageDef(value: unknown): value is MessageDef {
  return (
    isRecord(value) &&
    value["kind"] === "message" &&
    typeof value["name"] === "string" &&
    Array.isArray(value["fieldNames"])
  )
}

export function isContract(value: unknown): value is Contract {
  if (!isRecord(value)) return false
  const { client, server } = value
  return (
    isRecord(client) &&
    isRecord(server) &&
    Object.values(client).every(isMessageDef) &&
    Object.values(server).every(isMessageDef)
  )
}

function isSchemaClass(value: unknown): value is SchemaConstructor {
  return typeof value === "function" && value.prototype instanceof Schema
}

function byName<T extends { readonly name: string }>(a: T, b: T): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
}

/** The messages a field reaches through nesting. */
function nestedMessages(field: Field, into: MessageDef[]): void {
  switch (field.kind) {
    case "array":
    case "map":
    case "optional":
      nestedMessages(field.of, into)
      return
    case "nested":
      into.push(field.message)
      for (const name of field.message.fieldNames) {
        const inner = field.message.fields[name]
        if (inner !== undefined) nestedMessages(inner, into)
      }
      return
    default:
      return
  }
}

/**
 * Builds the model. `contracts` maps export names to contracts; `roots` are
 * the state classes to start from (every class they reach is included).
 * Throws a {@link CodegenError} for a malformed declaration, or for two
 * different messages (or classes) sharing a name.
 */
export function buildModel(
  contracts: Readonly<Record<string, Contract>>,
  roots: readonly SchemaConstructor[],
): CodegenModel {
  const problems: string[] = []

  const contractModels: ContractModel[] = []
  const messages = new Map<string, MessageDef>()
  const addMessage = (def: MessageDef, where: string): void => {
    const known = messages.get(def.name)
    if (known === undefined) messages.set(def.name, def)
    else if (known !== def && messageLayout(known) !== messageLayout(def)) {
      problems.push(
        `${where}: two different messages are named "${def.name}"; ` +
          "generated classes are named after messages, so names must be unique",
      )
    }
  }
  for (const name of Object.keys(contracts).sort()) {
    const contract = contracts[name]
    if (contract === undefined) continue
    problems.push(...validateContract(contract).map((p) => `${name}: ${p}`))
    const client = Object.values(contract.client)
    const server = Object.values(contract.server)
    const create = contract.options?.create
    const join = contract.options?.join
    const options =
      create === undefined && join === undefined
        ? undefined
        : {
            ...(create === undefined ? {} : { create }),
            ...(join === undefined ? {} : { join }),
          }
    const optionDefs = [create, join].filter((def) => def !== undefined)
    for (const def of [...client, ...server, ...optionDefs]) {
      const reached: MessageDef[] = [def]
      for (const field of def.fieldNames) {
        const inner = def.fields[field]
        if (inner !== undefined) nestedMessages(inner, reached)
      }
      for (const message of reached) addMessage(message, name)
    }
    contractModels.push({
      name,
      hash: contractHash(contract),
      client,
      server,
      options,
    })
  }

  const classes = new Map<string, SchemaModel>()
  const constructors = new Map<string, SchemaConstructor>()
  for (const root of roots) {
    problems.push(...validateSchemaClass(root))
    for (const ctor of reachableSchemaClasses(root)) {
      let instance: Schema
      try {
        instance = new ctor()
      } catch (error) {
        problems.push(`${ctor.name}: constructor threw: ${String(error)}`)
        continue
      }
      const info = instance._ensureInit()
      const known = constructors.get(info.name)
      if (known !== undefined && known !== ctor) {
        problems.push(`two classes share the schemaName "${info.name}"`)
        continue
      }
      constructors.set(info.name, ctor)
      classes.set(info.name, {
        name: info.name,
        fields: info.fields.map((field) => ({
          name: field.name,
          type: field.type,
        })),
      })
    }
  }

  if (problems.length > 0) {
    throw new CodegenError(
      `invalid declarations:\n${[...new Set(problems)].map((p) => `  - ${p}`).join("\n")}`,
    )
  }
  return {
    contracts: contractModels,
    messages: [...messages.values()].sort(byName),
    schemas: [...classes.values()].sort(byName),
  }
}

/**
 * Imports the modules and collects what they export: every contract
 * (`{ client, server }` of message descriptors) and every Schema subclass.
 * The same module may be passed for both.
 */
export async function loadModel(options: {
  readonly contract?: string
  readonly state?: string
}): Promise<CodegenModel> {
  const contracts: Record<string, Contract> = {}
  const roots: SchemaConstructor[] = []
  if (options.contract !== undefined) {
    const module: Record<string, unknown> = await import(
      Bun.pathToFileURL(options.contract).href
    )
    for (const [name, value] of Object.entries(module)) {
      if (isContract(value)) contracts[name] = value
    }
    if (Object.keys(contracts).length === 0) {
      throw new CodegenError(`${options.contract} exports no contract`)
    }
  }
  if (options.state !== undefined) {
    const module: Record<string, unknown> = await import(
      Bun.pathToFileURL(options.state).href
    )
    for (const value of Object.values(module)) {
      if (isSchemaClass(value)) roots.push(value)
    }
    if (roots.length === 0) {
      throw new CodegenError(`${options.state} exports no Schema class`)
    }
  }
  return buildModel(contracts, roots)
}
