/**
 * Finds public API without JSDoc.
 *
 *     bun scripts/jsdoc.ts        # list what's missing (what the test asserts)
 *
 * It asks the TypeScript 7 checker (through its `typescript/unstable/async`
 * API, which spawns the bundled `tsgo`) for everything each public entry
 * point exports, following re-exports the way an editor does. Every
 * exported symbol needs a doc comment, and so does every public or
 * protected member (static ones too) of an exported class or interface,
 * every enum member, and every property of an exported object type alias
 * or object-literal constant (`f.int8`), including members inherited from
 * another of our types.
 *
 * A class or interface member without a doc of its own passes when a type
 * it `extends` or `implements` documents a member of the same name: an
 * editor shows that doc on hover, so the class keeps only what is specific
 * to it. The reverse (a doc on the class, none on the interface) fails,
 * because code holding the interface sees nothing.
 *
 * Public docs must also stand on their own: a `§` (a spec or PROTOCOL.md
 * citation) fails, and so does a `docs/….md` or `docs/….md#anchor`
 * reference to a page or heading that doesn't exist. A class member whose
 * doc is a copy of the one it inherits fails too: the class should say
 * only what is specific to it.
 *
 * What it can't catch: a doc that says nothing ("Gets the id"), a doc
 * that's out of date or wrong, a contract paraphrased onto a class rather
 * than copied, `@param`s, the fields of an inline object type in a
 * signature or property (`memoryUsage: { … }`), the members of a union
 * type alias, overload signatures after the first documented one,
 * constructors (the class doc covers them), and types that are only
 * reachable (a return type) without being exported from an entry point.
 * Members named `_x` or `#x` and `private` members are skipped, as are
 * members declared outside this repository (`lib.dom`, `Error`'s
 * `message`).
 *
 * The API is marked unstable. If a TypeScript upgrade changes it, this
 * breaks loudly (a type error, a throw, or the test's floor on the number
 * of declarations checked), never silently.
 */
import { join, relative } from "node:path"
import { type Node, SyntaxKind } from "typescript/unstable/ast"
import {
  API,
  type Symbol as Sym,
  SymbolFlags,
  TypeFlags,
} from "typescript/unstable/async"
import { anchorsOf } from "./docs-snippets"

const ROOT = join(import.meta.dir, "..")

/** Entry points whose every export is public API. */
const FULL = [
  "packages/core/src/index.ts",
  "packages/client-js/src/index.ts",
  "packages/client-js/src/react/index.ts",
  "packages/schema/src/index.ts",
  "packages/testing/src/index.ts",
]

/**
 * Lower-level packages: only their extension points (and what those hand
 * an implementer) are held to the rule.
 */
const EXTENSION_POINTS: Record<string, string[]> = {
  "packages/transport/src/index.ts": ["ITransport", "ConnectionContext"],
  "packages/store/src/index.ts": ["IStore"],
  "packages/backplane/src/index.ts": ["IBackplane"],
  "packages/serializer/src/index.ts": [
    "ISerializer",
    "IStateCodec",
    "IStateCodecSession",
  ],
  "packages/client-js/src/index.ts": [
    "IClientTransport",
    "ClientSocket",
    "ClientSocketHandlers",
  ],
  "packages/types/src/index.ts": ["Clock"],
}

export interface Problem {
  /** `path:line`, relative to the repository root. */
  where: string
  /** `Export` or `Export.member`. */
  name: string
  reason:
    | "undocumented"
    | "cites the spec"
    | "repeats the inherited doc"
    | `links to a missing ${string}`
}

/** The parts of a declaration node this check reads. */
type AstNode = Node & {
  readonly parent: AstNode | undefined
  readonly name?: { readonly text?: string }
  readonly jsDoc?: readonly unknown[]
  readonly modifiers?: readonly { kind: number }[]
  readonly heritageClauses?: readonly {
    readonly token: number
    readonly types: readonly AstNode[]
  }[]
}

const MEMBERS =
  SymbolFlags.Property |
  SymbolFlags.Method |
  SymbolFlags.GetAccessor |
  SymbolFlags.SetAccessor |
  SymbolFlags.EnumMember

const DOCS_LINK = /\bdocs\/[\w./-]+\.md(?:#[\w-]+)?/g

/** The first `docs/` reference in `doc` that doesn't resolve, if any. */
async function brokenDocsLink(doc: string): Promise<string | undefined> {
  for (const [link] of doc.matchAll(DOCS_LINK)) {
    const [path = "", anchor] = link.split("#")
    const file = Bun.file(join(ROOT, path))
    if (!(await file.exists())) return path
    if (anchor !== undefined && !anchorsOf(await file.text()).has(anchor)) {
      return link
    }
  }
  return undefined
}

/** What a run found, and how much it looked at. */
export interface Report {
  problems: Problem[]
  /** Declarations checked: a floor on this catches a check gone blind. */
  checked: number
}

export async function findProblems(): Promise<Report> {
  const api = new API({ cwd: ROOT })
  try {
    const snapshot = await api.updateSnapshot({
      openProject: join(ROOT, "tsconfig.json"),
    })
    const project = snapshot.getProjects()[0]
    if (project === undefined) throw new Error("no TypeScript project")
    const checker = project.checker
    const problems: Problem[] = []
    const seen = new Set<string>()
    let checked = 0
    const lines = new Map<string, number[]>()

    const firstDecl = async (symbol: Sym): Promise<AstNode | undefined> => {
      const handle = symbol.declarations[0]
      if (handle === undefined) return undefined
      return (await handle.resolve(project)) as AstNode | undefined
    }

    const inRepo = (node: AstNode): boolean => {
      const file = node.getSourceFile().fileName
      return file.startsWith(ROOT) && !file.includes("/node_modules/")
    }

    const where = async (node: AstNode): Promise<string> => {
      const sf = node.getSourceFile()
      let starts = lines.get(sf.fileName)
      if (starts === undefined) {
        starts = [0]
        const text = sf.text
        for (let i = 0; i < text.length; i++) {
          if (text.charCodeAt(i) === 10) starts.push(i + 1)
        }
        lines.set(sf.fileName, starts)
      }
      const pos = node.getStart(sf)
      let line = 0
      while (line + 1 < starts.length && (starts[line + 1] ?? 0) <= pos) line++
      return `${relative(ROOT, sf.fileName)}:${line + 1}`
    }

    const report = async (
      node: AstNode,
      name: string,
      doc: { own: string; inherited: string },
    ): Promise<void> => {
      const key = `${node.getSourceFile().fileName}:${node.pos}`
      if (seen.has(key)) return
      seen.add(key)
      checked++
      const own = doc.own.trim()
      const inherited = doc.inherited.trim()
      let reason: Problem["reason"] | undefined
      const broken = await brokenDocsLink(own)
      if (own === "" && inherited === "") reason = "undocumented"
      else if (own.includes("§")) reason = "cites the spec"
      else if (broken !== undefined) reason = `links to a missing ${broken}`
      else if (own !== "" && own === inherited) {
        reason = "repeats the inherited doc"
      }
      if (reason !== undefined) {
        problems.push({ where: await where(node), name, reason })
      }
    }

    /**
     * The member's own doc, and the doc an editor would fall back to: the
     * one on the same-named member of a type its declaring class or
     * interface extends or implements. The checker already does that
     * fallback, so "own" is read only when the declaration has a JSDoc
     * block of its own.
     */
    const docsOf = async (
      member: Sym,
      decl: AstNode,
    ): Promise<{ own: string; inherited: string }> => ({
      own:
        (decl.jsDoc?.length ?? 0) > 0
          ? await member.getDocumentationComment(checker)
          : "",
      inherited: await inheritedDoc(member, decl),
    })

    const inheritedDoc = async (
      member: Sym,
      decl: AstNode,
    ): Promise<string> => {
      for (const clause of decl.parent?.heritageClauses ?? []) {
        for (const typeNode of clause.types) {
          const base = await checker.getTypeAtLocation(typeNode)
          if (base === undefined) continue
          const inherited = await checker.getPropertyOfType(base, member.name)
          if (inherited === undefined || inherited.id === member.id) continue
          // The checker's answer already includes that member's own
          // fallback to its bases.
          const doc = (await inherited.getDocumentationComment(checker)).trim()
          if (doc !== "") return doc
        }
      }
      return ""
    }

    const isHidden = (member: Sym, decl: AstNode): boolean =>
      member.name.startsWith("_") ||
      member.name.startsWith("#") ||
      member.name.startsWith("__") ||
      (decl.modifiers ?? []).some((m) => m.kind === SyntaxKind.PrivateKeyword)

    const checkMembers = async (
      owner: string,
      members: Iterable<Sym>,
    ): Promise<void> => {
      for (const member of members) {
        if ((member.flags & MEMBERS) === 0) continue
        const decl = await firstDecl(member)
        if (decl === undefined || !inRepo(decl) || isHidden(member, decl)) {
          continue
        }
        // Named after the type that declares it, which may be a base of
        // the export that led here.
        const declaredIn = decl.parent?.name?.text ?? owner
        await report(
          decl,
          `${declaredIn}.${member.name}`,
          await docsOf(member, decl),
        )
      }
    }

    const checkExport = async (exported: Sym): Promise<void> => {
      const symbol =
        exported.flags & SymbolFlags.Alias
          ? await checker.getAliasedSymbol(exported)
          : exported
      const decl = await firstDecl(symbol)
      if (decl === undefined || !inRepo(decl)) return
      await report(decl, exported.name, {
        own: await symbol.getDocumentationComment(checker),
        inherited: "",
      })
      if (symbol.flags & (SymbolFlags.Class | SymbolFlags.Interface)) {
        const type = await checker.getDeclaredTypeOfSymbol(symbol)
        await checkMembers(
          exported.name,
          await checker.getPropertiesOfType(type),
        )
      }
      if (symbol.flags & (SymbolFlags.Class | SymbolFlags.Enum)) {
        // Statics, and enum members.
        await checkMembers(exported.name, (await symbol.getExports()).values())
      }
      const alias = symbol.flags & SymbolFlags.TypeAlias
      if (alias || symbol.flags & SymbolFlags.Variable) {
        const type = alias
          ? await checker.getDeclaredTypeOfSymbol(symbol)
          : await checker.getTypeOfSymbol(symbol)
        // Only an object literal (type) written right there, not a union's
        // shared members, a mapped type's keys or a named type's members.
        const props =
          type === undefined || type.flags & TypeFlags.Union
            ? []
            : await checker.getPropertiesOfType(type)
        const own: Sym[] = []
        for (const prop of props) {
          const propDecl = await firstDecl(prop)
          if (
            propDecl !== undefined &&
            propDecl.pos > decl.pos &&
            propDecl.end <= decl.end &&
            propDecl.getSourceFile().fileName === decl.getSourceFile().fileName
          ) {
            own.push(prop)
          }
        }
        await checkMembers(exported.name, own)
      }
    }

    const exportsOf = async (entry: string): Promise<Sym[]> => {
      const file = await project.program.getSourceFile(join(ROOT, entry))
      if (file === undefined) throw new Error(`not in the project: ${entry}`)
      const module = await checker.getSymbolAtLocation(file)
      if (module === undefined) throw new Error(`no module symbol: ${entry}`)
      return [...(await checker.getExportsOfModule(module))]
    }

    for (const entry of FULL) {
      for (const exported of await exportsOf(entry)) await checkExport(exported)
    }
    for (const [entry, names] of Object.entries(EXTENSION_POINTS)) {
      const exported = await exportsOf(entry)
      for (const name of names) {
        const symbol = exported.find((s) => s.name === name)
        if (symbol === undefined) throw new Error(`${entry} lacks ${name}`)
        await checkExport(symbol)
      }
    }
    problems.sort((a, b) =>
      a.where.localeCompare(b.where, "en", { numeric: true }),
    )
    return { problems, checked }
  } finally {
    await api.close()
  }
}

export function formatProblems(problems: readonly Problem[]): string {
  const line = (p: Problem): string =>
    p.reason === "undocumented"
      ? `${p.where}  ${p.name}`
      : `${p.where}  ${p.name} (${p.reason})`
  return problems.map(line).join("\n")
}

if (import.meta.main) {
  const { problems, checked } = await findProblems()
  if (problems.length > 0) console.log(formatProblems(problems))
  console.log(`${checked} declarations checked, ${problems.length} problem(s)`)
  process.exitCode = problems.length === 0 ? 0 : 1
}
