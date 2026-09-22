/**
 * The browser entry the audit bundles: everything a game ships to a page.
 * If any of it reached server code, `bun build --target=browser` would pull
 * `@bungohan/core` (and through it `bun:`/`node:` modules) into the graph.
 */
export { createBungohanClient } from "@bungohan/client-js"
export { CounterState, counterContract } from "./shared"
export { App } from "./ui"
