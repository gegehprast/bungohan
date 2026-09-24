/**
 * The published packages, in the order they must be built and published.
 *
 * A package may only be built once every `@bungohan/*` package it imports has
 * a `dist/`: the build compiles each one against its siblings' *built*
 * declarations (see `tsconfig.build.json`), which is also what proves the
 * emitted `.d.ts` files fit together the way a user's install will.
 *
 * `@bungohan/codegen` is missing on purpose: its targets are the deferred C#
 * and Godot clients, so it stays unpublished until they are.
 */
export const PUBLISHED = [
  "result",
  "types",
  "state",
  "schema",
  "serializer",
  "transport",
  "store",
  "backplane",
  "core",
  "client-js",
  "testing",
] as const

export type PublishedName = (typeof PUBLISHED)[number]

/** The repo root, as an absolute path with no trailing slash. */
export const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "")

/** Where a package's sources and `dist/` live. */
export function packageDir(name: string): string {
  return `${ROOT}/packages/${name}`
}

/** The single version every published package carries (spec §13.3). */
export async function version(): Promise<string> {
  const pkg = await Bun.file(`${packageDir(PUBLISHED[0])}/package.json`).json()
  return pkg.version as string
}

/** `https://github.com/<owner>/<repo>`, from the manifests' repository field. */
export const REPO_URL = "https://github.com/gegehprast/bungohan"

/**
 * The docs that name the released version. `bun run version` rewrites the
 * version in each, and `release-docs.test.ts` fails if one drifts from the
 * manifests (the READMEs ship in the tarballs, so npm shows what they say).
 */
export const VERSION_NOTES = [
  "docs/getting-started.md",
  "packages/core/README.md",
  "packages/client-js/README.md",
] as const

const VERSION_NOTE = /(Bungohan is at|Published at) `([^`]+)`/g

/** The versions a doc names, in order. */
export function versionsNamed(text: string): string[] {
  return [...text.matchAll(VERSION_NOTE)].map((match) => match[2] ?? "")
}

/** The doc with every version it names set to `next`. */
export function nameVersion(text: string, next: string): string {
  return text.replace(VERSION_NOTE, (_, phrase) => `${phrase} \`${next}\``)
}
