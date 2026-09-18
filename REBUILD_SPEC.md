# Bungohan — Rebuild Specification

> **Purpose**: This is a from-scratch implementation spec for Bungohan, an authoritative multiplayer game server framework for Bun. It is derived from reading the actual working implementation of the previous codebase (not the earlier aspirational design docs), so every API shown here either (a) already worked in the prior codebase and should be reproduced as-is, or (b) is explicitly marked **[NEW]** / **[FIX]** where this rebuild intentionally changes or completes something the old code left unfinished or inconsistent. Feed this whole file to Claude as the spec for the new implementation.

## 0. What changed vs. the original SPEC.md

The original `SPEC.md` in this repo described an idealized design. Reading the actual code that got built revealed drift. This rebuild spec resolves that drift explicitly, rather than silently repeating either the old doc or the old code's inconsistencies:

| Area | Old SPEC.md said | Code actually did | This rebuild does |
|---|---|---|---|
| Package names | Scoped `@bungohan/core`, `@bungohan/result`, etc. | Unscoped `gungohan-core`, `gungohan-result`, etc. (typo'd) | **[FIX]** Use scoped `@bungohan/*` consistently everywhere — package.json names, imports, docs. |
| State/schema API | Decorator-based: `@type("number")`, `@type(Player)`, `@filter(fn)` | Factory-function based: `createNumber()`, `createString()`, plain class fields, manual `_init()` — no decorators, no `@filter` at all | **[KEEP CODE BEHAVIOR, FIX ERGONOMICS]** Keep the factory-function model (it's simpler, no decorator/metadata magic, no `experimentalDecorators` footgun) but add the per-client `@filter`-equivalent capability (see §5.6) since visibility filtering is a real, needed feature that was simply never built. |
| Server options | Top-level `port`, `transport?: {...} \| ITransport` union | No top-level `port`; `transport` is always the nested-object form | **[FIX]** Drop the union type entirely; port only lives at `transport.config.port`, matching what actually worked. |
| Server lifecycle callbacks | `server.onJoin(...)`, `server.onLeave(...)` | Not implemented on `BungohanServer` at all; only `RoomManager.onRoomCreated`/`onRoomDisposed` existed | **[NEW]** Implement `server.onConnect`, `server.onJoin`, `server.onLeave`, `server.onError` as originally intended — these are genuinely useful and were just never finished. |
| Browser SDK React hooks | `useBungohan`, `useRoom`, `useRoomState`, `BungohanProvider` | Did not exist in the package; example app hand-rolled its own hook | **[NEW]** Build a real `@bungohan/client-js/react` subpath with these hooks (§7.4). |
| Cluster process discovery | Implied full cross-process load balancing | `MatchMaker._getAllProcesses()` was a stub returning only local process info | **[NEW]** Finish real cross-process `PROCESS_INFO` aggregation via the backplane (§6.4). |
| Wire format / bandwidth | Not addressed | Whole-value re-serialization on any change, nanoid string `refId`s, string property keys, class names repeated per instance | **[NEW]** Full wire-format redesign for minimum bandwidth: numeric refIds, one-time class/field handshake, positional array encoding, true structural collection diffs, opt-in lossy numeric compaction, transport compression (§5.7). |
| Serializer | One generic serializer for everything | Module-level `encode()`/`decode()` calls (fresh `Encoder` per call), message-type strings re-sent on every message | **[NEW]** Split into two paths: MessagePack for arbitrary room messages (with instance reuse, encode-once-broadcast, message-type interning) and a schema-aware `SchemaCodec` with no per-value type tags for state sync (§8.1). |
| Message type safety | `onMessage<T>` with `T` asserted; `send`/`broadcast` took `unknown` | Same — no checking in either direction | **[NEW]** Contract-based typing (§4.1): message names and payload shapes are compile-checked on `send`, `broadcast`, and `onMessage`. Untyped `*Raw` variants remain for dynamic payloads. |
| Client targets | Browser/JS assumed | JS-only, `browser-sdk` | **[NEW]** Protocol-first and client-agnostic: `PROTOCOL.md` + conformance vectors (§11.3) as deliverables, `@bungohan/codegen` emitting C#/GDScript/JSON bindings (§4.2), `browser-sdk` renamed `client-js` as the reference implementation. |
| Testing | Mock implementations suggested | Unit tests only; no way to run client+server together | **[NEW]** `@bungohan/testing` loopback transport + manual clock (§11.2), plus language-neutral conformance vectors (§11.3). |
| Everything else (Room lifecycle hooks, MatchMaker methods, Result pattern, error codes, transport/serializer/store/backplane interfaces) | — | Matched the design closely | **[KEEP]** Reproduce as verified against the working code, signatures below are exact. |

Read every section below as authoritative for the new build. Where marked **[KEEP]**, the signature shown is taken from working, tested code — implement it exactly. Where marked **[NEW]** or **[FIX]**, build it as specified here; nothing upstream in the old repo can be copied for that part.

## 1. Project Overview

Bungohan is an authoritative multiplayer game server framework for Bun, written in TypeScript, with a documented language-independent wire protocol so clients can be written for any engine or runtime. It's composed of a server-side core, a reference JavaScript client, a codegen CLI for other languages, and a set of small single-purpose packages the core composes.

**Monorepo layout** (Bun workspaces, matching the existing repo structure):

```
packages/
  result/         @bungohan/result      — Result<T, E> type, no dependencies
  types/          @bungohan/types       — wire-protocol types + message contract builders (§4.1), shared by core + clients
  state/          @bungohan/state       — Schema state system + delta sync (no decorators)
  serializer/     @bungohan/serializer  — ISerializer + JSON/MessagePack + SchemaCodec (§8.1)
  transport/      @bungohan/transport   — ITransport + WebSocket (Bun native) implementation
  store/          @bungohan/store       — IStore + Redis implementation (Bun native RedisClient)
  backplane/      @bungohan/backplane   — IBackplane + Redis pub/sub implementation
  core/           @bungohan/core        — Server, Room, MatchMaker (depends on all of the above)
  client-js/      @bungohan/client-js   — reference client implementation + React hooks
  codegen/        @bungohan/codegen     — CLI emitting C#/GDScript/JSON client bindings (§4.2)
  testing/        @bungohan/testing     — loopback transport + manual clock harness (§11.2)
apps/
  example-shooter/{server,client,shared} — reference app exercising the full API
```

**Bungohan is client-agnostic.** The wire protocol — not the JavaScript SDK — is the product. `@bungohan/client-js` is the *reference implementation* of a documented protocol that Unity (C#), Godot (GDScript/C#), and any other runtime can implement independently. This makes `PROTOCOL.md` (byte-level wire format, handshake sequence, codec rules) a first-class deliverable alongside the code, and it's why §8.1.2's codec is specified in portable primitives — varint, zigzag, bit-packing — rather than anything JS-specific.

> Naming note: the previous package was called `browser-sdk`, which implied the browser is the privileged target. Renamed to `client-js` to make the multi-target stance explicit. React hooks (§7.4) remain a JS-only convenience layer on top of it, not part of the protocol.

Every package name is scoped `@bungohan/*`. Internal cross-package imports use these scoped names — never the unscoped `gungohan-*` form that leaked into the previous implementation.

## 2. Architecture Principles

1. **Interface-first design** — `ITransport`, `ISerializer`, `IStore`, `IBackplane` are the only extension points core depends on. Default implementations (WebSocket, MessagePack, Redis) are swappable via constructor options, never hardcoded.
2. **Result pattern over exceptions** — every *API operation* that can fail (MatchMaker, Room's public/protected non-hook methods, client-js Client/Room) returns `Result<T, E>` from `@bungohan/result`. **Lifecycle hooks** (`onCreate`, `onAuth`, `onJoin`, `onLeave`, `onTick`, `onDispose`, etc.) are user code and may throw — the framework catches and logs, it does not propagate.
3. **No decorators, no reflection metadata** — state schema is defined with plain class fields assigned factory-created wrapper objects (`createNumber()`, `createString()`, etc.), initialized lazily on first use (§5.1). This avoids TS decorator/metadata configuration entirely and keeps the type system simple: a field's type is exactly the wrapper's generic parameter, inferred normally by TypeScript.
4. **Test-driven** — every package ships colocated `*.test.ts` files using `bun:test`. Interfaces get mock implementations for isolated testing (mock transport, mock store, mock backplane).
5. **Performance first** — metrics collection is opt-in and off by default; delta sync only re-serializes changed schema instances, not the whole tree; hot paths (tick loop, delta generation) avoid allocation where reasonable.
6. **Graceful degradation** — reconnection via token, state preserved during a disconnect grace period, clean shutdown hooks for SIGTERM/SIGINT.

## 3. `@bungohan/result` — Result Type

**[KEEP]** — exact API from the working `result` package.

```typescript
class Ok<T> {
  readonly value: T;
  isOk(): this is Ok<T>;
  isErr(): this is Err<never>;
  unwrap(): T;
  unwrapOr(fallback: T): T;
  map<U>(fn: (value: T) => U): Result<U, never>;
  mapErr<F extends Error>(fn: (error: never) => F): Result<T, F>;
  andThen<U, F extends Error>(fn: (value: T) => Result<U, F>): Result<U, F>;
}

class Err<E extends Error> {
  readonly error: E;
  isOk(): this is Ok<never>;
  isErr(): this is Err<E>;
  unwrap(): never; // throws `error`
  unwrapOr<T>(fallback: T): T;
  map<U>(fn: (value: never) => U): Result<U, E>;
  mapErr<F extends Error>(fn: (error: E) => F): Result<never, F>;
  andThen<U, F extends Error>(fn: (value: never) => Result<U, F>): Result<never, E | F>;
}

type Result<T, E extends Error> = Ok<T> | Err<E>;

function ok<T>(value: T): Ok<T>;
function err<E extends Error>(error: E): Err<E>;

// Wrap throwing code into a Result
function tryCatch<T, E extends Error = Error>(fn: () => T, errorHandler?: (e: unknown) => E): Result<T, E>;
function tryCatchAsync<T, E extends Error = Error>(fn: () => Promise<T>, errorHandler?: (e: unknown) => E): Promise<Result<T, E>>;
```

Construct with `ok(value)` / `err(error)` — not static factory methods on a `Result` namespace. Access via `.value` / `.error` directly after narrowing with `isOk()`/`isErr()`, not via method calls.

**[DECIDED]** Both classes also carry a `readonly ok: true | false` discriminant, which is what makes the `this is Err<never>` / `this is Ok<never>` predicates narrow `Result` correctly in both branches. `Err.unwrap()` throws the contained error itself, not a wrapper. In `tryCatch`/`tryCatchAsync` without a handler, a thrown non-`Error` is wrapped in `Error`.

## 4. `@bungohan/types` — Wire Protocol

**[KEEP]** — shared message/enum definitions used by both `core` and all client implementations so client and server agree on the protocol without a dependency cycle.

```typescript
enum ServerMessageType {
  ROOM_MESSAGE = "room_message",
  STATE_SNAPSHOT = "state_snapshot",
  STATE_PATCH = "state_patch",
  JOIN_SUCCESS = "join_success",
  JOIN_ERROR = "join_error",
  CLIENT_JOINED = "client_joined",
  CLIENT_LEFT = "client_left",
  LEAVE = "leave",
  ERROR = "error",
  PONG = "pong",
}

enum ClientMessageType {
  ROOM_MESSAGE = "room_message",
  JOIN = "join",
  LEAVE = "leave",
  PING = "ping",
}

enum LeaveCode { CONSENTED = 1000, DISCONNECTED = 1001, KICKED = 4000, SERVER_SHUTDOWN = 4001 }
enum CloseCode { NORMAL = 1000, GOING_AWAY = 1001, POLICY_VIOLATION = 1008, INTERNAL_ERROR = 1011 }

interface RoomOptions { maxClients: number; autoDispose: boolean; allowReconnection: boolean; reconnectionTimeout: number; visibility: "public" | "private"; locked: boolean; metadata?: Record<string, unknown>; }
interface ReconnectionOptions { enabled: boolean; maxAttempts: number; delay: number; delayMax: number; factor: number; }
interface Reservation { id: string; roomId: string; roomType: string; sessionId: string; expiresAt: number; }

// Envelope shapes actually sent over the wire
interface RoomMessageEnvelope { __type: ServerMessageType.ROOM_MESSAGE; __roomId: string; __messageType: string; __data: unknown; }
```

Message envelopes are always encoded with the active `ISerializer` before hitting the transport — never sent as raw JS objects.

### 4.1 Typed message contracts — **[NEW]**

**Hard requirement**: server-side DX is fully type-safe in *both* directions. `this.send(...)` and `this.broadcast(...)` are as strictly checked as `this.onMessage(...)`. No `unknown`, no casts, no asserted generics at call sites.

**This means authoring-time safety only — compile errors and editor autocomplete. It explicitly does NOT mean runtime validation.** No per-message validation pass runs in the hot path; the generated code costs nothing at runtime beyond encoding the payload. Contract types are erased by `tsc` exactly like any other TypeScript type.

This is safe rather than merely cheap, because the §8.1.2 codec decodes *type-directed*: a field declared `f.fixed(2)` is decoded by reading a varint and scaling it, so it cannot yield a string — the wire carries no type tag to disagree with, and the schema is the only source of truth about shape. Correct typing falls out of decoding itself rather than from a validation pass layered on top. Two honest caveats:

- **Malformed or truncated frames** are rejected at the codec/frame level (decode fails → message dropped, client disconnected, error logged) and never reach a handler as bad data. This is frame integrity, not field validation.
- **Semantic and range checks remain game logic** — whether `x` is inside the map, whether `level` is positive, whether this player is allowed to shoot right now. The framework knows the field is a number; it can't know what a *valid* number means in your game. Keep doing this in handlers, and keep treating clients as hostile (§10).
- **`sendRaw`/`onMessageRaw` payloads are genuinely `unknown`** — MessagePack carries arbitrary shapes with no schema to decode against, so the type system forces you to narrow before use. That's the honest type, not an oversight.

Declare messages once, in the shared workspace:

```typescript
import { defineMessage, defineContract, f, type Infer } from "@bungohan/types";

export const PlayerMove = defineMessage("playerMove", { x: f.fixed(2), y: f.fixed(2) });
export const Shoot      = defineMessage("shoot",      { angle: f.fixed(3) });
export const GameStart  = defineMessage("gameStart",  { level: f.int32, players: f.array(f.string) });
export const PlayerDied = defineMessage("playerDied", { sessionId: f.string });

export type PlayerMove = Infer<typeof PlayerMove>; // { x: number; y: number }

export const shooterContract = defineContract({
  client: { playerMove: PlayerMove, shoot: Shoot },        // client → server
  server: { gameStart: GameStart, playerDied: PlayerDied }, // server → client
});
```

Field builders: `f.int8/int16/int32/uint8/uint16/uint32`, `f.float32`, `f.float64`, `f.fixed(decimalPlaces)`, `f.string`, `f.bool`, `f.enum(...)`, `f.array(f.X)`, `f.map(f.X)`, `f.optional(f.X)`, `f.nested(OtherMessage)`.

**Why a builder instead of a plain TS interface**: an interface is erased at compile time, leaving nothing behind. The builder yields a runtime *descriptor* — a field table — alongside the static type, from one declaration. That descriptor is what makes codegen (§4.2), tag-free encoding (§8.1.2), and message-type interning (§8.1.1) possible from a single source of truth with no drift. Note the descriptor exists to describe the *layout* for encoding, not to validate payloads: it's read once per message to know how to write the bytes, which the encoder would have to determine anyway. Call sites stay plain object literals.

**Why not reuse `Schema`**: state needs mutable, observable, change-tracked wrappers; messages are immutable one-shot payloads. Keeping them separate means `send(client, "gameStart", { level: 1 })` rather than constructing wrapper instances by hand. Both still produce field tables, so codegen and the codec treat them uniformly.

Rooms bind a contract as a second type parameter:

```typescript
class ShooterRoom extends Room<ShooterState, typeof shooterContract> {
  protected override async onCreate() {
    this.onMessage("playerMove", (client, msg) => {
      // msg is { x: number; y: number } — inferred, no generic passed
      this.state.players.get(client.sessionId)?.x.set(msg.x);
      this.send(client, "gameStart", { level: 1, players: [] });   // ✓ checked
      this.broadcast("playerDied", { sessionId: client.sessionId }); // ✓ checked
      // this.send(client, "gamestart", {...})     → compile error: unknown message
      // this.broadcast("playerDied", { id: "x" }) → compile error: wrong payload
    });
  }
}
```

Signatures:

```typescript
type SendMap<C extends Contract> = C["server"];
type RecvMap<C extends Contract> = C["client"];

abstract class Room<TState extends Schema = Schema, TContract extends Contract = EmptyContract> {
  protected send<K extends keyof SendMap<TContract>>(
    client: Client, type: K, message: Infer<SendMap<TContract>[K]>): void;
  protected broadcast<K extends keyof SendMap<TContract>>(
    type: K, message: Infer<SendMap<TContract>[K]>, except?: Client): void;
  onMessage<K extends keyof RecvMap<TContract>>(
    type: K, handler: (client: Client, message: Infer<RecvMap<TContract>[K]>) => void | Promise<void>): () => void;
}
```

Both parameters default, so `Room<MyState>` still compiles for untyped usage. An untyped escape hatch (`sendRaw`/`broadcastRaw`/`onMessageRaw`, taking `string` + `unknown` over MessagePack) stays available for prototyping and genuinely dynamic payloads.

#### 4.1.1 Contract type definitions — **[DECIDED]** (implemented in `packages/types/src/contract.ts`)

The types referenced above are defined as follows. Build against these; don't redesign them.

```typescript
// Field descriptors: plain frozen runtime objects whose TS type also carries the payload type.
interface ScalarField<K extends ScalarKind> { kind: K }   // int8…uint32, float32, float64, string, bool
interface FixedField<D extends FixedDecimals> { kind: "fixed"; decimals: D }
interface EnumField<V extends string | number> { kind: "enum"; values: readonly V[] }
interface ArrayField<E extends Field>    { kind: "array"; of: E }
interface MapField<E extends Field>      { kind: "map"; of: E }        // string keys
interface OptionalField<E extends Field> { kind: "optional"; of: E }
interface NestedField<M extends MessageDef> { kind: "nested"; message: M }
type Field = ScalarField | FixedField | EnumField | ArrayField | MapField | OptionalField | NestedField
type FieldShape = { readonly [name: string]: Field }

interface MessageDef<N extends string = string, S extends FieldShape = FieldShape> {
  kind: "message"; name: N; fields: S;
  fieldNames: readonly string[];   // Object.keys(fields) — the positional wire order
}

type MessageMap = { readonly [name: string]: MessageDef }
interface Contract      { readonly client: MessageMap; readonly server: MessageMap }
interface EmptyContract { readonly client: Record<never, never>; readonly server: Record<never, never> }
type SendMap<C extends Contract> = C["server"]   // server → client
type RecvMap<C extends Contract> = C["client"]   // client → server

type Infer<M> = M extends MessageDef<string, infer S> ? InferShape<S> : never
```

`Infer` maps each field recursively (`InferField`): integer/float/fixed kinds → `number`, `string` → `string`, `bool` → `boolean`, `f.enum("a","b")` → `"a" | "b"`, `f.array(X)` → `X[]`, `f.map(X)` → `{ [key: string]: X }`, `f.nested(M)` → `Infer<M>`, and `f.optional(X)` → an **optional property** (`key?: X`) at message level, or `X | undefined` inside an array/map. The result is flattened into one plain object type, so `Infer<typeof PlayerMove>` is exactly `{ x: number; y: number }`.

Rules that fall out of the design:

- **`defineContract` requires each key to equal its message's `name`** (compile error otherwise), so the name at a call site is always the name on the wire. Message names must therefore be string literals.
- **`EmptyContract` has no keys**, so a room without a contract cannot call typed `send`/`broadcast`/`onMessage` at all. It uses the `*Raw` variants.
- **Field order is `Object.keys(fields)`**, i.e. declaration order. Field names must be identifiers (codegen emits them as members) and must not be integer-like (JS would reorder them).
- **`f.enum` values encode as their index** in `values`.
- The guarantee is enforced by `packages/types/src/contract.test-d.ts`: `@ts-expect-error` assertions for unknown message names, wrong/missing/excess payload fields, wrong direction, and `EmptyContract` rooms, all run by `tsc --noEmit`. `Room`/`IRoom` must keep the exact generic signatures above for that test to remain representative.

TypeScript clients import the same contract and get the mirrored view, with the direction inverted:

```typescript
const room = (await client.joinOrCreate<ShooterState, typeof shooterContract>("shooter")).unwrap();
room.send("playerMove", { x: 10, y: 20 });          // client → server, checked
room.onMessage("gameStart", (msg) => msg.level);    // server → client, inferred
```

### 4.2 Multi-language codegen — **[NEW]**

A `@bungohan/codegen` CLI reads the contract and state modules and emits client bindings:

```
bunx @bungohan/codegen --contract ./shared/contract.ts --state ./shared/state.ts \
  --lang csharp --out ./unity/Assets/Bungohan
```

Targets: **C#** (Unity), **GDScript** and **C#** (Godot), and a neutral `--lang json` descriptor so community targets (Rust, Kotlin, Swift, C++) can be written against a stable input. Emits message classes/structs, state schema classes with observable fields in the target's idioms, and encode/decode bound to the §8.1.2 codec.

**TypeScript is deliberately not a target.** TS clients import the contract module directly from the shared workspace — no build step, no staleness, strictly better than generated types.

Because the builders in §4.1 produce runtime descriptors, the generator simply imports the module and walks it. No TypeScript compiler API, no AST parsing, no fragility.

**Critical rule — never bake numeric ids into generated code.** Message-type ids and schema class ids are assigned by the server and delivered in the join handshake (§5.7.2, §8.1.1); generated clients resolve them *by name* at runtime. This means a Unity build keeps working when the server adds a message or field, and can never silently desync from a stale artifact. The handshake additionally carries a **contract hash**; if the server requires a message the client doesn't know, the join fails immediately with a clear error instead of mis-decoding later.

**[NEW] Envelope compaction**: the verbose `__`-prefixed string-keyed envelope above is what the old code sent on *every* message. For the rebuild, envelopes are positional arrays like the state ops in §5.7.3 — `[msgTypeId: number, roomRef: number, ...payload]` — where `msgTypeId` is the enum's numeric value and `roomRef` is a per-connection numeric room handle assigned at join, not the room's full string id. The enums above keep their readable string values in TypeScript for developer ergonomics and debugging, but a numeric id table is what crosses the wire. `STATE_PATCH` frames carry the `WireOp[]` array directly as their payload with no additional wrapping.

## 5. `@bungohan/state` — Schema & Delta Sync

**[KEEP the model, FIX/ADD filter support]**. This is the most structurally different package vs. the old aspirational docs — build it as factory functions, not decorators.

### 5.1 Defining schemas

```typescript
import { Schema, createNumber, createString, createSchemaMap } from "@bungohan/state";

class Player extends Schema {
  public static override schemaName = "Player";
  public x = createNumber(0);
  public y = createNumber(0);
  public name = createString("");
}

class RoomState extends Schema {
  public static override schemaName = "RoomState";
  public score = createNumber(0);
  public players = createSchemaMap<string, Player>();
}

const state = new RoomState(); // no _init() call needed — see lazy init below
```

- `schemaName` (static) is required on every concrete `Schema` subclass — used by `SchemaRegistry` to reconstruct instances from wire data by class name. First `new` of a class auto-registers it.
- Initialization walks the instance's own keys, binds every `State`-like field to the schema instance, and (for nested `Schema`/`SchemaCollection` fields) wires child `ChangeTree`s to the parent so dirtying propagates upward.

- **[NEW] Make initialization lazy, not manual.** Forgetting the old code's explicit `new RoomState()._init()` is a silent footgun — the object looks fine but nothing syncs.

  > ⚠️ **Do not "fix" this by calling `_init()` from the `Schema` base constructor — that does not work.** In JS/TS, derived-class field initializers run *after* the base constructor returns, so `Object.keys(this)` inside the base constructor sees none of the subclass's fields. Verified:
  > ```
  > keys seen by base constructor:            [ "_keys" ]
  > keys actually present after construction: [ "_keys", "x", "y" ]
  > ```
  > This is almost certainly why the old implementation made `_init()` manual in the first place.

  Instead, initialize lazily via an internal `_ensureInit()` guarded by a boolean, called at the few entry points that actually need the field table: the first property mutation (`_notifyChange`), the first delta generation, and the first serialization. By then all field initializers have run. Cost is one boolean check on paths that already do real work; developers call nothing, and `new RoomState()` just works.

  If an eager variant is ever wanted (e.g. to surface schema errors at startup rather than first tick), expose a static factory — `Schema.create(RoomState)` — which constructs and then initializes. Never the base constructor.

  **[DECIDED] Where `_ensureInit()` actually runs:** when an instance is attached to an initialized parent (collection insert, or the parent's own init walking its fields), at the first `encodeSnapshot`/`generateDeltas` on a root, and at the first `applyDelta` on a receiver root. A field wrapper cannot trigger it on mutation: until init, the wrapper has no link to its owner. That's fine, and it's by design. **Mutations are only recorded once an instance is *known* to clients (has a wire refId).** Before that, nothing has observed the instance, and it is serialized in full the first time it is sent, so there is nothing to diff against. It also means detached instances never accumulate change logs. Field names starting with `_` are reserved and never synchronized. `schemaName` must be the class's *own* static (an inherited one is ignored); if it's missing, the JS class name is used with a console error, since minification breaks it.
- Every instance gets a `_id` (nanoid) and `_tree: ChangeTree`.

### 5.2 Primitive wrappers

```typescript
function createNumber(initial?: number): NumberState;
function createString<T extends string = string>(initial?: NoInfer<T>): StringState<T>;
function createBoolean(initial?: boolean): BooleanState;
```

Each wrapper exposes `.get()`/`.set(value)` (or a getter/setter equivalent used consistently across the codebase), `.onChange(listener: (newValue, oldValue) => void): () => void`, `.offChange(listener)`.

### 5.3 Collections

Two parallel families depending on whether the element type is a `Schema`:

```typescript
// primitive-valued
function createMap<K, V>(initial?: Map<K, V>): MapState<K, V>;
function createSet<T>(initial?: Set<T>): SetState<T>;
function createArray<T>(initial?: T[]): ArrayState<T>;

// schema-valued (auto-links each element's ChangeTree to the parent)
function createSchemaMap<K, V extends Schema>(initial?: Map<K, V>): SchemaMapState<K, V>;
function createSchemaSet<T extends Schema>(initial?: Set<T>): SchemaSetState<T>;
function createSchemaArray<T extends Schema>(initial?: T[]): SchemaArrayState<T>;
```

Both families implement the native Map/Set/Array mutator methods directly on the wrapper (`get`/`set`/`delete`/`push`/`splice`/etc.), each mutator calling `_notifyChange` to mark the owning schema dirty. Listener API:

```typescript
onAdd(listener: (value: V, key: K) => void): () => void;   // maps: (value, key); arrays: (value, index); sets: (value, value)
onRemove(listener: (value: V, key: K) => void): () => void;
onChange(listener: (newValue, oldValue) => void): () => void;
```

Note the tuple/argument order is **value first, then key/index** — consistent across map/array/set.

**[DECIDED] API details:**
- Primitives expose `get()`/`set(v)` as the canonical API, plus a `value` accessor alias (`score.value += 1`). `onChange(newValue, oldValue)`.
- Collections expose a read-only `value` view. Collection `onChange` fires on an in-place replace (map key re-set, array index assigned) with `(newValue, oldValue, key)`. Sets have no `onChange`, because they have no replace. `clear()` fires `onRemove` per element.
- Arrays: `set(index, v)` replaces within range (returns `false` otherwise), and `splice` follows native semantics (negative start, omitted `deleteCount`). `sort`/`reverse`/`fill` are recorded as one replace per changed index. A Schema instance must not appear twice in one array.
- Element types are constrained: primitive collections hold `string | number | boolean`, map keys are `string | number`, and `Schema*` collections hold Schema instances.
- State is a **tree**: an instance has one parent at a time. Moving it (remove here, add there) is supported; sharing it between two parents is not.
- On the server, listeners fire synchronously on mutation. On a receiver, see §5.7.9.

### 5.4 Change tracking

```typescript
class ChangeTree {
  markChanged(key: string, value: unknown): void; // records change, sets isDirty, recursively dirties ancestors via _parent
  isDirty(): boolean;
  getChanges(): Map<string, unknown>;
  clear(): void;
  setParent(parent: ChangeTree): void;
}
```

Every `State`/`SchemaCollection` mutation calls `schema._tree.markChanged(propertyKey, newValue)` on the owning schema plus fires that field's own listeners.

### 5.5 Delta generation, serialization, reconstruction

> The old implementation's approach is described here for context, but **the wire format is being redesigned — see §5.7, which supersedes the encoding details below.** What stays the same is the overall pipeline shape (walk tree → emit ops → clear change trees → apply on the receiving side → fire listeners); what changes is that ops are now structurally diffed and positionally encoded rather than whole-value re-serialized.

- `generateDeltas(rootSchema, clients?): WireOp[]` walks the schema tree recursively and, for each dirty `Schema`, emits only the specific ops recorded by its `ChangeTree` (§5.7.3–5.7.5). The `clients` argument is only needed when the tree contains `createFiltered` fields (§5.6).
- `clearChangeTrees(rootSchema)` is called after every successful sync tick to reset all `ChangeTree`s.
- `applyDelta(rootSchema, ops)` resolves each op's target instance via the numeric `refId` map, applies it, and fires the appropriate `onChange`/`onAdd`/`onRemove` callbacks.
- **Join handshake**: on join the server sends (1) the schema class/field table (§5.7.2), then (2) a full state snapshot. Both are one-time per join; everything afterward is ops.
- `SchemaRegistry` still maps `schemaName → constructor` for reconstruction, but the wire carries the numeric `classId` from the handshake rather than the class name string.

### 5.6 Filtering — **[NEW]**

The old code had no way to send different data to different clients. Add this as a real feature:

```typescript
function createFiltered<T>(wrapped: State<T>, filterFn: (this: Schema, client: Client) => boolean): State<T>;
```

Usage:

```typescript
class RoomState extends Schema {
  public static override schemaName = "RoomState";
  public globalScore = createNumber(0);
  public secretData = createFiltered(createString(""), function (client) {
    return this.ownerId === client.id;
  });
}
```

During delta generation, when a field is `createFiltered`-wrapped, the generator must produce a **per-client** patch set instead of one shared patch: run the filter function once per connected client for that room, and only include the field in the patches destined for clients where the filter returns `true`. This means `generateDeltas` needs to become client-aware when any filtered field exists in the tree (plain, non-filtered fields keep the current shared-patch behavior for efficiency — only pay the per-client cost where filtering is actually used).

**[DECIDED] Filtering semantics** (implemented in `packages/state/src/encoder.ts`):

- `createFiltered(wrapped, fn)` returns **the same wrapper** (typed as the wrapped type, not bare `State<T>`), so its API is unchanged. It is generic in `this` and in the client type: `function (this: RoomState, client) {…}` or an arrow capturing the instance (`(client) => this.ownerId.get() === client.id`). The default client type is `{ readonly id: string }`, which core's `Client` must satisfy.
- Signatures: `generateDeltas(root): WireOp[]` omits every filtered field. `generateDeltas(root, clients): Map<Client, WireOp[]>` returns per-client ops, and **clients with identical visibility share one array instance**, so core encodes once per distinct array. With no filtered fields, all clients share one array. `encodeSnapshot(root, client?)` includes filtered content only if `client` passes.
- A filter covers the whole subtree under the field: ops for nested instances inside a filtered collection are filtered too. Nested filters compose (all must pass).
- **Filters are evaluated every sync tick** for every registered filtered field × client, so visibility can depend on any state. When a field becomes visible to a client, that client receives its full current value/contents. When it becomes hidden, the client receives the zero value (primitive) or `CLEAR` (collection). Filters must be pure. A filter that throws counts as hidden (logged).
- Core must pass **every connected client on every call**: per-client visibility memory is updated by each call.
- Don't move an instance across a filter boundary (from inside a filtered subtree to outside or back). Clients that never saw it would receive only a reference.

### 5.7 Bandwidth Optimization — **[NEW — beyond the old code entirely]**

The old implementation's wire format was never optimized: it re-serialized whole changed values (never diffed inside a collection), used nanoid strings as `refId`, used property name strings as patch keys, and re-sent the schema's class name on every reconstructed instance. None of this was wrong, but all of it was wasteful. This is a ground-up wire-format redesign — nothing here can be copied from the old code.

#### 5.7.1 Numeric `refId`s instead of nanoid strings

A schema instance's `_id` stays an internal nanoid (useful for logging/debugging), but the value put on the wire is a compact, monotonically increasing integer assigned per-room the first time an instance is serialized (`_wireRef: number`). MessagePack encodes small integers in 1 byte vs. ~22 bytes for a nanoid string — this alone is the single biggest win for any state with many entities (NPCs, projectiles, players).

#### 5.7.2 Class handshake instead of repeated class-name strings

On join, the server sends a one-time **schema handshake**: `{ classes: [{ classId: number, name: string, fields: string[] }] }`, listing every `Schema` subclass reachable from the room's state tree, its assigned numeric `classId`, and its field names **in declaration order** (captured automatically from `Object.keys()` when a class is first initialized — no manual indices, keeping the "no decorators" principle). After the handshake, every wire reference to a class or field uses its numeric id, never its name.

**[DECIDED] Amendments** (types in `packages/types/src/wire.ts`):

- Each class entry also carries **`types: SchemaFieldType[]`**, parallel to `fields`. Receivers need it to dequantize fixed-point fields, to allocate collection refIds (§5.7.9) for fields they don't have locally, and to detect type disagreements. `SchemaFieldType = "float64" | "float32" | "fixed:N" | "string" | "bool" | "schema" | "map" | "set" | "array" | "schemaMap" | "schemaSet" | "schemaArray"` (`"schema"` = a directly nested Schema field).
- **The table is delivered in-band, as `DEFINE` ops**, and grows incrementally. "Reachable from the state tree" can't be computed at join time: the classes inside an empty `createSchemaMap<string, Player>()` are erased types. So class ids are assigned the first time an instance of that class is serialized. A snapshot starts with `DEFINE` ops for the room's entire table so far, and a patch carries an inline `DEFINE` right before the first use of a class new to the room. `DEFINE`s are never filtered. `getSchemaTable(root)` returns the table (as `SchemaTable`) for core/codegen/debugging, but receivers need nothing beyond the op stream.
- Receivers resolve classes **by name** (`SchemaRegistry`) and fields **by name** (server field index → local field of the same name). A server field the client lacks is skipped. A class the client lacks is ignored along with everything under it. A shared field whose type differs is a hard `SCHEMA_MISMATCH` error. Receivers that never construct a class locally (e.g. `Player` only arrives inside a map) must `SchemaRegistry.register(Player)`, because auto-registration happens on first `new`.

#### 5.7.3 Positional (array-based), not keyed, patch encoding

Encode each delta op as a fixed-position tuple, not an object with string keys — MessagePack still pays for `"op"`, `"refId"`, etc. as string keys in a map, but an array has no key overhead at all:

```typescript
type WireOp =
  | [0, refId: number, fieldIndex: number, value: WireValue]  // SET
  | [1, refId: number, key: WireValue, value: WireValue]      // ADD (collections)
  | [2, refId: number, key: WireValue]                         // REMOVE (collections)
  | [3, refId: number]                                         // CLEAR (collections)

type WireValue = number | string | boolean | [classId: number, refId: number]; // last form = reference to a (possibly newly created) nested Schema instance
```

**[DECIDED] Final `WireOp` definition** (supersedes the block above; `packages/types/src/wire.ts`):

```typescript
type WireKey = string | number | boolean
type WireRef = [classId: number, refId: number]
type WireValue = number | string | boolean | WireRef

type WireOp =
  | [0, refId, fieldOrIndex: number, value: WireValue]  // SET: schema field; on an array: replace at index
  | [1, refId, key: WireKey, value: WireValue]          // ADD: map upsert; array insert-at-index
  | [1, refId, value: WireValue]                        // ADD: sets (3-element form; no redundant key)
  | [2, refId, key: WireKey]                            // REMOVE: map key; array index; set element (schema sets: element refId)
  | [3, refId]                                          // CLEAR
  | [4, classId, name: string, fields: string[], types: SchemaFieldType[]]  // DEFINE (§5.7.2)
```

Array `ADD`/`REMOVE` shift later indices, so array ops replay in recorded order. Map and set ops are **coalesced per key**: only each touched key's final state is sent, since keyed ops commute. A `[classId, refId]` value with an unknown `refId` creates the instance, and its content follows immediately in the same frame.

A full sync tick's payload is `WireOp[]` — one array, one frame. `WireOp[]` is the stable interface between the state layer and the serialization layer: §8.1.2 defines a schema-aware codec that encodes this same structure far more compactly than MessagePack can, precisely because the handshake makes per-value type tags redundant.

#### 5.7.4 Structural diffing for collections — no more full resends

The old delta generator re-serialized an entire collection's contents whenever any element changed. Replace this with real structural diffing at the collection wrapper level: every mutator (`set`, `delete`, `push`, `splice`, etc.) on `MapState`/`SetState`/`ArrayState`/`SchemaMapState`/`SchemaSetState`/`SchemaArrayState` records the specific `ADD`/`REMOVE`/`SET`(replace-at-key) op it caused, directly into the owning `ChangeTree`, instead of just flagging "this key is dirty, reserialize everything." `generateDeltas` then only ever emits the ops that actually happened.

#### 5.7.5 Nested schema patches reference by `refId`, never re-embed the whole instance

When a leaf property inside a nested `Schema` changes, the patch is `[SET, <nested instance's refId>, fieldIndex, value]` — the parent instance's patch never re-embeds the nested instance's full serialized form. The only time a full instance is serialized is the first time it's ever referenced (new entity created) or the initial join snapshot.

#### 5.7.6 Optional lossy numeric compaction — opt-in per field

```typescript
function createFloat32(initial?: number): Float32State;               // reduced precision (32-bit) vs. default float64, still exact for most game math
function createFixedPoint(decimalPlaces: number, initial?: number): FixedPointState; // stores Math.round(value * 10**decimalPlaces) as an integer on the wire
```

`createNumber()` remains full float64 precision and is the default. `createFloat32` and `createFixedPoint` are opt-in for fields like position/rotation/velocity where the range and required precision are known and bounded — a fixed-point position with 2 decimal places encodes as a 1–3 byte MessagePack integer instead of a 9-byte float64, a >60% reduction on exactly the kind of field that changes every tick in a fast-paced game. Document clearly in the field's JSDoc that these are lossy.

##### 5.7.6.1 Fixed-point rules — **[DECIDED]** (`packages/types/src/fixed.ts`, shared by `f.fixed(n)` and `createFixedPoint(n)`)

Every implementation (TS, C#, GDScript, …) must reproduce these rules bit for bit. They belong in `PROTOCOL.md` and the conformance vectors (`004-fixed-point-precision`).

| Aspect | Rule |
|---|---|
| Decimal places | Integer `0..9` (`type FixedDecimals = 0 \| … \| 9`, enforced at compile time). Beyond 9, the range would fall below ±2.1. |
| Wire integer | **Signed 32-bit** `[-2147483648, 2147483647]`. Zigzag varint in `SchemaCodec`. Fits C# `int`, GDScript `int`, and JS bitwise ops. At 2 dp the range is ±21,474,836.47. |
| Encode | `scaled = value * 10^n` in IEEE-754 binary64, with `10^n` as the exact double. Then **round half away from zero** (C#: `Math.Round(x, MidpointRounding.AwayFromZero)`; GDScript: `round()`; JS: `sign(x) * Math.round(abs(x))`, **not** bare `Math.round`, which rounds -2.5 to -2). Never emit -0. |
| Overflow | **Saturate** to the int32 bounds (±Infinity too). Wrapping would teleport entities; erroring isn't available on a `void` setter. |
| NaN | Encodes as `0`. |
| Decode | `scaled / 10^n` (**divide**, never multiply by `0.1^n`: `14551 * 0.01` ≠ `145.51`). |
| Server-side storage | **The server keeps full precision.** `get()` returns what was set, so `x += vx * dt` with sub-resolution steps still accumulates. The field is marked dirty only when its **encoded** value changes, and the wire carries the value encoded at sync time. Receivers store the decoded (quantized) value. `createFloat32` follows the same model with `Math.fround`. |

For messages, `f.fixed(n)` applies the identical encoding when the payload is written.

#### 5.7.7 Transport-level compression

`WebSocketTransportOptions.compression` (already present in `ServerOptions.transport.config.compression`, default `true`) enables Bun's native WebSocket `perMessageDeflate`. **Decision**: implement this as a boolean option on `WebSocketTransport` itself, not a separate `WebSocketDeflateTransport` class — it's a single toggle on Bun's native WebSocket config, not a different transport mechanism, so a second class would just duplicate the whole implementation for one flag. Because payloads are already tightly packed MessagePack (not verbose JSON), compression yields the most benefit on larger frames (initial join snapshot, big broadcasts) and negligible-to-negative benefit on tiny per-tick deltas — Bun's deflate handles this adaptively per-frame, so leave it on by default and let it self-regulate rather than hand-tuning a size threshold.

#### 5.7.8 Metrics

Extend `RoomMetrics` (§6.6) with `avgStateDeltaBytes` (already specified) plus **[NEW]** `avgStateSnapshotBytes` and, when `transport.config.compression` is enabled, `avgCompressionRatio` — so bandwidth wins from this section are actually observable in production, not just assumed.

#### 5.7.9 Sync semantics — **[DECIDED]** (`packages/state/src/{encoder,decoder}.ts`)

Both peers follow these rules on the same op stream, which is what keeps them in agreement. Conformance vectors should cover each one.

- **refIds.** Allocated per room, monotonically, starting at 0, when an instance is first serialized. The root is always `0`. An instance with refId `R` implicitly owns refIds **`R+1 … R+k` for its `k` collection fields, in field (declaration) order**. Collections therefore cost zero bytes to announce, and receivers compute the same numbers from the class table's `types`. refIds are never reused.
- **Full content.** A new instance is sent as the op that places it (with `[classId, refId]`), immediately followed by its content: a `SET` for every primitive field whose wire value is **non-zero** (`0`, `""`, `false` are omitted), a `SET` with the child's ref for each directly nested Schema field, and `ADD`s for every collection element. **Receivers reset every instance they create to type zero values** (including the root on first bind), whatever the local initializers say, because a C#/GDScript client cannot know TypeScript initializer values.
- **Known instances** are referenced by ref only. Their own changes are emitted as ops targeting their refId (§5.7.5).
- **Removal and re-attach.** An instance removed during a tick and not re-attached by the end of that tick is **forgotten** by the server at `clearChangeTrees` (its subtree's refIds are reset) and dropped by receivers at the end of the frame. If it's attached again later, it is sent in full under new refIds. Receivers use **holder counts** (how many fields and collection slots reference an instance), so a move within one frame (remove here, add there, in either order) keeps the same client object.
- **Receiver listeners are deferred** until the whole frame is applied, then fire in op order (an instance's primitive fields precede its collections). An instance **created in this frame fires none of its own listeners**. Its parent collection's `onAdd` sees it fully populated. The root's listeners always fire, including during the snapshot.
- **Errors.** `applyDelta(root, ops): Result<void, StateError>` validates op shapes and value types. It reports `MALFORMED_OP`, `UNKNOWN_REF`, `UNKNOWN_CLASS` or `SCHEMA_MISMATCH`, stopping at the first bad op (earlier ops stay applied). Core/client-js should treat any error as a desync and rejoin. A throwing listener is caught and logged.

#### 5.7.10 Join/sync ordering — **[DECIDED]**

`encodeSnapshot(root, client?)` returns `err(SNAPSHOT_DIRTY)` while changes are pending. Snapshotting assigns refIds, which would make pending new instances look already-sent to existing clients. **Core therefore admits joiners at a sync boundary:** `generateDeltas` → send to existing clients → `clearChangeTrees` → `encodeSnapshot` for each joiner. `generateDeltas` returns `[]` before the first snapshot and on idle ticks; send nothing then. Each `generateDeltas` output must be delivered and followed by `clearChangeTrees` (they form a commit pair).

#### 5.7.11 Known gaps (for the serializer/codegen sessions)

- **Collection element types are erased.** `createMap<string, number>()` / `createSchemaMap<string, Player>()` carry no runtime element type, so the class table can say "map" but not "map of float32" or "map of Player". Phase 1 (MessagePack) doesn't need it because values are self-describing. Phase 2 `SchemaCodec` (tag-free collection values) and codegen (typed C#/GDScript collections) will. The likely fix is an optional runtime element descriptor on the collection factories (e.g. reusing the §4.1 `f.*` builders), added to the class table. Resolve this before Phase 2.
- `IStateCodec.encodeOps(ops, table)` should maintain its table from the `DEFINE` ops in the stream rather than receive it separately, since the table grows mid-session.
- Bandwidth baselines are recorded in `packages/state/src/bandwidth.test.ts` (100-entity room, MessagePack: one position update 8 B, all moving 1,396 B, 10+10 churn 433 B, snapshot 4,006 B, idle 0 B).

## 6. `@bungohan/core` — Server, Room, MatchMaker

**[KEEP]** signatures below are exact, verified against the working implementation, except where marked **[NEW]**/**[FIX]**.

### 6.1 Server

```typescript
function createBungohanServer(options: ServerOptions): BungohanServer;

interface ServerOptions {
  transport?: {
    provider?: ITransport;
    config?: { port?: number; maxPayloadLength?: number; idleTimeout?: number; compression?: boolean };
  }; // [FIX] no bare-ITransport union, no top-level `port` — port only ever lives here
  store?: { provider?: IStore; config?: { url?: string; host?: string; port?: number; password?: string } };
  cluster?: {
    enabled?: boolean;
    processId?: string;
    backplane?: { provider?: IBackplane; config?: { url?: string; host?: string; port?: number; password?: string } };
  };
  serializer?: ISerializer;
  metrics?: { enabled?: boolean };
  http?: { enabled?: boolean; port?: number; hostname?: string; cors?: boolean; enableMetrics?: boolean; enableHealthCheck?: boolean; enableRoomsList?: boolean };
  simulation?: { tickRate?: number }; // default 60
  sync?: { tickRate?: number };       // default 20
  gracefulShutdown?: { timeout?: number; onShutdown?: () => Promise<void> };
  logger?: LoggerOptions;
}

class BungohanServer {
  defineRoomType(name: string, RoomClass: RoomConstructor, options?: DefineRoomOptions): void;
  start(): Promise<void>;
  stop(): Promise<void>;
  isRunning(): boolean;
  getRoomManager(): RoomManager;
  getMatchMaker(): MatchMaker;
  getMetricsCollector(): MetricsCollector | undefined;
  getHttpServer(): HttpServer | undefined;
  getServerMetrics(): Result<ServerMetrics, BungohanError>;
  getAllRoomMetrics(): Result<RoomMetrics[], BungohanError>;
  getAllClientMetrics(): Result<ClientMetrics[], BungohanError>;
  get processId(): string;

  // [NEW] — described in the original docs, never implemented; build these for real now
  onConnect(cb: (client: Client) => void): () => void;
  onJoin(cb: (client: Client, room: Room) => void): () => void;
  onLeave(cb: (client: Client, room: Room, consented: boolean) => void): () => void;
  onError(cb: (error: Error, context: unknown) => void): () => void;
}

// RoomManager (existing, keep as-is)
class RoomManager {
  onRoomCreated(cb: (room: Room) => void): () => void;
  onRoomDisposed(cb: (room: Room) => void): () => void;
}
```

### 6.2 Room

```typescript
abstract class Room<TState extends Schema = Schema, TContract extends Contract = EmptyContract>
  implements IRoom<TState, TContract> {
  protected state: TState;
  protected clients: Map<string, Client>;

  // Lifecycle hooks — user-overridable, throw-on-error (framework catches), NOT Result-returning
  protected static onAuth(client: Client, options: unknown, context: ConnectionContext): Promise<Record<string, unknown> | boolean>;
  protected onAuth(client: Client, options: unknown, context: ConnectionContext): Promise<Record<string, unknown> | boolean>;
  protected async onCreate(options: RoomOnCreateOptions & UserDefinedRoomOnCreateOptions): Promise<void>;
  protected async onJoin(client: Client, options: UserDefinedRoomOnJoinOptions, auth: Record<string, unknown>): Promise<void>;
  protected async onLeave(client: Client, consented: boolean): Promise<void>;
  protected onTick(deltaTime: number): void;        // sync — called every simulation tick
  protected onBeforeSync(): void;                    // sync — called before every sync tick
  protected async onDispose(): Promise<void>;
  protected onPause(): void;                         // sync — no clients, awaiting reconnection
  protected onResume(): void;                        // sync

  // Message handling — fully typed against TContract, see §4.1
  onMessage<K extends keyof RecvMap<TContract>>(
    type: K,
    handler: (client: Client, message: Infer<RecvMap<TContract>[K]>) => Promise<void> | void): () => void;

  // Server -> client — type name AND payload shape both checked
  protected send<K extends keyof SendMap<TContract>>(
    client: Client, type: K, message: Infer<SendMap<TContract>[K]>): void;
  protected broadcast<K extends keyof SendMap<TContract>>(
    type: K, message: Infer<SendMap<TContract>[K]>, except?: Client): void;
  broadcastMessage<K extends keyof SendMap<TContract>>(
    type: K, message: Infer<SendMap<TContract>[K]>, except?: Client): void; // public wrapper

  // Untyped escape hatches (MessagePack, no contract) for prototyping / dynamic payloads
  protected sendRaw(client: Client, type: string, message: unknown): void;
  protected broadcastRaw(type: string, message: unknown, except?: Client): void;
  onMessageRaw(type: string, handler: (client: Client, message: unknown) => Promise<void> | void): () => void;

  // Room control
  disconnectClient(client: Client, code?: number, reason?: string): void;
  join(client: Client, options?: unknown): Promise<Result<void, BungohanError>>;
  leave(client: Client, consented?: boolean): Promise<Result<void, BungohanError>>;
  lock(): void; unlock(): void; makePrivate(): void; makePublic(): void;
  setSimulationTickRate(fps: number): void;
  setStateSyncTickRate(hz: number): void;

  // Presence
  setPresence(clientId: string, data: unknown): void;
  getPresence(clientId: string): unknown;
  getAllPresence(): Map<string, unknown>;
  removePresence(clientId: string): void;

  // Persistence (requires an IStore passed at construction)
  protected loadState(): Promise<TState | undefined>;
  protected saveState(state: TState): Promise<void>;

  // Queries
  getClientCount(): number;
  hasClient(clientId: string): boolean;
  getClient(clientId: string): Client | undefined;
  getClients(): Client[];
}
```

### 6.3 MatchMaker

```typescript
function getMatchMaker(): MatchMaker; // throws if no server has been created yet (singleton, set by BungohanServer's constructor)

class MatchMaker {
  registerRoomType(name: string, RoomClass: RoomConstructor, options?: DefineRoomOptions): void;
  createRoom(roomType: string, options?: unknown, processSelector?: ProcessSelector): Promise<Result<Room, BungohanError>>;
  joinRoom(roomType: string, options?: unknown): Promise<Result<Room, BungohanError>>;
  joinOrCreate(roomType: string, options?: unknown, processSelector?: ProcessSelector): Promise<Result<Room, BungohanError>>;
  joinById(roomId: string, options?: unknown): Promise<Result<Room, BungohanError>>;
  query(options: MatchMakerQueryOptions): Promise<Result<RoomListingInfo[], BungohanError>>;
  reserve(roomType: string, options?: unknown, processSelector?: ProcessSelector): Promise<Result<Reservation, BungohanError>>;
  consumeReservation(reservationId: string): Result<Reservation, BungohanError>; // sync
  getAllRooms(): Room[];
  getRoom(id: string): Room | undefined;
  removeRoom(id: string): void;
  getProcessId(): string;
  getRoomCount(): number;
  getClientCount(): number;

  // [NEW] — finish real cross-process aggregation instead of the local-only stub
  getAllProcesses(): Promise<Result<ProcessInfo[], BungohanError>>;
}
```

### 6.4 Cluster mode — **[NEW: finish `getAllProcesses`]**

The old `MatchMaker._getAllProcesses()` published a `PROCESS_INFO` request over the backplane but only ever returned local info — a known-incomplete stub. For this rebuild, finish it properly:

1. On `getAllProcesses()`, publish a `PROCESS_INFO_REQUEST { requestId }` on the cluster backplane channel.
2. Every process (including the requester) subscribes to that channel and, on receiving a request, publishes `PROCESS_INFO_RESPONSE { requestId, processId, numRooms, numClients }`.
3. The requester collects responses for a short window (e.g. 200ms) keyed by `requestId`, then resolves with the aggregated list (including itself, without a network round-trip for its own entry).
4. `ProcessSelector` functions passed to `createRoom`/`joinOrCreate`/`reserve` receive this real aggregated list, enabling actual least-loaded-process selection in clustered mode — this was previously plumbed through but never functional.

Everything else about clustering (RoomProxy for remote rooms, `PROXY_JOIN/LEAVE/MESSAGE/BROADCAST/DISCONNECT/LOCK/VISIBILITY/PRESENCE_*` backplane message types, `CLIENT_SEND/DISCONNECT` routing) worked correctly in the old code — reproduce as-is.

### 6.5 Error codes

```typescript
type ErrorCode =
  | "ROOM_NOT_FOUND" | "ROOM_NOT_FOUND_ON_LOCAL_BUT_FOUND_ON_REMOTE" | "ROOM_TYPE_NOT_DEFINED"
  | "ROOM_FULL" | "ROOM_LOCKED" | "INVALID_OPTIONS" | "AUTH_FAILED" | "UNAUTHORIZED" | "INVALID_TOKEN"
  | "RESERVATION_EXPIRED" | "RESERVATION_NOT_FOUND" | "CONNECTION_FAILED" | "CONNECTION_LOST"
  | "RECONNECTION_FAILED" | "INVALID_MESSAGE" | "TIMEOUT" | "METRICS_DISABLED" | "CLIENT_NOT_FOUND";

class BungohanError<T = unknown> extends Error {
  code: ErrorCode;
  timestamp: number;
  context?: T;
}
```

### 6.6 Metrics

Off by default (`metrics.enabled: false`). When enabled, `ServerMetrics`/`RoomMetrics`/`ClientMetrics` shapes match the original SPEC.md's definitions (uptime, message/byte counters, avg tick/sync duration, per-room state size) — reproduce those interfaces as originally specified since they were never contradicted by the actual code, just not verified in this pass. Expose via `server.getServerMetrics()` / `getAllRoomMetrics()` / `getAllClientMetrics()`, and optionally via the built-in HTTP metrics endpoint when `http.enabled` and `http.enableMetrics` are true.

## 7. `@bungohan/client-js` — Reference Client Implementation

### 7.1 Client — **[KEEP]**

```typescript
function createBungohanClient<T = unknown>(options: ClientOptions): IBungohanClient<T>;
// class BungohanClient also exported directly for `new BungohanClient(options)`

interface ClientOptions {
  url: string;
  token?: string;
  autoConnect?: boolean;
  reconnection?: Partial<ReconnectionOptions>; // default: { enabled: true, maxAttempts: 10, delay: 1000, delayMax: 30000, factor: 2 }
  serializer?: ISerializer; // default: MessagePackSerializer
}

interface IBungohanClient {
  connect(): Promise<Result<void, Error>>;
  disconnect(): Promise<void>;
  create<T extends Schema>(roomType: string, options?: unknown): Promise<Result<IRoom<T>, Error>>;
  join<T extends Schema>(roomType: string, options?: unknown): Promise<Result<IRoom<T>, Error>>;
  joinById<T extends Schema>(roomId: string, options?: unknown): Promise<Result<IRoom<T>, Error>>;
  joinOrCreate<T extends Schema>(roomType: string, options?: unknown): Promise<Result<IRoom<T>, Error>>;
  reconnect<T extends Schema>(roomId: string, reconnectToken: string): Promise<Result<IRoom<T>, Error>>;
  consumeReservation<T extends Schema>(reservation: Reservation): Promise<Result<IRoom<T>, Error>>;
  getRooms(): Map<string, IRoom>;
  getRoom(id: string): IRoom | undefined;
  leaveAll(): Promise<void>;
  get connectionState(): "disconnected" | "connecting" | "connected" | "reconnecting";
  onError(cb: (error: Error) => void): () => void;
  onDisconnect(cb: () => void): () => void;
  onReconnect(cb: () => void): () => void;
}
```

### 7.2 Room (client-side) — **[KEEP shape, ADD contract typing]**

Direction is inverted relative to the server: the client *sends* what the server *receives*.

```typescript
interface IRoom<T extends Schema = Schema, C extends Contract = EmptyContract> {
  id: string;
  sessionId: string;
  roomType: string;
  state: Readonly<T>;
  reconnectionToken?: string;

  send<K extends keyof RecvMap<C>>(type: K, message: Infer<RecvMap<C>[K]>): void;
  sendRaw(type: string, message: unknown): void; // untyped escape hatch
  leave(consented?: boolean): Promise<void>; // default true

  onMessage<K extends keyof SendMap<C>>(type: K, cb: (message: Infer<SendMap<C>[K]>) => void): () => void;
  onMessageRaw(cb: (type: string, message: unknown) => void): () => void; // catch-all
  onStateChange(cb: (state: T) => void): () => void;
  onLeave(cb: (code: number) => void): () => void;
  onError(cb: (code: number, message: string) => void): () => void;
  onClientJoin(cb: (client: { sessionId: string }) => void): () => void;
  onClientLeave(cb: (client: { sessionId: string }) => void): () => void;

  removeAllListeners(): void;
  removeListener(event: string, callback: (...args: unknown[]) => void): void;
}
```

Leaving a room (`room.leave()`) must clean up all its listeners automatically, matching the original design intent.

### 7.3 State listeners on the client

The client applies incoming `STATE_SNAPSHOT`/`STATE_PATCH` messages via `@bungohan/state`'s `applyDelta`, which fires the standard `onChange`/`onAdd`/`onRemove` callbacks documented in §5.3 directly on the schema instances in `room.state`. No separate client-side state API is needed beyond what `@bungohan/state` already provides — `room.onStateChange` is a coarser top-level convenience on top of the same mechanism.

### 7.4 React hooks — **[NEW]**

Never existed in the old package (only a bespoke non-shipped hook lived in the example app). Build a real `@bungohan/client-js/react` entry point:

```typescript
// Provide a client instance to descendants
function BungohanProvider(props: { client: IBungohanClient; children: ReactNode }): JSX.Element;

// Consume the provided client
function useBungohan(): IBungohanClient;

// Join/manage a room's lifecycle tied to component lifetime
function useRoom<T extends Schema>(roomType: string, options?: unknown, mode?: "join" | "create" | "joinOrCreate"): {
  room: IRoom<T> | undefined;
  status: "connecting" | "connected" | "error";
  error?: Error;
};

// Subscribe to state with an optional selector to avoid over-rendering
function useRoomState<T extends Schema, S = T>(room: IRoom<T> | undefined, selector?: (state: T) => S): S | undefined;

// Subscribe to one message type
function useRoomMessage<M = unknown>(room: IRoom | undefined, type: string, cb: (message: M) => void): void;
```

`useRoomState` must re-render only when the selected slice actually changes (shallow-compare the selector's return value across `onStateChange` firings), not on every state mutation — this is the entire point of taking a selector.

## 8. `@bungohan/transport`, `@bungohan/serializer`, `@bungohan/store`, `@bungohan/backplane`

**[KEEP]** — all four verified working as designed; reproduce interfaces and default implementations exactly.

```typescript
// transport
interface ConnectionContext { ip: string; searchParams: URLSearchParams; headers: Headers; token?: string; [key: string]: unknown }
interface ITransport {
  listen(port: number, options?: unknown): Promise<Result<void, Error>>;
  close(): Promise<Result<void, Error>>;
  send(clientId: string, data: Uint8Array): Result<void, Error>;
  broadcast(clientIds: string[], data: Uint8Array): Result<void, Error>;
  disconnect(clientId: string, code?: number, reason?: string): Result<void, Error>;
  onConnection?(cb: (clientId: string, context: ConnectionContext) => void): void;
  onMessage?(cb: (clientId: string, data: Uint8Array) => void): void;
  onDisconnect?(cb: (clientId: string, code: number, reason: string) => void): void;
  onError?(cb: (error: Error) => void): void;
  getName(): string;
}
// WebSocketTransport (Bun.serve/ServerWebSocket-based) additionally exposes getClientCount(), isClientConnected(clientId)
// Extracts auth token from `?token=` query param or `Authorization: Bearer` header
// TransportError codes: CONNECTION_LOST | CLIENT_NOT_FOUND | INVALID_OPTIONS | CONNECTION_FAILED

// serializer — see §8.1, the interface is KEPT but the implementations are significantly extended
interface ISerializer { encode(message: unknown): Uint8Array; decode(data: Uint8Array): unknown; getName(): string; }
// JsonSerializer: JSON.stringify/parse with a replacer/reviver that wraps Uint8Array as {__type:"Uint8Array", data:[...]} — debug/dev only
// MessagePackSerializer: wrapper over @msgpack/msgpack — default for room messages

// store
interface IStore {
  set(key: string, value: unknown, ttl?: number): Promise<Result<void, Error>>;
  get(key: string): Promise<Result<unknown, Error>>;
  delete(key: string): Promise<Result<void, Error>>;
  exists(key: string): Promise<Result<boolean, Error>>;
  close(): Promise<Result<void, Error>>;
}
// RedisStore: Bun's built-in RedisClient, JSON-serializes values, `setex` for TTL; extra connect()/isConnected()
// StoreError codes: CONNECTION_FAILED | INVALID_OPTIONS

// backplane
interface IBackplane {
  publish<M>(channel: string, message: M): Promise<Result<void, Error>>;
  subscribe<M>(channel: string, callback: (message: M) => void): Promise<Result<void, Error>>;
  unsubscribe(channel: string): Promise<Result<void, Error>>;
  close(): Promise<Result<void, Error>>;
}
// RedisBackplane: two Bun RedisClient connections (publisher + subscriber), JSON messages,
// supports multiple local callbacks per channel via Map<channel, Set<callback>> while only issuing one real Redis SUBSCRIBE per channel
// extra connect()/isConnected(); BackplaneError codes: CONNECTION_FAILED | INVALID_OPTIONS
```

**[FIX]** package export consistency: every one of these packages must re-export its `*Error` class and `ErrorCode` type from its `index.ts` (the old `backplane` package inconsistently omitted this while `store` did export it — normalize this across all four).

### 8.1 Serializer strategy — **[NEW]**

The old implementation used one generic serializer for everything. That's the wrong shape for bandwidth, because the two things being serialized have completely different information available:

| Path | Payload | What the decoder knows in advance |
|---|---|---|
| **Room messages** (`room.send`, `broadcast`) | Arbitrary user-defined objects | Nothing — shape is whatever the developer passed |
| **State sync** (`WireOp[]`) | Fully typed schema fields | Everything — the §5.7.2 handshake already told it the type of every field of every class |

MessagePack is *self-describing*: it writes a type tag byte before every value so the decoder can figure out what it's reading. For room messages that's necessary and MessagePack is the right tool. For state sync it's **paying for information both sides already agreed on**. So: two paths.

#### 8.1.1 Room messages → `MessagePackSerializer` (default, keep)

Stays the pluggable `ISerializer`. Three implementation improvements over the old wrapper:

1. **Reuse `Encoder`/`Decoder` instances.** The old code called the module-level `encode()`/`decode()` functions, which construct a fresh `Encoder` (and its internal buffer) on every call — at 20 Hz × N clients that's a lot of garbage. Instantiate `new Encoder(...)` / `new Decoder(...)` once per serializer instance and reuse.
2. **`ignoreUndefined: true`** in encoder options — drops `undefined` fields instead of encoding them.
3. **Encode once, send to many.** For any broadcast or unfiltered state patch, encode a single `Uint8Array` and hand that same buffer to `transport.broadcast(clientIds, data)` — never re-encode per client. (Note: `Encoder.encode()` returns a view into a reused internal buffer, so if a payload is retained beyond the current tick — queued, sent async — copy it first. Encode-once-broadcast-synchronously is safe and is the hot path.)

**Message-type interning** — an easy, large win the old code missed entirely: `room.send("playerMove", ...)` shipped the literal string `"playerMove"` on every single input, potentially 60×/second per client. The join handshake now includes the room's message-type table (`{ "playerMove": 1, "chat": 2, ... }`, derived from the room's contract in §4.1), and the wire carries the numeric id. Ids are assigned by the server at runtime and resolved by name on the client, never baked into generated bindings (§4.2). Messages sent through the untyped `sendRaw`/`onMessageRaw` escape hatch aren't in the table and fall back to an inline string plus MessagePack payload, so nothing breaks.

Note that contract-declared messages (§4.1) have known field types, so they skip MessagePack entirely and encode through the §8.1.2 codec like state ops — tag-free. MessagePack remains the encoder only for `sendRaw`/`onMessageRaw` traffic.

#### 8.1.2 State sync → `SchemaCodec` (new, schema-aware binary)

Because the handshake established every class's field list and each field's type, state ops can be written with **no type tags at all** — just payload bytes in an agreed layout:

```typescript
interface IStateCodec {
  encodeOps(ops: WireOp[], table: SchemaTable): Uint8Array;
  decodeOps(data: Uint8Array, table: SchemaTable): WireOp[];
  getName(): string;
}
```

Encoding rules:
- **Op + field packed into one byte** where possible: 2 bits of op code + 6 bits of field index (classes with >63 fields spill to a follow-up varint byte).
- **Varint (LEB128) for all integers**, including `refId`s — small refs cost 1 byte, and they stay small because they're assigned per-room incrementally (§5.7.1).
- **Zigzag + varint for signed values**, so small negative numbers don't cost 10 bytes.
- **No type tag per value** — the field index implies the type via the handshake table.
- **Booleans bit-packed**: multiple boolean fields changing on the same instance in the same tick collapse into a single bitfield byte rather than one value each.
- **Fixed-point/float32 fields** (§5.7.6) are written at their declared width, decided by the field's declared type, not by inspecting the runtime value.

Concrete comparison for one position update — `[SET, refId=12, field=3, 145.5]`:

| Encoding | Bytes | Breakdown |
|---|---|---|
| JSON | ~40 | key names + digits |
| MessagePack (positional array, §5.7.3) | 13 | array hdr 1 + op 1 + ref 1 + field 1 + float64 9 |
| MessagePack + fixed-point (2dp) | 6 | …+ `14550` as a 3-byte int |
| **`SchemaCodec` + fixed-point** | **4** | op/field packed 1 + ref varint 1 + value zigzag varint 2 |

That's ~3× better than tight MessagePack and ~10× better than JSON, on the single most frequent message in a realtime game.

#### 8.1.3 Phasing

`SchemaCodec` is the largest piece of new work in this spec, so build it in two stages and keep both behind the same seam:

- **Phase 1** — implement state sync over `MessagePackSerializer` using the positional `WireOp[]` encoding from §5.7.3. Fully correct, already a big improvement, gets the system working end to end.
- **Phase 2** — implement `SchemaCodec` against the same `WireOp[]` input/output and swap it in via `ServerOptions.stateCodec`.

Because both stages consume and produce identical `WireOp[]`, Phase 2 is a drop-in swap with no changes to the state layer, and the §11.1 bandwidth tests can run against both to prove the improvement rather than assume it. Keep `MessagePackSerializer` selectable for state sync permanently — it's invaluable for debugging, since its output is inspectable without the schema table.

#### 8.1.4 Server option

```typescript
interface ServerOptions {
  // ...
  serializer?: ISerializer;   // room messages — default MessagePackSerializer
  stateCodec?: IStateCodec;   // [NEW] state sync — default SchemaCodec (Phase 2), MessagePack-backed in Phase 1
}
```

The browser SDK negotiates this at join: the handshake names which codec the room is using, and the client selects the matching decoder rather than being configured separately. A mismatch is a hard error at join time, not a silent decode corruption.

## 9. Message Flow

**Client → Server:**
```
Client calls room.send(type, data) → encode with ISerializer → WebSocket →
Server decodes → routes to Room by roomId → Room._handleMessage dispatches to onMessage(type) handlers → state mutation
```

**Server → Client (state sync):**
```
Simulation tick (default 60 FPS, onTick called) → state mutations record specific ops into ChangeTrees →
Sync tick (default 20 Hz) → onBeforeSync() → generateDeltas() emits WireOp[] (per-client only if filtered fields exist) →
encode with ISerializer (MessagePack, positional arrays) → optional permessage-deflate at the transport →
send to each client → clearChangeTrees() →
Client decodes → applyDelta() → onChange/onAdd/onRemove fire → room.onStateChange fires
```

If no state changed during a sync tick, **send nothing** — never emit an empty patch frame. Idle rooms should cost zero bandwidth.

**Cluster mode (client on a different process than the room):**
```
Client → WebSocket (local process) → MatchMaker resolves target is remote → RoomProxy →
Backplane publish (PROXY_MESSAGE) → target process's Room → state mutation →
Backplane publish (delta) → local process → WebSocket → Client
```

## 10. Security & Auth (developer responsibility, unchanged from original design)

The framework provides `onAuth` hooks and does not implement authentication itself:

```typescript
class MyGameRoom extends Room<MyGameRoomState> {
  // Static: called only when creating a NEW room
  protected static async onAuth(client: Client, options: unknown, context: ConnectionContext) {
    const userdata = await verifyJWT(context.token);
    if (!userdata) return false;
    return userdata; // truthy object -> becomes client.auth, passed to onJoin
  }
  // Instance: called when joining an EXISTING room, has access to room state
  protected override async onAuth(client: Client, options: unknown, context: ConnectionContext) {
    if (this.clients.size >= this.maxClients) return false;
    return true;
  }
}
```

Framework guarantees: messages are decoded before reaching handlers; rooms are isolated from each other; state sync is automatic; connections are cleaned up on disconnect/kick/shutdown. Developers are responsible for token verification, input validation, rate limiting, and using WSS/HTTPS in production.

## 11. Testing

`bun:test`, colocated `*.test.ts` per module, mock implementations of `ITransport`/`IStore`/`IBackplane` for isolated Room/Server tests. Example pattern:

```typescript
import { describe, test, expect, beforeEach } from "bun:test";

describe("MyGameRoom", () => {
  let room: MyGameRoom;
  beforeEach(() => { room = new MyGameRoom(mockOnCreateOptions, new MessagePackSerializer()); });

  test("handles player movement", async () => {
    await room["onCreate"]({});
    const client = createMockClient();
    await room["onJoin"](client, {}, {});
    room["_handleMessage"](client, "playerMove", { x: 10, y: 20 });
    expect(room.state.player.x.get()).toBe(10);
  });
});
```

### 11.1 Bandwidth regression tests — **[NEW]**

Because §5.7 is the main reason for this rebuild's wire-format work, bandwidth must be *asserted*, not assumed. Add a dedicated benchmark suite in `@bungohan/state` that encodes representative scenarios and asserts byte-size ceilings, so a future refactor that silently reverts to fat encoding fails CI:

```typescript
test("single position update on one entity in a 100-entity room stays under N bytes", () => {
  const ops = generateDeltas(state);
  const bytes = new MessagePackSerializer().encode(ops).byteLength;
  expect(bytes).toBeLessThan(N);
});
```

Cover at minimum: (1) one field change in a large room, (2) all entities moving simultaneously (worst-case tick), (3) entity add/remove churn, (4) initial join snapshot size, (5) idle tick emits zero bytes. Record the measured numbers in the test names/comments so regressions are legible in the diff.

### 11.2 `@bungohan/testing` — in-process harness — **[NEW]**

Testing a networked framework by booting real sockets and sleeping on real timers is slow and flaky. Ship a harness instead:

- **`LoopbackTransport`** — an `ITransport` implementation that wires client and server together in one process with no sockets. Full protocol path (encode → "transmit" → decode) still exercised, so it catches serialization bugs that a mocked transport would hide.
- **Manual clock** — tick advancement is explicit, never wall-clock. `await harness.tick(16)` runs exactly one 16ms simulation step. Tests become deterministic and run in microseconds rather than sleeping for real sync intervals.

```typescript
const harness = createTestHarness({ rooms: { shooter: ShooterRoom } });
const client = await harness.connect();
const room = (await client.joinOrCreate<ShooterState, typeof shooterContract>("shooter")).unwrap();

room.send("playerMove", { x: 10, y: 20 });
await harness.tick(16);          // exactly one simulation step
await harness.flushSync();       // force a sync tick, deterministically

expect(room.state.players.get(room.sessionId)?.x.get()).toBe(10);
```

Also expose `harness.bytesSent()` / `bytesReceived()` so §11.1's bandwidth assertions can run against a *full round trip*, not just the encoder in isolation.

### 11.3 Protocol conformance vectors — **[NEW]**

Because non-JS clients (§4.2) implement the protocol independently, correctness can't live only in TypeScript tests. Ship a **versioned corpus of golden vectors**: each case is a language-neutral JSON description of a handshake + op sequence, paired with the exact expected bytes.

```
conformance/
  v1/
    001-primitive-set.json        # { description, schema, ops, expectedBytesHex }
    002-collection-add-remove.json
    003-nested-schema-patch.json
    004-fixed-point-precision.json
    005-filtered-field-per-client.json
```

Any implementation in any language runs the corpus and must match byte-for-byte. This is what makes a community-contributed Godot client trustworthy without reverse-engineering, turns `PROTOCOL.md` into something verifiable rather than prose, and doubles as the §11.1 bandwidth suite since every vector has a known size. Bump the directory version only on breaking wire changes.

## 12. Build Order

Given package dependencies, implement in this order so each layer can be tested against real (not mocked) lower layers:

1. `@bungohan/result` — no deps
2. `@bungohan/types` — no deps. Includes the §4.1 contract builders (`defineMessage`, `defineContract`, `f`, `Infer`) and the `WireOp`/`SchemaTable` types, so both `state` and `serializer` can depend on the wire vocabulary without depending on each other.
3. `@bungohan/state` — depends on `result`, `types`
4. `@bungohan/serializer` — depends on `types` (external: `@msgpack/msgpack`). Ship `MessagePackSerializer` + `JsonSerializer` first; `SchemaCodec` (§8.1.2) is Phase 2.
5. `@bungohan/transport` — depends on `result`; external: Bun native `Bun.serve`
6. `@bungohan/store` — depends on `result`; external: Bun native `RedisClient`
7. `@bungohan/backplane` — depends on `result`; external: Bun native `RedisClient`
8. `@bungohan/core` — depends on all of the above
9. `@bungohan/client-js` — depends on `result`, `serializer`, `state`, `types` (never `core`, never Bun/Node-only APIs — must run in a browser)
10. `@bungohan/testing` — depends on `core` + `client-js`; the loopback harness (§11.2). Build it early enough to use it while developing 8 and 9.
11. `PROTOCOL.md` + `conformance/` vectors (§11.3) — write these as the wire format stabilizes, not after. They're the contract every non-JS client implements against.
12. `@bungohan/codegen` — depends on `types`; emits C#/GDScript/JSON bindings (§4.2)
13. `apps/example-shooter` — exercises everything end-to-end; port the existing app's server/client/shared code onto the rebuilt API, adjusting call sites for the **[NEW]**/**[FIX]** items above (it can now use `server.onJoin(...)` instead of hand-rolling it via `RoomManager`, should declare its messages through a §4.1 contract, and should switch from its bespoke `useBungohan` hook to the real `@bungohan/client-js/react` one).
