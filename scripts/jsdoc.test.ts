/**
 * Public API can't lose its docs: every exported member of core,
 * client-js (and /react), schema and testing, and every extension-point
 * interface, needs a JSDoc of its own or one an editor inherits from an
 * interface or base class (see jsdoc.ts for exactly what is checked).
 * `bun scripts/jsdoc.ts` lists what's missing.
 */
import { expect, test } from "bun:test"
import { findProblems, formatProblems } from "./jsdoc"

test("every public member is documented", async () => {
  const { problems, checked } = await findProblems()
  // A walk that found nothing would pass vacuously (e.g. after a change
  // in TypeScript's unstable API); the public surface is far bigger.
  expect(checked).toBeGreaterThan(700)
  expect(formatProblems(problems)).toBe("")
}, 30_000)
