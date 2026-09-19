/**
 * Identifier conversion for the target languages. Wire names (message,
 * field and class names) never change: only the generated identifiers
 * follow each language's style.
 */

/** Words of a name: split at non-alphanumerics and camelCase boundaries. */
function words(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word !== "")
}

/**
 * PascalCase for C# members and types: `isDead` → `IsDead`. A name's own
 * casing is kept apart from its first letter, so `HTTPPort` stays as is.
 * Characters that can't appear in an identifier become `_`, so distinct
 * class names like `G.Vec` and `GVec` stay distinct.
 */
export function pascal(name: string): string {
  let out = name.replace(/[^A-Za-z0-9_]/g, "_")
  out = out.charAt(0).toUpperCase() + out.slice(1)
  return /^[0-9]/.test(out) ? `_${out}` : out || "_"
}

/** snake_case for GDScript members and file names: `isDead` → `is_dead`. */
export function snake(name: string): string {
  const out = words(name)
    .map((word) => word.toLowerCase())
    .join("_")
  return /^[0-9]/.test(out) ? `_${out}` : out || "_"
}

/** UPPER_SNAKE for GDScript constants: `red` → `RED`. */
export function upperSnake(name: string): string {
  return snake(name).toUpperCase()
}

/**
 * Picks a name not in `taken` (appending `_` until it is free), and takes it.
 */
export function claim(name: string, taken: Set<string>): string {
  let out = name
  while (taken.has(out)) out += "_"
  taken.add(out)
  return out
}
