/**
 * The docs' code can't rot: every ts/tsx block in docs/ and the package
 * READMEs must be a current copy of a region of a real, typechecked and
 * tested file (see docs-snippets.ts). `bun run docs:sync` fixes drift.
 */
import { describe, expect, test } from "bun:test"
import { extractRegion, processDoc, run, slug } from "./docs-snippets"

describe("the docs", () => {
  test("every snippet is current, and every link resolves", async () => {
    const problems = await run(false)
    const lines = problems.map((p) => `${p.file}:${p.line}: ${p.message}`)
    expect(lines).toEqual([])
  })
})

describe("the checker", () => {
  const source = [
    "import x from 'y'",
    "// #region outer",
    "function a() {",
    "  // #region inner",
    "  return 1",
    "  // #endregion inner",
    "}",
    "// #endregion outer",
    "class K {",
    "  // #region member",
    "  public m = 1",
    "",
    "  // #endregion member",
    "}",
  ].join("\n")

  test("extracts regions, dropping nested markers and indentation", () => {
    expect(extractRegion(source, "outer")).toEqual({
      code: "function a() {\n  return 1\n}",
    })
    expect(extractRegion(source, "inner")).toEqual({ code: "return 1" })
    expect(extractRegion(source, "member")).toEqual({ code: "public m = 1" })
    expect(extractRegion(source, "nope")).toEqual({
      error: 'no "#region nope"',
    })
  })

  const read = async (path: string) =>
    path.endsWith("src/a.ts") ? source : undefined

  test("rewrites a stale snippet with a link to its source", async () => {
    const doc = [
      "# T",
      "<!-- snippet: src/a.ts#inner -->",
      "stale",
      "<!-- /snippet -->",
    ].join("\n")
    const { output, problems } = await processDoc("docs/t.md", doc, "/r", read)
    expect(problems).toEqual([])
    expect(output).toBe(
      [
        "# T",
        "<!-- snippet: src/a.ts#inner -->",
        "[`src/a.ts`](../src/a.ts)",
        "",
        "```ts",
        "return 1",
        "```",
        "<!-- /snippet -->",
      ].join("\n"),
    )
  })

  test("refuses hand-written code, missing regions and dead links", async () => {
    const doc = [
      "# T",
      "```ts",
      "const handWritten = 1",
      "```",
      "```sh",
      "bun test",
      "```",
      "<!-- snippet: src/a.ts#gone -->",
      "<!-- /snippet -->",
      "[dead](./missing.md) [self](#t) [bad](#nope)",
    ].join("\n")
    const { problems } = await processDoc("docs/t.md", doc, "/r", read)
    expect(problems.map((p) => [p.line, p.message.split(":")[0]])).toEqual([
      [2, "a `ts` block outside a snippet"],
      [8, "snippet src/a.ts#gone"],
      [10, "link to ./missing.md"],
      [10, "link to #nope"],
    ])
  })

  test("anchors follow GitHub's heading slugs", () => {
    expect(slug("Join and create options")).toBe("join-and-create-options")
    expect(slug("`schemaName` is required")).toBe("schemaname-is-required")
    expect(slug("Limits (and their defaults)")).toBe(
      "limits-and-their-defaults",
    )
  })
})
