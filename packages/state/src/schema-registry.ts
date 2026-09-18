import type { Schema } from "./schema"

export type SchemaConstructor<T extends Schema = Schema> = new () => T

const registry = new Map<string, SchemaConstructor>()

/**
 * `schemaName → constructor`, used by receivers to instantiate classes named
 * in the wire's class table. Classes auto-register on first `new`, but a
 * client that only ever *receives* a class (e.g. `Player` inside a map) never
 * constructs one itself — register those explicitly.
 */
export const SchemaRegistry = {
  register(...ctors: SchemaConstructor[]): void {
    for (const ctor of ctors) {
      const name = schemaNameOf(ctor)
      if (name !== undefined) registry.set(name, ctor)
    }
  },

  get(name: string): SchemaConstructor | undefined {
    return registry.get(name)
  },

  has(name: string): boolean {
    return registry.has(name)
  },

  getNames(): string[] {
    return [...registry.keys()]
  },

  /** For tests. */
  clear(): void {
    registry.clear()
  },

  /** @internal Called from the Schema constructor; first class wins. */
  _autoRegister(ctor: SchemaConstructor): void {
    const name = schemaNameOf(ctor)
    if (name !== undefined && !registry.has(name)) registry.set(name, ctor)
  },
}

/**
 * The class's *own* `schemaName`. An inherited one doesn't count: a subclass
 * that forgot to declare it would otherwise collide with its parent.
 */
export function schemaNameOf(ctor: SchemaConstructor): string | undefined {
  if (!Object.hasOwn(ctor, "schemaName")) return undefined
  const name: unknown = Reflect.get(ctor, "schemaName")
  return typeof name === "string" && name !== "" ? name : undefined
}
