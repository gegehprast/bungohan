/**
 * Definition-time schema validation (spec §6.8). Core runs this once per
 * room type, when it is defined, and throws on any problem, so the
 * log-and-skip path in `buildClassInfo` never fires for a registered room.
 */
import { SchemaArrayState, SchemaMapState, SchemaSetState } from "./collections"
import { fieldValue, Schema } from "./schema"
import { type SchemaConstructor, schemaNameOf } from "./schema-registry"
import { State } from "./state-base"

function isSchemaClass(value: unknown): value is SchemaConstructor {
  return typeof value === "function" && value.prototype instanceof Schema
}

/**
 * Everything wrong with `root` and every Schema class reachable from it
 * (directly nested fields, collection element classes, and the classes of
 * any initial elements), or `[]`. Checks what `_ensureInit` would otherwise
 * log and skip: malformed collection descriptors, element classes that
 * aren't Schemas, and a missing own `schemaName`. Also reports two
 * reachable classes sharing a `schemaName` (receivers resolve classes by
 * name, so they would decode one as the other).
 *
 * Instantiates each class once with `new` to read its field initializers.
 * A constructor that throws is reported, not propagated.
 */
export function validateSchemaClass(root: SchemaConstructor): string[] {
  const problems: string[] = []
  const byName = new Map<string, SchemaConstructor>()
  const visited = new Set<SchemaConstructor>()
  const queue: SchemaConstructor[] = [root]

  const reach = (ctor: unknown, where: string): void => {
    if (!isSchemaClass(ctor)) {
      problems.push(`${where}: ${String(ctor)} is not a Schema subclass`)
      return
    }
    if (!visited.has(ctor)) queue.push(ctor)
  }

  for (let ctor = queue.shift(); ctor !== undefined; ctor = queue.shift()) {
    if (visited.has(ctor)) continue
    visited.add(ctor)
    const className = ctor.name || "<anonymous>"
    const name = schemaNameOf(ctor)
    if (name === undefined) {
      problems.push(
        `${className}: missing its own static schemaName ` +
          '(add `public static override schemaName = "…"`)',
      )
    } else {
      const other = byName.get(name)
      if (other !== undefined && other !== ctor) {
        problems.push(
          `${className}: schemaName "${name}" is also used by ${other.name}`,
        )
      }
      byName.set(name, ctor)
    }

    let instance: Schema
    try {
      instance = new ctor()
    } catch (error) {
      problems.push(`${className}: constructor threw: ${String(error)}`)
      continue
    }
    for (const key of Object.keys(instance)) {
      if (key.startsWith("_")) continue
      const value = fieldValue(instance, key)
      const where = `${className}.${key}`
      if (value instanceof Schema) {
        reach(value.constructor, where)
      } else if (value instanceof State) {
        const problem = value._declarationError()
        if (problem !== undefined) {
          problems.push(`${where}: ${problem}`)
          continue
        }
        if (
          value._filter !== undefined &&
          typeof value._filter !== "function"
        ) {
          problems.push(`${where}: filter is not a function`)
        }
        if (
          value instanceof SchemaMapState ||
          value instanceof SchemaSetState ||
          value instanceof SchemaArrayState
        ) {
          reach(value._class, where)
          for (const element of value._elements()) {
            reach(element.constructor, where)
          }
        }
      }
    }
  }
  return problems
}
