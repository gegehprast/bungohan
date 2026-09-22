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
export const REPO_URL = "https://github.com/gegehprast/bungohan-alpha2"
