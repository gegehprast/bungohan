# Bungohan

Authoritative multiplayer game server framework for Bun, with a language-independent wire protocol so clients can be written for any engine (browser/JS, Unity/C#, Godot).

**`REBUILD_SPEC.md` is the source of truth for this implementation.** Read it before writing code. Where it marks a signature `[KEEP]`, implement it exactly as written; `[NEW]`/`[FIX]` items are specified in that document and have no prior implementation to copy.

**`PROTOCOL.md` is authoritative for the wire bytes** (frames, handshake, state ops, both codecs, numeric rules); the spec keeps the rationale and points to it. Change a byte layout there first. `conformance/v1/` is its executable form, run by `bun test`: the hand-written `0xx-*` vectors must never be regenerated (fix them by hand against PROTOCOL.md); the `1xx-*` ones are regenerated with `bun run vectors`.

**When an implementation differs from the reference or from PROTOCOL.md** (or two clients disagree), resolve it in PROTOCOL.md and pin it with a conformance vector that every runner (`bun test`, `test:csharp`, `test:godot`) passes. Never keep it as a local refinement in one implementation: the next client would have nothing to check against.

**`reference/` holds the previous implementation (alpha 1) — read-only.** It is excluded from the workspace, from `tsc`, from Biome, and from `bun test`. Consult it when the spec is silent on some behavior; never edit it, never import from it, and don't try to fix its type or lint errors. See `reference/README.md`. Where the spec and that code disagree, the spec wins.

**Current focus: JavaScript first.** Finish the JS stack — the Bun server, `@bungohan/client-js` and its React hooks — before the other clients. The C# (`clients/csharp`) and Godot (`clients/godot`) clients are deferred, not dropped: don't add features to them or mention them in JS docs and examples, but keep them working. Their checks stay in `bun run verify`, so a wire change that would break them still fails.

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
packages/result  types  state  schema  serializer  transport  store  backplane  core  client-js  codegen  testing
apps/example-shooter/{server,client,shared}
clients/csharp   clients/godot   clients/fixtures      # outside the Bun workspace (spec §4.2.1)
```

`clients/` holds the non-TypeScript clients: C# (`clients/csharp/Bungohan.Protocol`, netstandard2.1, C# 9, no NuGet packages, so it builds for Unity and Godot .NET) and a GDScript Godot addon (`clients/godot/addons/bungohan`). Each is a protocol core plus a networking layer (`Net/`, `net/`) with a pluggable client transport and a poll/pump model — every callback arrives on the thread that calls `Poll()`/`poll()`. Their generated example bindings (`Bungohan.Bindings/Shooter`, `godot/example/shooter`, `fixtures/bungohan.json`) come from `bun run codegen:example`, and the interop test server's (`Bungohan.Bindings/Interop`, `godot/tests/interop`) from `bun run codegen:interop`; never edit them by hand. `clients/fixtures/shooter-stream.*.json` are recordings (`bun apps/example-shooter/server/scripts/record-stream.ts`), not generated vectors: re-recording changes them.

- **All package names are scoped `@bungohan/*`.** The previous implementation used unscoped `gungohan-*` (a typo) — never reproduce that.
- **A game's shared module (state classes + contract) imports only `@bungohan/schema`**, never `@bungohan/core` or `@bungohan/client-js`. That keeps the browser free of server code and the server free of the client package. Core and client-js re-export `@bungohan/schema`, so single-side files can import from their own package.
- Cross-package deps use `"workspace:*"`; shared dependency versions use the root `catalog:` protocol.
- Run a script in one package: `bun --filter @bungohan/state test`

## Commands

```sh
bun run verify                  # ALL SIX CHECKS — run this before calling anything done
bun test                        # all tests
bun --filter @bungohan/state test
bun run check                   # biome check --write
bun run lint                    # biome lint --write && tsc --noEmit
bun run test:csharp             # interop server + dotnet run --project clients/csharp/Bungohan.Protocol.Tests
bun run test:godot              # interop server + godot-mono --headless --script tests/run_all.gd
bun run codegen:example         # regenerate the example bindings after a codegen or shared-module change
bun run codegen:interop         # same, for the interop test server's bindings
```

When a change touches `clients/`, `packages/codegen`, PROTOCOL.md or the vectors, also run the C# and Godot runners (`tests/run_vectors.gd` alone runs just the vectors). Both `test:*` scripts boot a real server through `scripts/interop.ts` (`packages/testing/src/interop/`) and pass its URL as `BUNGOHAN_INTEROP_URL`; the server-side `behavior` vectors and the end-to-end suites need it, and skip without it. `UPDATE_GOLDEN=1 bun test packages/codegen` rewrites the codegen goldens; review their diff.

**Before considering any task done, run `bun run verify` and make it pass.** It runs all six checks the same way every time: `bun test` (with `REDIS_URL`, and it fails if anything was skipped), `tsc --noEmit`, `biome check`, `test:csharp`, `test:godot`, and `check:browser`. Don't substitute a subset: `bun test` alone silently skips the Redis suites and still reports success. If Valkey/Redis or Chromium genuinely isn't available, pass `--no-redis` / `--no-browser`; those show as SKIPPED, and your summary must say so. Writing tests without running them doesn't count as verification.

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

## Docs

User docs live in `docs/` (JavaScript only). Every ts/tsx block in them is copied from a `// #region` in real code — the tutorial app in `apps/tutorial/` or `docs/examples/` — and a `bun test` suite fails if a block is stale, hand-written, or links somewhere that doesn't exist. Never edit a code block in the Markdown directly: change the source file, then run `bun run docs:sync`. When a framework change alters an API, update the affected example code so the docs stay correct.

## Example app

`apps/example-shooter` is the end-to-end reference. Its client uses **Vite + React + Tailwind** — that's deliberate, don't migrate it to Bun's HTML-import bundler. The server app runs under Bun.

When the framework API changes, update this app's call sites; it's the canary for DX regressions.

To check the app in a real browser, run `bun run check:browser` in `apps/example-shooter/server`. It starts the server, the Vite client and two headless Chromium tabs, plays a short game, and decodes the WebSocket frames to confirm one tab's movement reaches the other's state. Use it rather than writing a new browser script. It needs Chromium (or `CHROMIUM=<binary>`) and free ports 6060, 5173 and 9223, so it isn't part of `bun test`.
