import type { Schema } from "./schema"

/**
 * A Schema class, as the factories and joins take it: constructible with
 * no arguments (the receiver builds instances itself).
 */
export type SchemaConstructor<T extends Schema = Schema> = new () => T

const registry = new Map<string, SchemaConstructor>()

/**
 * `schemaName → constructor`, used by receivers to instantiate classes named
 * in the wire's class table. Classes auto-register on first `new`, and a
 * client join registers every class its state class refers to. What's left
 * to register by hand is a subclass used as a collection element that no
 * field declares: without it the client leaves such an element out and
 * reports `UNKNOWN_CLASS`.
 */
export const SchemaRegistry = {
  /**
   * Registers classes under their own `schemaName` (a class without one
   * is skipped). A later registration of a name replaces the earlier one.
   */
  register(...ctors: SchemaConstructor[]): void {
    for (const ctor of ctors) {
      const name = schemaNameOf(ctor)
      if (name !== undefined) registry.set(name, ctor)
    }
  },

  /** The class registered under `name`, if any. */
  get(name: string): SchemaConstructor | undefined {
    return registry.get(name)
  },

  /** Whether a class is registered under `name`. */
  has(name: string): boolean {
    return registry.has(name)
  },

  /** Every registered `schemaName` (a copy). */
  getNames(): string[] {
    return [...registry.keys()]
  },

  /**
   * Forgets every class, for tests that need a clean registry. Classes
   * register again on their next `new` or join.
   */
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
