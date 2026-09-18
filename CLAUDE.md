# Bungohan

Authoritative multiplayer game server framework for Bun, with a language-independent wire protocol so clients can be written for any engine (browser/JS, Unity/C#, Godot).

**`REBUILD_SPEC.md` is the source of truth for this implementation.** Read it before writing code. Where it marks a signature `[KEEP]`, implement it exactly as written; `[NEW]`/`[FIX]` items are specified in that document and have no prior implementation to copy.

**`reference/` holds the previous implementation (alpha 1) — read-only.** It is excluded from the workspace, from `tsc`, from Biome, and from `bun test`. Consult it when the spec is silent on some behavior; never edit it, never import from it, and don't try to fix its type or lint errors. See `reference/README.md`. Where the spec and that code disagree, the spec wins.

## Runtime: Bun, not Node

- `bun <file>` instead of `node <file>` / `ts-node <file>`
- `bun test` instead of jest/vitest
- `bun install` instead of npm/yarn/pnpm install
- `bun run <script>`, `bunx <pkg>` instead of npm run / npx
- Bun loads `.env` automatically — never add `dotenv`

Bun native APIs this project depends on directly:

| API | Used by | Don't use instead |
|---|---|---|
| `Bun.serve()` (WebSocket + HTTP) | `packages/transport` | `express`, `ws` |
| `RedisClient` / `Bun.redis` | `packages/store`, `packages/backplane` | `ioredis`, `redis` |
| `Bun.file` | anywhere file I/O is needed | `node:fs` readFile/writeFile |

Bun API docs are available locally at `node_modules/bun-types/docs/**.mdx`.

## Monorepo layout

Bun workspaces. Packages export raw TypeScript (`"main": "./src/index.ts"`) — no build step for library packages.

```
packages/result  types  state  serializer  transport  store  backplane  core  client-js  codegen  testing
apps/example-shooter/{server,client,shared}
```

- **All package names are scoped `@bungohan/*`.** The previous implementation used unscoped `gungohan-*` (a typo) — never reproduce that.
- Cross-package deps use `"workspace:*"`; shared dependency versions use the root `catalog:` protocol.
- Run a script in one package: `bun --filter @bungohan/state test`

## Commands

```sh
bun test                        # all tests
bun --filter @bungohan/state test
bun run check                   # biome check --write
bun run lint                    # biome lint --write && tsc --noEmit
```

**Before considering any task done, run `bun test` and `bunx tsc --noEmit` and make them pass.** Writing tests without running them doesn't count as verification.

## Code style

Enforced by Biome (`biome.json`) — match it when writing code so the formatter is a no-op:

- **No semicolons** unless syntactically required (`"semicolons": "asNeeded"`)
- **Double quotes**, 2-space indent, **80 column** line width
- **Explicit member accessibility is mandatory** — every class member needs `public` / `private` / `protected`. This is an error-level lint rule, not a preference.
- Imports are auto-organized; use `import type` where applicable (`verbatimModuleSyntax` is on)

TypeScript (`tsconfig.json`): `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride` are all on. Respect them:

- Indexed access yields `T | undefined` — handle it, don't assert it away
- Overriding a base method requires the `override` keyword
- **No `any`.** Use `unknown` and narrow.

> The current `tsconfig.json` still sets `experimentalDecorators`, `emitDecoratorMetadata`, and `"Decorators"` in `lib`. These are leftovers from an abandoned decorator-based schema design. The rebuild uses **no decorators** (see `REBUILD_SPEC.md` §2, §5) — remove those three settings.

## Architecture rules

These are non-negotiable and come from the spec:

1. **Result pattern, not exceptions.** Any API operation that can fail returns `Result<T, E>` from `@bungohan/result` (construct with `ok()` / `err()`, narrow with `isOk()` / `isErr()`). Framework code does not throw.
   - Exception: **user lifecycle hooks** (`onCreate`, `onAuth`, `onJoin`, `onLeave`, `onTick`, `onDispose`) are user code and may throw. The framework catches and logs; it does not propagate.
   - Exception: **definition-time programmer errors** — malformed message or schema declarations, detected once when the declaring module loads — may throw. Crashing at startup beats silently desyncing every client. Never throw on a per-message, per-tick, or per-connection path.
2. **Interface-first.** `ITransport`, `ISerializer`, `IStore`, `IBackplane` are the only extension points core depends on. Never hardcode a concrete implementation into core logic.
3. **No decorators, no reflection metadata.** State schema uses plain class fields holding factory-created wrappers (`createNumber()`, `createString()`, …).
4. **Type safety is compile-time only.** Message contracts (§4.1) give authoring-time checking and autocomplete. Do **not** add per-message runtime validation to the hot path.
5. **`client-js` must run in a browser** — no Bun/Node-only APIs, and it never imports `@bungohan/core`.
6. **Bandwidth matters.** This framework exists partly to minimize bytes on the wire. Don't casually add fields to the wire format, re-serialize whole values, or send anything on an idle tick.

## Testing

Colocated `*.test.ts` next to the module under test, using `bun:test`.

```ts
import { test, expect } from "bun:test"
```

- Use `@bungohan/testing`'s loopback transport + manual clock for integration tests — advance time with `await harness.tick(16)`, never `setTimeout`/sleep. Tests must be deterministic.
- Bandwidth assertions (spec §11.1) and protocol conformance vectors (§11.3) are real test suites, not documentation.

## Known gotchas

- **Class field initialization order.** Derived-class field initializers run *after* the base constructor returns, so a base constructor cannot see subclass fields via `Object.keys(this)`. Schema initialization is therefore lazy (spec §5.1) — do not "simplify" it into the constructor.
- **MessagePack encoder buffer aliasing.** `Encoder.encode()` returns a view into a reused internal buffer. Safe to hand to a synchronous broadcast; **copy it first** if the payload is queued or retained past the current tick.
- **Numeric ids are never baked into generated client code.** Message-type and schema-class ids come from the join handshake and resolve by name at runtime (spec §4.2), so a stale Unity/Godot build can't silently desync.

## Example app

`apps/example-shooter` is the end-to-end reference. Its client uses **Vite + React + Tailwind** — that's deliberate, don't migrate it to Bun's HTML-import bundler. The server app runs under Bun.

When the framework API changes, update this app's call sites; it's the canary for DX regressions.
