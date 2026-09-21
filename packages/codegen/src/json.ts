/**
 * `--lang json`: a neutral descriptor that community targets (Rust, Kotlin,
 * Swift, C++, …) can generate from without running TypeScript. Messages
 * use the declaration format of the conformance vectors (PROTOCOL.md §14).
 */
import { type Field, type MessageDef, PROTOCOL_VERSION } from "@bungohan/types"
import type { CodegenModel } from "./model"

/** Descriptor format version; bumped only for a breaking change. */
export const JSON_FORMAT = "bungohan-codegen/1"

function fieldType(field: Field): unknown {
  switch (field.kind) {
    case "fixed":
      return `fixed:${field.decimals}`
    case "enum":
      return { enum: [...field.values] }
    case "array":
      return { array: fieldType(field.of) }
    case "map":
      return { map: fieldType(field.of) }
    case "optional":
      return { optional: fieldType(field.of) }
    case "nested":
      return { nested: declaration(field.message) }
    default:
      return field.kind
  }
}

/** A message as a §14 declaration: `{ name, fields: [[name, type], …] }`. */
export function declaration(def: MessageDef): unknown {
  return {
    name: def.name,
    fields: def.fieldNames.flatMap((name) => {
      const field = def.fields[name]
      return field === undefined ? [] : [[name, fieldType(field)]]
    }),
  }
}

export function generateJson(model: CodegenModel): Map<string, string> {
  const descriptor = {
    format: JSON_FORMAT,
    protocol: PROTOCOL_VERSION,
    contracts: model.contracts.map((contract) => ({
      name: contract.name,
      hash: contract.hash,
      client: contract.client.map((def) => def.name),
      server: contract.server.map((def) => def.name),
      // Only for typed options (PROTOCOL.md §6.2.1): the messages named
      // here are in `messages`; a kind left out is the empty message.
      ...(contract.options === undefined
        ? {}
        : {
            options: {
              ...(contract.options.create === undefined
                ? {}
                : { create: contract.options.create.name }),
              ...(contract.options.join === undefined
                ? {}
                : { join: contract.options.join.name }),
            },
          }),
    })),
    messages: model.messages.map(declaration),
    schemas: model.schemas.map((schema) => ({
      name: schema.name,
      fields: schema.fields.map((field) => [field.name, field.type]),
    })),
  }
  return new Map([
    ["bungohan.json", `${JSON.stringify(descriptor, null, 2)}\n`],
  ])
}
