# Bungohan

Authoritative multiplayer game server framework for Bun, with a language-independent wire protocol so clients can be written for any engine (browser/JS, Unity/C#, Godot).

**`REBUILD_SPEC.md` is the source of truth for this implementation.** Read it before writing code. Where it marks a signature `[KEEP]`, implement it exactly as written; `[NEW]`/`[FIX]` items are specified in that document and have no prior implementation to copy.

**`PROTOCOL.md` is authoritative for the wire bytes** (frames, handshake, state ops, both codecs, numeric rules); the spec keeps the rationale and points to it. Change a byte layout there first. `conformance/v1/` is its executable form, run by `bun test`: the hand-written `0xx-*` vectors must never be regenerated (fix them by hand against PROTOCOL.md); the `1xx-*` ones are regenerated with `bun run vectors`.

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
clients/csharp   clients/godot   clients/fixtures      # outside the Bun workspace (spec §4.2.1)
```

`clients/` holds the non-TypeScript protocol cores: C# (`clients/csharp/Bungohan.Protocol`, netstandard2.1, C# 9, no NuGet packages, so it builds for Unity and Godot .NET) and a GDScript Godot addon (`clients/godot/addons/bungohan`). Their generated example bindings (`Bungohan.Bindings/Shooter`, `godot/example/shooter`, `fixtures/bungohan.json`) come from `bun run codegen:example`; never edit them by hand. `clients/fixtures/shooter-stream.*.json` are recordings (`bun apps/example-shooter/server/scripts/record-stream.ts`), not generated vectors: re-recording changes them.

- **All package names are scoped `@bungohan/*`.** The previous implementation used unscoped `gungohan-*` (a typo) — never reproduce that.
- Cross-package deps use `"workspace:*"`; shared dependency versions use the root `catalog:` protocol.
- Run a script in one package: `bun --filter @bungohan/state test`

## Commands

```sh
bun test                        # all tests
bun --filter @bungohan/state test
bun run check                   # biome check --write
bun run lint                    # biome lint --write && tsc --noEmit
bun run test:csharp             # dotnet run --project clients/csharp/Bungohan.Protocol.Tests
bun run test:godot              # cd clients/godot && godot-mono --headless --script tests/run_all.gd
bun run codegen:example         # regenerate the example bindings after a codegen or shared-module change
```

When a change touches `clients/`, `packages/codegen`, PROTOCOL.md or the vectors, also run the C# and Godot runners (`tests/run_vectors.gd` alone runs just the vectors). `UPDATE_GOLDEN=1 bun test packages/codegen` rewrites the codegen goldens; review their diff.

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

- Core's end-to-end suites live in `packages/testing/src/core/` (testing depends on core, so this avoids a cycle). They run a real server via `createServerHarness` and speak the wire protocol through the `TestClient` driver.
- client-js end-to-end suites live in `packages/testing/src/client-js/` and use `createTestHarness`, whose `connect()` returns a real `BungohanClient` on the harness's loopback and clock (spec §11.2).
- Use `@bungohan/testing`'s loopback transport + manual clock for integration tests — advance time with `await harness.tick(16)`, never `setTimeout`/sleep. Tests must be deterministic.
- Bandwidth assertions (spec §11.1) and protocol conformance vectors (§11.3) are real test suites, not documentation.

## Known gotchas

- **Class field initialization order.** Derived-class field initializers run *after* the base constructor returns, so a base constructor cannot see subclass fields via `Object.keys(this)`. Schema initialization is therefore lazy (spec §5.1) — do not "simplify" it into the constructor.
- **MessagePack buffers.** In `@msgpack/msgpack` 3.1.3, `Encoder.encode()` returns a copy, so its output is safe to keep. Only `encodeSharedRef()` returns a view into the encoder's reused buffer; don't use it for anything queued or retained. Re-check this if the library is upgraded.
- **Type binary buffers precisely.** Under TypeScript 7, `WebSocket.send` only accepts views over a regular `ArrayBuffer`, so a plain `Uint8Array` (which could be backed by a `SharedArrayBuffer`) is rejected. Functions that allocate with `new Uint8Array(n)` should declare `Uint8Array<ArrayBuffer>` as their return type, not widen it to `Uint8Array`, and should never cast.
- **GDScript has no exceptions.** A typed function cut short by a script error returns its type's default (`""` for `-> String`), so a failing check can read as a pass. The Godot runners extend `clients/godot/tests/harness.gd`, which fails the run on any logged engine/script error; keep new suites under it. Also: `String == int` is a runtime error in Godot 4 (check `typeof` first), a Godot `String` can't hold U+0000, and Godot's own JSON/float parsing isn't correctly rounded (the runners use `tests/json_exact.gd`). PROTOCOL.md §15 has the rest.
- **Numeric ids are never baked into generated client code.** Message-type and schema-class ids come from the join handshake and resolve by name at runtime (spec §4.2), so a stale Unity/Godot build can't silently desync.

## Example app

`apps/example-shooter` is the end-to-end reference. Its client uses **Vite + React + Tailwind** — that's deliberate, don't migrate it to Bun's HTML-import bundler. The server app runs under Bun.

When the framework API changes, update this app's call sites; it's the canary for DX regressions.

To check the app in a real browser, run `bun run check:browser` in `apps/example-shooter/server`. It starts the server, the Vite client and two headless Chromium tabs, plays a short game, and decodes the WebSocket frames to confirm one tab's movement reaches the other's state. Use it rather than writing a new browser script. It needs Chromium (or `CHROMIUM=<binary>`) and free ports 6060, 5173 and 9223, so it isn't part of `bun test`.
