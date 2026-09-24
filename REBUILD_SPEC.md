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
- **Field order is `Object.keys(fields)`**, i.e. declaration order. Field names must be identifiers (codegen emits them as members) and must not be integer-like (JS would reorder them). This is enforced twice. At compile time, any numeric-looking key is a type error. At runtime, `defineMessage` checks once, when it is called, and throws a `TypeError` for keys JS actually reorders (`"0"`, `"42"`; not `"07"` or `"1.5"`). That throw is a deliberate exception to "framework code does not throw": it can only fire while the defining module loads, as a static programming error. It is never a runtime condition, and it adds nothing per message.
- **`f.enum` values encode as their index** in `values`.
- **[DECIDED] `Infer` stops at the wide types.** `InferField<Field>` is `unknown` and `InferShape<FieldShape>` is `{ [key: string]: unknown }`, so `Infer<MessageDef>` is an open record. Without that stop, an unresolved generic recursed forever (`NestedField<MessageDef>` → `Infer<MessageDef>` → …). Any generic implementation such as `function send<M extends MessageDef>(m: M, p: Infer<M>)` then failed with TS2589 ("type instantiation is excessively deep"), and core's `Room.send` implementation would have hit the same error. Concrete descriptors never reach the stop, so every inferred type is unchanged.
- The guarantee is enforced by `packages/types/src/contract.test-d.ts`: `@ts-expect-error` assertions for unknown message names, wrong/missing/excess payload fields, wrong direction, and `EmptyContract` rooms, all run by `tsc --noEmit`. `Room`/`IRoom` must keep the exact generic signatures above for that test to remain representative.

TypeScript clients import the same contract and get the mirrored view, with the direction inverted:

```typescript
const room = (await client.joinOrCreate<ShooterState, typeof shooterContract>("shooter")).unwrap();
room.send("playerMove", { x: 10, y: 20 });          // client → server, checked
room.onMessage("gameStart", (msg) => msg.level);    // server → client, inferred
```

#### 4.1.2 Typed join and create options — **[DECIDED]**

Join and create options used to be the last untyped input: `client.joinOrCreate("game", options)` took anything, and every hook received `Record<string, unknown>`, so rooms picked values out by string key and narrowed them by hand (the example app kept a whole `utils/options.ts` for it). They are now part of the contract and get what messages get: compile-time checking on both ends and type-directed decoding, **with no validation pass** (§4.1).

**Declaration.** A contract may declare `options: { create?, join? }`, each a `defineMessage` declaration:

```typescript
export const shooterContract = defineContract({
  client: { … }, server: { … },
  options: {
    create: defineMessage("shooterCreateOptions", { roomName: f.optional(f.string), maxPlayers: f.uint8, isPrivate: f.bool }),
    join:   defineMessage("shooterJoinOptions",   { playerName: f.string }),
  },
})
```

- They differ because they mean different things: **create options** are settings for a room a join creates, sent only in the creating modes; **join options** are what every joiner tells the room about itself. A creating join sends both.
- **Declaring neither keeps today's untyped behaviour exactly**, wire included: that is the escape hatch for dynamic payloads, and every contract that existed before hashes as it did. Declaring one makes options typed; the other is then the message with no fields (`NO_OPTIONS`, typed `NoOptions`), which encodes to zero bytes.
- `validateContract` checks the declarations (and refuses an unknown key such as `joins`), and `createRoomType` refuses create options named like a field `onCreate` already receives (`roomId`, `maxClients`, `metadata`, …): both definition-time errors (§6.8.4).

**Types** (`packages/types/src/contract.ts`): `InferJoinOptions<C>` / `InferCreateOptions<C>` are the declared payload, `NoOptions` for a kind left out, or `UntypedOptions` (`{ [key: string]: unknown }`) when neither is declared. `CreateArg<C>` is what a client passes in the creating modes: the join options alone, or `{ create, join }` when create options are declared. `TypedOptionsContract` / `UntypedOptionsContract` split contracts for overloads. The hooks are typed from the room's contract: `onCreate(options: RoomOnCreateOptions & InferCreateOptions<C>)`, `onAuth`/`onJoin(…, options: InferJoinOptions<C>, …)`; the static `onAuth` gets the joiner's options too, but a static method can't see `C`, so it declares its parameter type itself. **`RoomOnCreateOptions` became a type alias** (it was an interface): an interface has no implicit index signature, so a room whose `onCreate` takes `RoomOnCreateOptions & {…}` stopped being assignable to `Room` under TypeScript 7.

**Wire: bytes, decoded once the room type is known** (PROTOCOL.md §6.2.1 has the exact bytes). The `JOIN` body gained a fifth element: `[mode, target, options, contractHash, createOptions]`. For a typed room type, `options` and `createOptions` are each a MessagePack **`bin`** holding a `schema`-encoded message (§13.1.6), or `null` for zero bytes.

- **Why opaque bytes.** The encoding is tag-free, so only the declaration can read it, and for `JOIN_BY_ID` the frame names a room id, not a type: the server can decode only once the room is found, and in a cluster only on the process that owns it (a process need not define every room type, §6.4.1). So the bytes ride along unchanged until then. In modes 0–2 the target *is* the type, and the server decodes before looking for a room.
- **Why `schema`, whatever the room's codec.** The codec is named in `JOIN_SUCCESS`, which answers this very frame; a client can't know it yet. `schema` is the compact encoding every client already implements for messages.
- **Why not inline MessagePack arrays.** They would be decodable generically, but the positional MessagePack form still carries tags a hostile client can set to anything, and would have made the options' encoding depend on the connection's `ISerializer`. Bytes decoded against the declaration are the same guarantee messages have: a `fixed:2` field *cannot* arrive as a string, because it is read as a zigzag varint.
- **When it doesn't match.** Options that aren't `bin`/`null` (e.g. a MessagePack map from a client built without the declarations) or bytes that don't decode exactly fail the join with **`JOIN_ERROR INVALID_OPTIONS`**, after the contract-hash check and before a room is created, a seat is taken or a hook runs. It is deliberately not a protocol violation: `INVALID_OPTIONS` already meant "the JOIN has the wrong shape", and the connection's other seats are unaffected. Create options are decoded only by a join that actually creates (a `JOIN_OR_CREATE` that finds a room never reads them).
- Encoders write all five elements, `null` for zero bytes and for `createOptions` in modes 2–3; RECONNECT and CONSUME_RESERVATION ignore options and send the old four-element body.

**Version skew is the contract hash's job, and it holds** (the question the task asked to confirm). The declarations are part of the hash: `contractLayout` appends `options{create:…;join:…}` when either is declared (§6.7.4). So a client built against older declarations fails with `CONTRACT_MISMATCH` before anything is decoded; `packages/testing/src/core/options.test.ts` shows it, and shows that the same stale client sending `null` for the hash gets `INVALID_OPTIONS` rather than mis-decoded options (its bytes are one field short).

**Server-built options are converted through the same bytes.** `matchMaker.createRoom` / `joinOrCreate` / `reserve` and `room.join` (bots) encode what the server passes and decode it again, so a room receives exactly what the same options from a client would have produced (integers saturated, `fixed` rounded, −0 kept), and options that don't fit are `INVALID_OPTIONS`, a `Result`, never a throw. It runs once per call, never per tick or message. **Typing them:** the matchmaker methods also accept the **room class** instead of its name (`mm.createRoom(ShooterRoom, { maxPlayers: 4, isPrivate: false })`), which types the options from its `static contract` (`CreateRoomArgs<R>`, `ReserveArgs<R>`); by name they stay `unknown` and the conversion is the check. A class registered under two names is `INVALID_OPTIONS`, one not registered on this process is `ROOM_TYPE_NOT_DEFINED`. `reserve(type, joinOptions, selector?, createOptions?)` takes the create options for a room it may have to create; without typed options the one argument serves as both, as before.

**Local and remote stay identical.** A client's typed options cross the backplane as the bytes it sent; server-built ones bound for another process are encoded *on the calling process* and cross as bytes too, and the owner only decodes. So the MessagePack hop's known losses (−0 → 0, a `Map` → a plain object; §6.4.1) cannot reach typed options at all. `fidelity.test.ts` compares a local and a remote room for client joins, `createRoom` and `reserve`, including −0, and fails if server-built options are sent unencoded.

**Clients.** client-js: `joinOrCreate`/`create` take `CreateArg<C>`, `join`/`joinById` take `InferJoinOptions<C>`, through overloads that require the contract when it declares options (and keep every argument optional when it doesn't); `joinWith(mode, …)` is the non-overloaded form for code generic over the contract (React's `useRoom`, which is overloaded the same way, typing `options` by `mode`). `joinBody` (exported) builds the body; the byte-level `TestClient` uses it too. C#: `TypedOptions` (protocol core) and `BungohanClient.EncodeJoin`; GDScript: `protocol/typed_options.gd` and `BungohanClient.encode_join`. In both, the generated contract gains `JoinOptions(join)` / `CreateOptions(create, join)` (`join_options` / `create_options`) whose parameters are the generated message classes, so the options are typed there too.

**Semantic checks stay game logic.** The framework guarantees `playerName` is a string; it cannot know the game's length limit. The example app now declares its options in `shooterContract`, and `server/src/utils/options.ts` only clamps (name length, blank names, player count); its `typeof` narrowing is gone. (Room `metadata`, read back by the lobby, is matchmaker data outside any contract, so `parseListing` still narrows it.)

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

#### 4.2.1 Codegen and the non-TypeScript clients as built — **[DECIDED]**

What exists is each language's **protocol core**, the codegen that binds to it, and tests proving both against the vectors and a real recorded stream. (Cluster mode, §6.4.1, came after and changed none of it: it adds no wire change, so every vector and both runners are untouched.) Networking — the transport seam, the client, the join handshake and reconnection — was added on top and is §4.2.2. PROTOCOL.md §15 lists the pitfalls met on the way.

**`@bungohan/codegen`** (`packages/codegen`):

- CLI: `bunx @bungohan/codegen --contract <module> --state <module> --lang <csharp|gdscript|json> --out <dir> [--namespace N] [--addon res://…]` (`src/cli.ts`, also exported as `main`). Either module may be omitted, and they may be the same module. It `import()`s them and walks the runtime descriptors: every export that is a contract (`{ client, server }` of message descriptors), every exported Schema subclass, then `reachableSchemaClasses` and each class's `_ensureInit()` field table. No compiler API.
- **The model** (`buildModel`) is the neutral input of every emitter: contracts sorted by export name (with their hash), every message the contracts reach including nested ones (sorted by name), every reachable schema class (sorted by name). It runs `validateContract` and `validateSchemaClass`, and refuses two different messages (or classes) sharing a name, because generated classes are named after them. Those are definition-time errors (`CodegenError`, exit 1).
- **Determinism**: output depends only on the descriptors and the options. The header names the modules as `<package name>/<path in package>`, never an absolute path or a date, so every machine generates byte-identical files.
- **No numeric ids, ever.** A contract binding carries `Hash` and its messages *by name*; message ids come from the handshake and class ids from `DEFINE`s (spec §4.2 rule). A test asserts the C# contract contains the hash and no id.
- **C#** (`Schemas.cs`, `Messages.cs`, `Contracts.cs`, in `--namespace`, default `Bungohan.Generated`). Schema classes are `sealed partial`, derive from `Bungohan.Protocol.Schema`, and expose each primitive field as a read-only property with a `<Member>Changed(value, previous)` event; nested instances and collections are read-only properties (`MapSchema<K,V>`, `SetSchema<T>`, `ArraySchema<T>`). Members are PascalCase; a name that collides with a generated or inherited member (`Definition`, `Class`, `Equals`, the class name, a `…Changed` event) gets `_` appended. Message classes (`<Name>Message`) have settable properties, `Definition`, `ToPayload`/`FromPayload`, `Encode(codec)`/`Decode(codec, body)`. Types: `sbyte short int byte ushort uint`, `float` (float32), `double` (float64, fixed), `List<T>`, `Dictionary<string,T>`, `T?` for optionals (message-level and inside collections). A string enum whose values give distinct identifiers becomes a nested C# `enum` indexed like the wire; other enums stay `double`/`string`/`object`.
- **GDScript** (`schemas/`, `messages/`, `contracts/`, `bindings.gd`). One script per class, **no `class_name`** (nothing collides with a project's global classes, and no editor import step is needed); `bindings.gd` preloads everything and has `create_registry()`. Schema scripts declare `SCHEMA_NAME`, `FIELDS` (`[wire name, type, member]`), a typed `var` per field and a `<member>_changed(value, previous)` signal per primitive field. Members are snake_case (`isDead` → `is_dead`); keywords and Object/RefCounted members get `_` appended. Message scripts mirror the C# ones (`definition()`, `to_payload()`, `from_payload()`, `encode()`, `decode()`).
- **JSON** (`bungohan.json`, format `bungohan-codegen/1`): contracts (name, hash, message names per direction), messages as PROTOCOL.md §14 declarations, schema classes as `[field, type]` lists.
- **[DECIDED] Typed options** (§4.1.2): the model carries each contract's option declarations, which are generated like any message. A C# contract class gains `JoinOptions(join)` and `CreateOptions(create, join)` returning `TypedOptions`, a GDScript contract script `join_options(join)` and `create_options(create, join)`, each with exactly the declared messages as typed parameters; a JSON contract gains `"options": { "create"?: name, "join"?: name }` (additive, so the format stays `bungohan-codegen/1`). A contract without options generates exactly what it did. The golden fixture has a contract with both kinds and one with join options only.
- **Tests** (`src/codegen.test.ts`): golden files for all three languages from `test/fixture` (every field kind, enums of strings and numbers, optionals everywhere, nested arrays of messages, a class name that isn't an identifier, colliding names), `UPDATE_GOLDEN=1` to rewrite; determinism; and that the committed example bindings are up to date (`bun run codegen:example` regenerates them). The C# goldens are compiled by `clients/csharp/Bungohan.Bindings` and every GDScript golden is loaded by the Godot runner, so a generator change that emits invalid code fails a build.

**C# protocol core** (`clients/csharp/Bungohan.Protocol`): netstandard2.1, C# 9, nullable, warnings as errors, **no NuGet packages**, no reflection, no `init`/records (they need types netstandard2.1 lacks), so it builds for Unity and Godot .NET alike.

- Nothing throws on bad input: `Result<T>` / `Result` with a `ProtocolError { Code, Message }` (`DECODE_FAILED`, `ENCODE_FAILED`, `MALFORMED_OP`, `UNKNOWN_REF`, `UNKNOWN_CLASS`, `SCHEMA_MISMATCH`, `NO_SNAPSHOT`). Throwing is reserved for programmer errors in generated code (a collection built with a type string its generic arguments don't match).
- Its own strict UTF-8 validator (never `UTF8Encoding`'s substitution); `ByteWriter`/`ByteReader` (sticky errors, little-endian floats, canonical NaN); `Numeric` (§12, `MidpointRounding.AwayFromZero`); a MessagePack encoder/decoder covering §4 (`MsgMap` keeps insertion order; bin supported, ext refused; repeated keys, `__proto__` and non-string keys refused; depth- and count-bounded); `Frames`.
- `WireOp` carries numbers as `double` (exactly the JavaScript op model); `SchemaCodec` and `MessagePackCodec` implement `IStateCodec` (sessions, rollback on a failed frame) and contract messages over `MessageDef`/`FieldType`, with payloads as `MsgMap`.
- The replica: `StateDecoder` applies ops to generated `Schema` subclasses (class matching by name, fields by name, zero reset, holder counts and end-of-frame drops, ignored unknown classes, deferred events; listener exceptions are caught and reported). `StateStream<TRoot>` starts a fresh session, decoder and root per snapshot and raises `Replaced` before applying it. One deliberate refinement over `@bungohan/state`'s decoder: when a nested field is rebound to a new refId, the old block is forgotten, so a later reuse of it can't resolve to the nested object.
- Tests: `dotnet run --project clients/csharp/Bungohan.Protocol.Tests` (net10.0 console app, no packages): every vector except `behavior` (263 cases), replica tests, and the bindings tests below.

**GDScript protocol core** (`clients/godot/addons/bungohan`, a Godot 4 addon): the same scope, `protocol/` and `replica/`, reached with `preload` (no `class_name`). Ops are Arrays in their tuple form; Results are `result.gd`. Engine behaviors worked around (PROTOCOL.md §15): lenient UTF-8 decoding (own validator; NUL and a leading BOM decoded by hand; Godot strings can't hold U+0000), `==` between a String and an int being a runtime error, no shifts of negative constants, big-endian MessagePack floats assembled from bits, `RefCounted` cycles (a collection references its owner through a `WeakRef`, or replicas leak). Signals are emitted after the frame.

- Runners: `cd clients/godot && godot-mono --headless --script tests/run_vectors.gd` (every vector except `behavior`), `tests/run_replica.gd`, and `tests/run_all.gd` (vectors, replica, bindings). They extend `tests/harness.gd`, which installs a `Logger` before loading anything and fails the run on **any** engine or script error. That matters: GDScript has no exceptions, and a typed function cut short by an error returns its type's default (`""` for `-> String`), which would read as a passing check. The vector runner parses JSON with its own exact decimal-to-double conversion (`tests/json_exact.gd`), because Godot's isn't correctly rounded.

**Proof on a real stream.** `apps/example-shooter/server/scripts/record-stream.ts` plays the shooter with two client-js clients on the loopback harness and records every state and message body one client received, the handshake's message table, listener event counts, and a canonical dump of its replica (`clients/fixtures/shooter-stream.schema.json`: a full 60 s round ending in `gameEnded`, and `shooter-stream.messagepack.json`: 15 s). `record-stream.test.ts` replays both through `@bungohan/state` in `bun test`; the C# and GDScript tests replay them through the **generated** classes (`clients/csharp/Bungohan.Bindings/Shooter`, `clients/godot/example/shooter`) and must reach the same final state, the same event counts and the same message payloads. The recording uses `Math.random`, so re-recording changes the files; the committed ones are the reference.

#### 4.2.2 Networking in C# and GDScript — **[DECIDED]**

Both languages now have a real client, not just a protocol core: `clients/csharp/Bungohan.Protocol/Net/` and `clients/godot/addons/bungohan/net/`. Both implement PROTOCOL.md §6 and §7 the way client-js does (§7.5), in their own idioms, and both are proven against a real server.

**The transport seam comes first, and is pluggable in both.** A client needs only: open a connection offering subprotocols, send and receive whole binary frames, learn when it closed. C#: `IClientTransport.Open(url, protocols, IClientSocketHandlers) → Result<IClientSocket>`, defaulting to `WebSocketClientTransport` (`System.Net.WebSockets.ClientWebSocket`). GDScript: `net/client_transport.gd`, defaulting to `websocket_client_transport.gd` (`WebSocketPeer`). Both offer `bungohan.v1` (§2). Pluggability is not decoration: **Unity WebGL cannot use `ClientWebSocket`** and needs a `.jslib`-backed transport, and the conformance runners inject frames through one instead of opening a socket.

**Callbacks arrive on the main thread, through a poll/pump model.** `BungohanClient.Poll()` (C#) and `poll()` (GDScript) are the single place where frames are parsed, signals/events raised, and joins completed. The game calls it from `Update`/`_Process`.

- **C#** queues what the transport reports (`ConcurrentQueue<Action>`), because `ClientWebSocket` receives on a background task; `Poll()` drains it. Joins return `Task<Result<BungohanRoom>>` whose `TaskCompletionSource` is completed **inside `Poll()` without `RunContinuationsAsynchronously`**, so `await` resumes on the polling thread. Reentrant `Poll()` is a no-op, so a listener can't recurse into the pump.
- **GDScript** drives the socket from `poll()` (`WebSocketPeer` has no threads), emits signals, and resolves joins through a `Waiter` that carries `done`/`result` as well as its `settled` signal. `await client.join_or_create(…)` works because `_process` keeps polling; a `Waiter` is needed because GDScript refuses to call a coroutine without `await`, so a resume after a reconnection starts one through the non-awaiting `_start_request`.
- **Ordering that client-js gets from a 0 ms timer** (§7.5, frames held during a first join) falls out of the pump instead: the pending join is settled first — its continuation resumes inline and registers handlers — and the held frames are released immediately after. The **unclaimed-event** rule is kept for handlers registered later still, for every event kind client-js keeps (contract and raw messages, client joined/left, errors), and a kept event is delivered on a later `Poll()`, never inside the call that registered its handler. **[DECIDED]** In C#, `OnMessage` and the `Message`, `RawMessage`, `ClientJoined`, `ClientLeft` and `ErrorReceived` events claim on registration: those events have custom `add` accessors, so `+=` claims. A GDScript signal has no hook on `connect`, so `poll()` does the claiming instead. Each poll hands every kept event to whatever now listens for it (an `on_message` handler or a connection to `message`, `raw_message`, `client_joined`, `client_left` or `error_received`). A plain `connect` therefore claims too. Both runners pin it with a `room events` suite: a scripted room sends one event of each kind from its `onJoin`, and handlers attached after the join resolves receive each one once. The interop `options` case now reads the room's `onJoin` echo through a handler attached after the join.

**Timers have no threads either.** Ping interval, join timeout and reconnection backoff are deadlines checked in `Poll()` against a monotonic clock (`Stopwatch` / `Time.get_ticks_msec()`), both overridable.

**`RefCounted` cycles** (PROTOCOL.md §15) bite the GDScript client as they bite collections: a room holds its client through a `WeakRef`, and the socket's callbacks capture the client weakly, or a run leaks every client it made. The Godot runner fails on leaks, which is how this was found.

**The 40 `behavior` vectors now run everywhere.** Client-side cases (17) drive the client through an injected transport in each language, from the state the vectors specify (one joined room at roomRef 1, no contract), and check that exactly one frame was dropped (`drop`) or none (`accept`) and that the connection and room survive. Server-side cases (23) describe what the *server* must do, so both runners send the frames verbatim to the real server over a real socket. Nothing is skipped in `bun run test:csharp` / `test:godot`.

- **[DECIDED] The violation reason rides on the close frame too.** Since a client may never see the `ERROR`, core's `_violation` now sends `why` as the **close reason** as well as in the `ERROR` body, clipped by `clipCloseReason` (`@bungohan/transport`, the same 123-byte helper version negotiation uses, now exported). It used to close with a constant `"protocol violation"`, which left a GDScript client with a bare 1008 and no explanation. PROTOCOL.md §8.2 says so, `compat.test.ts` pins that the two strings agree for every violation kind, and both client runners check the reason is non-empty and matches the `ERROR` when one arrived.
- **[DECIDED] A `violation` case is checked by the close code, not the `ERROR` frame.** Godot's `WebSocketPeer` discards buffered inbound packets when the peer reaches `STATE_CLOSED`, so the `ERROR(0, INVALID_MESSAGE)` a server sends immediately before closing never reaches a GDScript client; .NET's `ClientWebSocket` does deliver it. This is an engine limitation, not a protocol difference, so it was resolved in **PROTOCOL.md §8.2 and §15** (the `ERROR` is a courtesy; close code 1008 is the signal) and in **§14**'s definition of the `behavior` kind, and both runners apply one rule: require the 1008 close, and require any `ERROR` that *did* arrive to be `INVALID_MESSAGE`. The strict "an `ERROR` precedes the close" assertion stays pinned in `bun test`, whose byte-level `TestClient` sees every frame. The GDScript transport also now drains buffered packets whatever the ready state, which is worth doing regardless.

**End-to-end against a real server.** `packages/testing/src/interop/` is a small deterministic server (`bun run test:csharp` / `test:godot` start it through `scripts/interop.ts`, which passes `BUNGOHAN_INTEROP_URL`): room type `interop` (the `shared.ts` contract and state — fixed-point, integer and boolean fields, a `schemaMap`, a `set`, an `array`, optional and nested message fields), `compat` (no contract, what the `behavior` vectors target) and `solo`. No randomness and no clock-dependence: every value a client sees follows from the messages it sent. Its bindings are generated (`bun run codegen:interop`) and their freshness is a codegen test, like the example app's.

Each language runs the same seven cases: join and verify the replica **field by field against the server's own `dump` of its state**, typed messages both ways (including an absent optional), raw messages, a kick (`LEAVE 4000`, connection untouched), a reconnection after the server drops the whole connection (same `sessionId`, a *new* token, a new replica object restored from the fresh snapshot alone), a contract-hash mismatch, and a codec mismatch. **[DECIDED]** Later additions bring it to nine: PING, a room without reconnection, and typed join and create options through the generated `CreateOptions`/`create_options` (§4.1.2), which the interop server's private `options` room echoes back, plus an untyped options map refused with `INVALID_OPTIONS` on a connection that stays open. That room is also what the `join` vectors target. `server.test.ts` runs the equivalent through client-js in `bun test`, so the server can't drift between cross-language runs.

**[DECIDED] A flake the sweep exposed:** `check:browser` held `D` for 1.2 s and required B's `x` to rise by 50, but players spawn at a random `x` and the arena clamps at `ARENA_WIDTH`. A spawn near the right wall failed the check. B now walks away from the nearer wall, and the assertion follows the direction.

**Unity support comes from constraints, not testing.** `Bungohan.Protocol` stays netstandard2.1 / C# 9 / no NuGet / no reflection, with warnings as errors, and the networking layer was written to that (no `record`, no `init`, no `System.Text.Json`). `clients/csharp/README.md` has the Unity section, including that **WebGL needs its own transport**. **Unity was not installed, so none of this was run in Unity** — what is verified is that it compiles under those constraints and behaves correctly on .NET 10 against a real server.

## 5. `@bungohan/state` — Schema & Delta Sync

**[KEEP the model, FIX/ADD filter support]**. This is the most structurally different package vs. the old aspirational docs — build it as factory functions, not decorators.

### 5.1 Defining schemas

```typescript
import { Schema, createNumber, createString, createSchemaMap } from "@bungohan/state";
import { f } from "@bungohan/types";

class Player extends Schema {
  public static override schemaName = "Player";
  public x = createNumber(0);
  public y = createNumber(0);
  public name = createString("");
}

class RoomState extends Schema {
  public static override schemaName = "RoomState";
  public score = createNumber(0);
  public players = createSchemaMap(f.string, Player); // [DECIDED] element descriptors, §5.3
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

  **[DECIDED] Where `_ensureInit()` actually runs:** when an instance is attached to an initialized parent (collection insert, or the parent's own init walking its fields), at the first `encodeSnapshot`/`generateDeltas` on a root, and at the first `applyDelta` on a receiver root. A field wrapper cannot trigger it on mutation: until init, the wrapper has no link to its owner. That's fine, and it's by design. **Mutations are only recorded once an instance is *known* to clients (has a wire refId).** Before that, nothing has observed the instance, and it is serialized in full the first time it is sent, so there is nothing to diff against. It also means detached instances never accumulate change logs. Field names starting with `_` are reserved and never synchronized.

  **[DECIDED] Plain fields are never synchronized.** Only wrapper fields (from the `create*` factories) and directly nested Schema instances are part of a class: its table entry, its snapshot and its ops. A plain field (`public vx = 0`, an array, a `Map`, any non-wrapper value) stays local to the object it lives on: never sent, never in the class table, never touched by a receiver's `applyDelta`. That is the intended place for server-only data (velocities, cooldowns, timestamps) on a class both sides import. `_`-prefixed names stay reserved for the framework, so don't use them for such fields. `schemaName` must be the class's *own* static (an inherited one is ignored); if it's missing, the JS class name is used with a console error, since minification breaks it.
- Every instance gets a `_id` (nanoid) and `_tree: ChangeTree`.

### 5.2 Primitive wrappers

```typescript
function createNumber(initial?: number): NumberState;
function createString<T extends string = string>(initial?: NoInfer<T>): StringState<T>;
function createBoolean(initial?: boolean): BooleanState;
```

Each wrapper exposes `.get()`/`.set(value)` (or a getter/setter equivalent used consistently across the codebase), `.onChange(listener: (newValue, oldValue) => void): () => void`, `.offChange(listener)`.

**[DECIDED] Integer fields:** `createInt(f.int32)`, and likewise `f.int8 … f.uint32`, with an optional initial value (`createInt(f.uint8, 1)`) → `IntState`. The table type is the kind itself (`"int32"`, §5.7.2). The wire value follows the integer message-field rule (§8.1.1): truncated toward zero, saturated at the kind's range, NaN → 0, never -0. Like fixed-point (§5.7.6.1), the server keeps what was set, and a write marks the field dirty only when the wire integer changes. Receivers hold the integer and reject a wire value that isn't an integer of the kind (`MALFORMED_OP`). A descriptor that isn't an integer kind (only reachable through a cast) is a declaration error, reported by `validateSchemaClass`. Integers are field types only. Collection values keep the §5.3 vocabulary (`f.float64` or `f.fixed(0)`). Before this, `createFixedPoint(0)` was the only integer field, which reads wrongly and would cost a float's width in a Phase 2 codec.

### 5.3 Collections

Two parallel families depending on whether the element type is a `Schema`:

```typescript
// primitive-valued — superseded by the [DECIDED] descriptor signatures below
function createMap<K, V>(initial?: Map<K, V>): MapState<K, V>;
function createSet<T>(initial?: Set<T>): SetState<T>;
function createArray<T>(initial?: T[]): ArrayState<T>;

// schema-valued (auto-links each element's ChangeTree to the parent)
function createSchemaMap<K, V extends Schema>(initial?: Map<K, V>): SchemaMapState<K, V>;
function createSchemaSet<T extends Schema>(initial?: Set<T>): SchemaSetState<T>;
function createSchemaArray<T extends Schema>(initial?: T[]): SchemaArrayState<T>;

// [DECIDED] actual signatures (packages/state/src/factories.ts):
function createMap<K extends KeyField, V extends ValueField>(key: K, value: V, initial?: Iterable<readonly [KeyOf<K>, ValueOf<V>]>): MapState<KeyOf<K>, ValueOf<V>>;
function createSet<T extends KeyField>(of: T, initial?: Iterable<KeyOf<T>>): SetState<KeyOf<T>>;
function createArray<T extends ValueField>(of: T, initial?: Iterable<ValueOf<T>>): ArrayState<ValueOf<T>>;
function createSchemaMap<K extends KeyField, V extends Schema>(key: K, of: SchemaConstructor<V>, initial?: Iterable<readonly [KeyOf<K>, V]>): SchemaMapState<KeyOf<K>, V>;
function createSchemaSet<T extends Schema>(of: SchemaConstructor<T>, initial?: Iterable<T>): SchemaSetState<T>;
function createSchemaArray<T extends Schema>(of: SchemaConstructor<T>, initial?: Iterable<T>): SchemaArrayState<T>;
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
- **[DECIDED] Collections declare their element types at runtime** (closes the first §5.7.11 gap). The factories take the §4.1 `f.*` builders for primitive elements and keys, and the Schema class for schema elements. TypeScript infers the collection's type from them, so there are no generic arguments to write:

  ```typescript
  createMap(f.string, f.fixed(1))     // MapState<string, number>    → "map<string,fixed:1>"
  createSet(f.uint16)                 // SetState<number>            → "set<uint16>"
  createArray(f.float32)              // ArrayState<number>          → "array<float32>"
  createSchemaMap(f.string, Player)   // SchemaMapState<string, Player> → "schemaMap<string,Player>"
  createSchemaSet(Item)               // SchemaSetState<Item>        → "schemaSet<Item>"
  createSchemaArray(Item)             // SchemaArrayState<Item>      → "schemaArray<Item>"
  // each also takes optional initial contents last: createMap(f.string, f.float64, new Map([["a", 1]]))
  ```

  - **Values** (map values, array elements) use exactly the primitive *field* vocabulary: `f.float64`, `f.float32`, `f.fixed(n)`, `f.string`, `f.bool`. Lossy value types are quantized on the wire by the same rules as the matching fields (§5.7.6.1): the server keeps full precision, receivers hold the quantized value, and a write that doesn't change the wire value sends nothing. Integer kinds (`f.int8`…) are not value types: use `f.float64` (exact to 2^53) or `f.fixed(0)`.
  - **Keys** (map keys, and set elements, which are keys) are exact, never quantized: `f.string`, `f.float64`, or an integer kind `f.int8`…`f.uint32` (the natural `int` key for C#/GDScript dictionaries). Receivers reject a non-integer or out-of-range integer key as `MALFORMED_OP`, so an int-keyed map must be given integer keys. Sets therefore hold strings and numbers only, never booleans or lossy numbers: set membership over quantized values would collapse distinct server elements into one client element.
  - **Schema elements** name a class. An element may also be an instance of a subclass, because every ref on the wire carries its own `classId`. The declared class is the static element type for codegen.
  - Directly nested Schema fields are listed with their class too (`schema<Vec>`), so the table alone describes every field.
  - **Malformed declarations never throw.** Factories run inside field initializers, i.e. on every `new`, which may be a join or a spawn mid-game (a per-connection/per-tick path). Validation therefore happens once per class, when its field table is built (`_ensureInit`). A descriptor that got past the types (via a cast, or from plain JS) is logged with `console.error` naming `Class.field`, and that field is left out of the class table. It still works locally but is never synchronized, so nothing can mis-decode. There is no module-load hook for class fields, so "throw at module load" is not available here, unlike `defineMessage`. **[DECIDED]** For room state, core supplies that hook. `defineRoomType` runs `validateSchemaClass` over every reachable class and throws (§6.8.4), so this log-and-skip path is only a fallback for element subclasses first seen mid-game.
- State is a **tree** as far as nested fields go: an instance in a nested field has that one holder. Collections may share an instance among themselves, and a map may hold it under several keys (§5.7.9). Moving it (remove here, add there) is supported.
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

- `createFiltered(wrapped, fn)` returns **the same wrapper** (typed as the wrapped type, not bare `State<T>`), so its API is unchanged. It is generic in `this` and in the client type: `function (this: RoomState, client) {…}` or an arrow capturing the instance (`(client) => this.ownerId.get() === client.id`). The default client type is `FilterClient`, which core's `Client` must satisfy: **[DECIDED]** `{ readonly sessionId: string; readonly id: string }` (both the same value). It had only `id`, while everything else on the server says `sessionId`; `id` stays so existing filters compile.
- Signatures: `generateDeltas(root): WireOp[]` omits every filtered field. `generateDeltas(root, clients): Map<Client, WireOp[]>` returns per-client ops, and **clients with identical visibility share one array instance**, so core encodes once per distinct array. With no filtered fields, all clients share one array. `encodeSnapshot(root, client?)` includes filtered content only if `client` passes.
- A filter covers the whole subtree under the field: ops for nested instances inside a filtered collection are filtered too. Nested filters compose (all must pass).
- **Filters are evaluated every sync tick** for every registered filtered field × client, so visibility can depend on any state. When a field becomes visible to a client, that client receives its full current value/contents. When it becomes hidden, the client receives the zero value (primitive) or `CLEAR` (collection). Filters must be pure. A filter that throws counts as hidden (logged).
- Core must pass **every connected client on every call**: per-client visibility memory is updated by each call.
- Don't move an instance across a filter boundary (from inside a filtered subtree to outside or back). Clients that never saw it would receive only a reference.
- **[DECIDED] `createServerOnly(wrapped)`** is `createFiltered(wrapped, () => false)` under a name: a field no client ever receives but that is part of the state everywhere else, so `toPlain`/`fromPlain` (hence `saveState`/`loadState`) carry it. A plain class field is neither sent nor saved, and there was no documented home for "saved but never sent". It stays a filter, not a new kind of field, so the class table, codegen and the wire are unchanged: its name is in the class table like any field's, and clients hold its zero value.

### 5.7 Bandwidth Optimization — **[NEW — beyond the old code entirely]**

The old implementation's wire format was never optimized: it re-serialized whole changed values (never diffed inside a collection), used nanoid strings as `refId`, used property name strings as patch keys, and re-sent the schema's class name on every reconstructed instance. None of this was wrong, but all of it was wasteful. This is a ground-up wire-format redesign — nothing here can be copied from the old code.

#### 5.7.1 Numeric `refId`s instead of nanoid strings

A schema instance's `_id` stays an internal nanoid (useful for logging/debugging), but the value put on the wire is a compact, monotonically increasing integer assigned per-room the first time an instance is serialized (`_wireRef: number`). MessagePack encodes small integers in 1 byte vs. ~22 bytes for a nanoid string — this alone is the single biggest win for any state with many entities (NPCs, projectiles, players).

#### 5.7.2 Class handshake instead of repeated class-name strings

On join, the server sends a one-time **schema handshake**: `{ classes: [{ classId: number, name: string, fields: string[] }] }`, listing every `Schema` subclass reachable from the room's state tree, its assigned numeric `classId`, and its field names **in declaration order** (captured automatically from `Object.keys()` when a class is first initialized — no manual indices, keeping the "no decorators" principle). After the handshake, every wire reference to a class or field uses its numeric id, never its name.

**[DECIDED] Amendments** (types in `packages/types/src/wire.ts`):

- Each class entry also carries **`types: SchemaFieldType[]`**, parallel to `fields`. Receivers need it to dequantize fixed-point fields, to allocate collection refIds (§5.7.9) for fields they don't have locally, and to detect type disagreements. **[DECIDED] Grammar** (`packages/types/src/wire.ts`, parsed by `parseFieldType`):

  ```
  field     = primitive | int | "schema<" Name ">"
            | "map<" key "," primitive ">" | "set<" key ">" | "array<" primitive ">"
            | "schemaMap<" key "," Name ">" | "schemaSet<" Name ">" | "schemaArray<" Name ">"
  primitive = "float64" | "float32" | "fixed:" 0-9 | "string" | "bool"
  int       = "int8" | "int16" | "int32" | "uint8" | "uint16" | "uint32"
  key       = "string" | "float64" | int
  Name      = a schemaName: everything up to the final ">" (so it may contain any character)
  ```

  **[DECIDED]** `int` (a `createInt` field, §5.2) is a field type only, never a collection value, so `map<string,uint8>` and `array<int32>` stay invalid. `parseFieldType` returns `{ kind: "int", type }` for it.

  A type string is a plain string in the `DEFINE` op, so the op keeps its shape, and a type disagreement (including a different element type) is a single string comparison that yields `SCHEMA_MISMATCH`. A type string that doesn't parse makes the `DEFINE` `MALFORMED_OP`. Receivers parse each type once per `DEFINE`, never per op.
- **The table is delivered in-band, as `DEFINE` ops**, and grows incrementally. "Reachable from the state tree" can't be computed at join time: the classes inside an empty `createSchemaMap<string, Player>()` are erased types. (**[DECIDED]** Since §5.3's element descriptors, the *declared* element class is known at runtime. But an element may be an instance of any subclass, so the set of classes that will actually appear still can't be enumerated up front, and the incremental design stays.) So class ids are assigned the first time an instance of that class is serialized. A snapshot starts with `DEFINE` ops for the room's entire table so far, and a patch carries an inline `DEFINE` right before the first use of a class new to the room. `DEFINE`s are never filtered. `getSchemaTable(root)` returns the table (as `SchemaTable`) for core/codegen/debugging, but receivers need nothing beyond the op stream.
- Receivers resolve classes **by name** (`SchemaRegistry`) and fields **by name** (server field index → local field of the same name). A server field the client lacks is skipped. A class the client lacks is ignored along with everything under it. A shared field whose type differs is a hard `SCHEMA_MISMATCH` error. Receivers that never construct a class locally (e.g. `Player` only arrives inside a map) must `SchemaRegistry.register(Player)`, because auto-registration happens on first `new`.
  - **[DECIDED] Registration and unknown classes.** `reachableSchemaClasses(root)` (`@bungohan/state`, the same walk as `validateSchemaClass`) lists `root` and every class reachable from it: nested fields, declared collection element classes, and the classes of initial elements. client-js registers these for the `state` class of every join (§7.5), so in practice only an element *subclass* that no declaration names still needs a manual `register`. Skipping a class the receiver lacks remains the protocol rule, but it is no longer silent. `applyDelta(root, ops, { onUnknownClass(name) })` reports each unknown class once per stream (per replica root) when it drops an instance of it, after the frame is applied. client-js makes that loud (§7.5).

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

Every implementation (TS, C#, GDScript, …) must reproduce these rules bit for bit. **[DECIDED]** They are in `PROTOCOL.md` §12, with vectors in `conformance/v1/002-numeric-rules.json` (and every codec vector that carries a fixed-point value).

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

**[DECIDED] Correction: Bun does not self-regulate.** Measured on Bun 1.3.13 by reading the RSV1 bit off raw frames: `perMessageDeflate: true` only *negotiates* the extension, and a frame is compressed only if `ws.send(data, true)` asks for it. Compressing every frame hurts the most common one:

| MessagePack payload | Plain frame | Deflated frame |
|---|---|---|
| 8 B (one position delta) | 10 B | 16 B |
| 43 B | 45 B | 48 B |
| 57 B | 59 B | 61 B |
| 85 B | 87 B | 82 B |
| 125 B (churn tick) | 127 B | 76 B |
| 703 B | 707 B | 468 B |

So `WebSocketTransport` takes `compression` (default `true`: negotiate, and compress eligible frames) plus **`compressionThreshold` (default 128 B)**. Frames below the threshold go out uncompressed. Deflate breaks even at about 60–85 B of MessagePack and saves ~40% by 128 B. Bun showed no context takeover between frames (identical repeated frames compress to the same size). `ServerOptions.transport.config` should pass `compressionThreshold` through when core is built. **[DECIDED]** There is no compression-ratio metric (§5.7.8).

#### 5.7.8 Metrics

Extend `RoomMetrics` (§6.6) with `avgStateDeltaBytes` (already specified) plus **[NEW]** `avgStateSnapshotBytes`, so bandwidth wins from this section are actually observable in production, not just assumed. **[DECIDED]** There is no compression-ratio metric: Bun doesn't expose a frame's deflated size, so it can't be measured through `ITransport`.

#### 5.7.9 Sync semantics — **[DECIDED]** (`packages/state/src/{encoder,decoder}.ts`)

Both peers follow these rules on the same op stream, which is what keeps them in agreement. Conformance vectors should cover each one.

- **refIds.** Assigned per room when an instance is first serialized. The root is always `0`. An instance with refId `R` implicitly owns the block **`R … R+k`: `R+1 … R+k` for its `k` collection fields, in field (declaration) order**. Collections therefore cost zero bytes to announce, and receivers compute the same numbers from the class table's `types`.
- **refId reuse.** When an instance is forgotten (next bullet), its block goes onto a **free list for its class**. A new instance of that class takes the most recently freed block (LIFO); otherwise a fresh block is allocated past the highest id so far. Reuse only within one class, so a block always has exactly the `1 + k` ids that class needs and the `R+1 … R+k` rule never breaks. Receivers need no free list of their own: an id is simply known or unknown to them. Without reuse, a long-running room's ids climb without bound and every reference to them widens (1 → 3 → 5 bytes in MessagePack, more varint bytes in `SchemaCodec`). With reuse, ids stay bounded by the peak number of live instances.
  - **Why reuse is safe:** a block is freed by `clearChangeTrees`, i.e. only after the frame carrying the removal has been generated and sent, so it is first reused in the *next* frame. Delivery is ordered (one WebSocket stream), so every receiver applies the removal frame before the reuse frame. Receivers drop removed instances **at the end of the frame** that removed them. By the time the reuse frame arrives, the id is unknown to every receiver, and its `[classId, refId]` creates a fresh object, exactly like a never-used id. A move (removed and re-attached in the same tick) is never forgotten, so a live block is never freed. Late joiners only ever see live ids. A receiver may still hold an id in its "ignored" set (from a subtree whose class it doesn't know); binding an instance clears stale ignore marks on its block, so a reused id is honored.
- **Full content.** A new instance is sent as the op that places it (with `[classId, refId]`), immediately followed by its content: a `SET` for every primitive field whose wire value is **non-zero** (`0`, `""`, `false` are omitted), a `SET` with the child's ref for each directly nested Schema field, and `ADD`s for every collection element. **Receivers reset every instance they create to type zero values** (including the root on first bind), whatever the local initializers say, because a C#/GDScript client cannot know TypeScript initializer values.
- **Known instances** are referenced by ref only. Their own changes are emitted as ops targeting their refId (§5.7.5).
- **Removal and re-attach.** An instance removed during a tick and not re-attached by the end of that tick is **forgotten** by the server at `clearChangeTrees` (its subtree's refIds are reset) and dropped by receivers at the end of the frame. If it's attached again later, it is sent in full under a newly allocated block (which may be a reused one). Receivers use **holder counts** (how many fields and collection slots reference an instance), so a move within one frame (remove here, add there, in either order) keeps the same client object.
- **[DECIDED] Replacing a nested Schema field** (`holder.bag = new Bag()`) is synchronized. `_ensureInit` turns each nested field into an accessor on the instance (a class field is an own data property, so a prototype setter would never see it), binding it like the wrappers. Assigning it records the field: the next delta has a `SET` with the new instance's ref, then its full content. Receivers keep their own nested object and rebind it, so an instance can't keep its wire identity through a nested field: the new value is always sent as new, even if it was known elsewhere, and the replaced one leaves the wire at once. Its block (and its subtree's) is freed by `clearChangeTrees`, as for a removal, and it is sent in full under a new block if it is attached again. A schema-set `REMOVE` names the refId the element had when first touched that tick. Receivers forget the old block when a nested field is rebound, and release its collections' elements (PROTOCOL.md §11.5). Assigning a non-Schema value is logged and ignored.
- **[DECIDED] Ownership: a nested field owns its instance exclusively; collections may share one.** Receivers keep their own nested object and rebind it (above), so they never adopt an instance into a nested field. If the instance were also held somewhere else, that other holder's client copy would be orphaned on the old refId and silently stop updating, or be rebound under it when the field is replaced, and the server would free a refId it still uses. So:
  - **A nested field's setter refuses** an instance held anywhere else: in a collection, in another nested field (of any instance), or as a room's state (the root, refId 0). It also refuses the owner itself or one of its ancestors, which would make a cycle.
  - **Every collection add path refuses** an instance held by a nested field: map `set`, set `add`, array `push`/`unshift`/`splice`/`set(index, v)`. It also refuses the collection's own owner or an ancestor of it.
  - **A refused call changes nothing.** The field keeps its value. The collection is unchanged: a `push`/`unshift`/`splice` with any refused item inserts and removes nothing, and array `set` returns `false`. Server and clients therefore stay in agreement. It logs a `console.error` naming `Class.field` of both the target and the holder, and saying how to move the instance. It never throws, since these run on per-tick paths (CLAUDE.md, rule 1).
  - **To move an instance, release it first, then place it.** Delete it from every collection holding it before assigning it to a nested field; assign something else to the nested field before adding its old value to a collection. Both steps may happen in the same tick. An instance that passes through a nested field is sent anew under a new block.
  - **Collections may share an instance** among themselves, and a map may hold it under several keys. The server tracks every bound collection holding it (`_holders`). `_parent` is one of them, preferring one on the wire, and change marks go up through every holder. So an update still reaches the room when another holder has just left the tree. The instance is forgotten (its block freed) only when, at the commit, no holder on the wire is left. This includes a holder removed from the tree taking a shared element with it. Receivers already count holders (PROTOCOL.md §11.6).
  - **A nested field's `SET` always introduces an instance new to receivers.** If the value already has a refId when the `SET` is emitted, that identity is dropped (freed by the commit) and the value is sent anew. This happens when an earlier op in the same frame placed it (e.g. an array insert it was removed from again), or when it left a collection this tick and reached the field through a detached holder. Likewise, a set element or map value that passes through a nested field and comes back to the same set or key in the same tick is re-sent: the set sends `REMOVE` of the old refId and an `ADD`, and the map sends an upsert. Before this, coalescing saw "same element, still present" and sent nothing.
  - **Limitation: lazy initialization.** Before an instance is initialized, its collections aren't bound and its nested fields are plain properties, so nothing can be checked at those moments. For example, an element added to a new instance's array and then assigned to a nested field elsewhere (it had no parent yet) gets past both checks, and so does a nested value assigned before init that is held elsewhere. Both are **detected when the instance is initialized** (attached to the tree) and logged with `console.error`, naming both places. They are not refused, because refusing would mean silently editing a collection or field the user already filled. Clients desync once that nested field is replaced. To be checked at assignment time, create the instance with `Schema.create()` (eager init).
  - **Coverage.** The seeded randomized test (`packages/state/src/fuzz.test.ts`) performs these moves, shares and refused attempts, and checks after every sync that replicas equal the server, share objects exactly where it does, and that live server refIds are unique and assigned. Each fix above was checked by reverting it and seeing the fuzz test fail.
  - This is a server-side rule with no wire change.
- **Receiver listeners are deferred** until the whole frame is applied, then fire in op order (an instance's primitive fields precede its collections). An instance **created in this frame fires none of its own listeners**. Its parent collection's `onAdd` sees it fully populated. The root's listeners always fire, including during the snapshot.
- **Errors.** `applyDelta(root, ops): Result<void, StateError>` validates op shapes and value types. It reports `MALFORMED_OP`, `UNKNOWN_REF`, `UNKNOWN_CLASS` or `SCHEMA_MISMATCH`, stopping at the first bad op (earlier ops stay applied). Core/client-js should treat any error as a desync and rejoin. A throwing listener is caught and logged.

#### 5.7.10 Join/sync ordering — **[DECIDED]**

`encodeSnapshot(root, client?)` returns `err(SNAPSHOT_DIRTY)` while changes are pending. Snapshotting assigns refIds, which would make pending new instances look already-sent to existing clients. **Core therefore admits joiners at a sync boundary:** `generateDeltas` → send to existing clients → `clearChangeTrees` → `encodeSnapshot` for each joiner. `generateDeltas` returns `[]` before the first snapshot and on idle ticks; send nothing then. Each `generateDeltas` output must be delivered and followed by `clearChangeTrees` (they form a commit pair).

#### 5.7.11 Known gaps (for the serializer/codegen sessions)

- ~~**Collection element types are erased.**~~ **[DECIDED] Closed.** Collections now take runtime element descriptors (§5.3), and the class table carries them (§5.7.2 grammar), e.g. `map<string,fixed:1>` or `schemaMap<uint32,Player>`. Phase 2 `SchemaCodec` and codegen can read element types straight from the table. Primitive collection elements are also quantized on the wire now (they were sent raw before, which made `createArray` of a lossy type impossible to express).
- ~~`IStateCodec.encodeOps(ops, table)` should maintain its table from the `DEFINE` ops.~~ **[DECIDED] Closed** by the §8.1.5 codec sessions.
- Bandwidth baselines: **[DECIDED]** moved to §11.1, which now measures both codecs side by side (`packages/serializer/src/bandwidth.test.ts`). The MessagePack numbers recorded here before (one position update 8 B, all moving 1,396 B, 10+10 churn 433 B, snapshot 4,032 B, idle 0 B, 30,000-tick churn flat at 138 B/tick) are unchanged.

## 6. `@bungohan/core` — Server, Room, MatchMaker

**[KEEP]** signatures below are exact, verified against the working implementation, except where marked **[NEW]**/**[FIX]**. **[DECIDED]** The wire protocol is specified in §6.7, and what was actually built (including the deviations from the signatures below) is in §6.8.

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
  protected onDisconnect(client: Client): void;      // sync — [DECIDED] a seat is now held (§6.7.5)
  protected onReconnect(client: Client): void;       // sync — [DECIDED] a held seat resumed (§6.7.5)

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

Everything else about clustering (RoomProxy for remote rooms, `PROXY_JOIN/LEAVE/MESSAGE/BROADCAST/DISCONNECT/LOCK/VISIBILITY/PRESENCE_*` backplane message types, `CLIENT_SEND/DISCONNECT` routing) worked correctly in the old code — reproduce as-is. **[DECIDED]** The old code was written against a much older protocol (JSON-Patch state sync, serialized `Client` objects, a read-only state replica on the proxy); what §6.4.1 reproduces is its *vocabulary*, not its mechanism.

#### 6.4.1 Cluster mode as built — **[DECIDED]** (`packages/core/src/cluster/`)

Cluster mode is built, and every path that used to return
`CLUSTER_NOT_IMPLEMENTED` works: `start()` with `cluster.enabled`,
`createRoom` / `joinRoom` / `joinById` / `query` across processes,
`reserve`, and the aggregation above. **`getAllProcesses` is exactly steps
1–4**, with `gatherTimeout` (default 200 ms) as the window and the local
entry added with no round trip.

**The hard constraint held: there is no wire change.** `PROTOCOL.md` is
untouched, the 311 conformance vectors are untouched, and the C# and Godot
runners pass unmodified. A client cannot tell where its room runs, which
`packages/testing/src/cluster/wire.test.ts` checks by comparing the actual
frames of a local seat and a remote one: same frame sequence, same
`roomRef`, same snapshot size, and a one-`SET` patch that is still 6 bytes.
No extra field, no extra frame, no second `roomRef` space.

**Room ownership.** A room lives on exactly one process, and *the seat
lives with the room*. The owning process holds a real `Client` in
`room.clients`: it runs `onAuth`/`onJoin`, counts against `maxClients`, is
passed to `createFiltered` filters, and gets its ops from the room's single
codec session (§8.1.2). Nothing about refIds, the class table or per-client
filtering changes, because nothing about them is per-connection. What
differs is only where its frames go: the `Client` is bound to a
**`RemoteConnection`** (`cluster/remote.ts`), and `RoomHost.sendFrame` /
`broadcastFrame` publish those frames to the process that holds the socket
instead of handing them to a transport. That process relays the bytes
verbatim.

**How the `roomRef` stays right.** `roomRef` is per connection
(PROTOCOL.md §3.1), and the connection belongs to the *edge* process, so
its mapping is the one that goes on the wire. The edge therefore allocates
the `roomRef` from its own connection **before** forwarding the join, and
sends it along; the owner binds the seat with that handle
(`Room._seat(…, ref)` / `_reconnect(…, ref)`). Every frame the owner builds
is then already addressed correctly and needs no rewriting — which is what
keeps a relayed frame byte-identical to a local one. A refused join simply
burns a handle, which is fine: handles are never reused on a connection.

**What crosses the backplane** (`cluster/protocol.ts`, MessagePack over
`IBackplane`, so frame bytes ride as `bin`): one broadcast channel
(`<namespace>:cluster:all`) and one per process
(`<namespace>:cluster:p:<id>`). Messages are heartbeats and goodbyes;
request/reply for process info, room/reservation lookup, "find an available
room", `query`, `createRoom`, `reserve` and the `RoomProxy` operations; the
forwarded `JOIN`; room messages and `LEAVE` from an edge; connection-closed
notices; and, the other way, finished frames and protocol violations. It is
versioned (`CLUSTER_PROTOCOL`), and a message of another version is
dropped, so a rolling deploy degrades to "those processes don't see each
other" rather than to corruption.

**Ordering.** A join reply and the `JOIN_SUCCESS` that follows it are
published by the owner on the same channel, in that order, so the edge has
the seat mapping before the first frame for it arrives. The edge drops a
mapping when it relays a `LEAVE` for that `roomRef` (PROTOCOL.md §5.2: no
frame follows it), which costs one byte to detect and nothing otherwise.

**Routing is local first, always.** A join looks for a room on this process
exactly as before; only when it finds none does it ask the cluster, so an
unclustered server is unchanged and a clustered one pays a lookup only when
it has nothing to offer. `JOIN_OR_CREATE` that loses the race for a remote
room (it filled, locked or vanished) creates one here, as it would locally.
A `FIND` carries the rooms the asking connection already sits in, so
joining the same type twice gives two rooms rather than `ALREADY_JOINED`.
**A process need not define every room type**: if the type is unknown here
but a room of it exists elsewhere, the join is routed there; only when
nothing answers is it `ROOM_TYPE_NOT_DEFINED`. **[DECIDED]** The cluster
lookup is an await between "nothing here" and "create one", so a
find-or-create registers its pending creation *before* asking (§6.8.5), and
concurrent calls on the same process still share one room. Calls on
*different* processes can each create one: preventing that would take a
cluster-wide lock, and it is documented as a limitation instead.

**Process registry and liveness.** Peers are learned from heartbeats, not
from an `IStore`: a store cannot list keys, and store and backplane stay
independent. Each process publishes a heartbeat every
`cluster.heartbeatInterval` (default 2,000 ms) with its room and client
counts, and a `hello` at startup so the first matchmaking call doesn't wait
for one. A peer silent for `cluster.peerTimeout` (default 6,000 ms, three
heartbeats) is dropped, and a graceful `stop()` publishes a goodbye so it
is dropped at once. **Every one of these is a `Clock` timer** (§6.8.2,
`@bungohan/types`), never wall-clock time, so a test advances a process to
its death. `getAllProcesses()` does not read this registry: it asks, and
returns who actually answered, plus this process.

**Failure — a clear error, never a hang.** Every wait is a deadline:
`requestTimeout` (default 5,000 ms) for a directed request, `gatherTimeout`
for a broadcast. A request waiting on a peer that is declared dead fails at
once with `CONNECTION_LOST` rather than waiting out its own timeout; one
that nobody answers is `TIMEOUT`. When a process is lost:

- **Clients elsewhere with seats in its rooms get `LEAVE(roomRef, 4002
  ROOM_DISPOSED)`** — an existing code, so no wire change; from the
  client's side the room simply ended. Their connection stays open and
  their other seats are untouched. A *graceful* stop is better: the rooms
  dispose first, so those clients get `LEAVE(…, 4001 SERVER_SHUTDOWN)`
  before the goodbye.
- **Held seats and unconsumed reservations for its rooms are gone with it.**
  A later lookup finds nothing, so `joinById` is `ROOM_NOT_FOUND`, a
  reconnection token is `INVALID_TOKEN` and a reservation is
  `RESERVATION_NOT_FOUND`, each after one collection window.
- **A matchmaking call in flight** returns `CONNECTION_LOST` (peer declared
  dead) or `TIMEOUT` (no answer), never a pending promise. A forwarded
  join that fails this way reaches the client as a `JOIN_ERROR`.
- **When the process holding the *socket* dies**, the owner sees its
  connections close (by notice, or by the peer deadline) and treats it as
  any unconsented disconnect: the seats are **held** for
  `reconnectionTimeout` and expire on the owner's own clock (§6.7.5).

**Cross-process reservations and reconnection** both work by locating the
owner, because a client may reach any process. A reservation is made and
held where its room is (`reserve` on any process forwards to the owner) and
consumed from anywhere: the consuming process broadcasts a lookup for the
reservation id and forwards the `JOIN`. A reconnection token already names
its room (`<roomId>.<secret>`), so the same lookup resumes a held seat from
a process that has never seen the client. Neither id format changed, and
both are opaque to clients.

**`RoomProxy`** (`cluster/proxy.ts`) is what `createRoom` / `joinRoom` /
`joinById` return for a room elsewhere — a `Room`, so the signatures are
unchanged, with `isRemote` true. It is **control and description, not
simulation**: it forwards `lock`/`unlock`, `makePrivate`/`makePublic`,
`dispose`, `broadcastMessage`, `disconnectClient` (a kick) and the presence
writes; it caches the owner's description (`id`, `roomType`, `metadata`,
the option fields, `getClientCount()`, `getSeatCount()`, `locked`,
`visibility`, `isDisposed`), re-read by `refresh()`; and it refuses, with an
explanation, what needs the process the room runs on — `join`/`leave` (a
`Client` belongs to the process holding its connection) and `onMessage`
(handlers belong to the room class). Presence is read with
`fetchPresence()`, a round trip, rather than a lie from a local map.
Deliberately **no state replica**: the state exists once, on the owner, and
a second copy here would be a second source of truth. `getAllRooms()`,
`getRoom()`, `getRoomCount()` and `getClientCount()` stay local, by
definition.

**New `ServerOptions.cluster` fields:** `namespace` (channel prefix,
default `"bungohan"`, so unrelated clusters and test runs can share one
Redis), `heartbeatInterval`, `peerTimeout`, `requestTimeout`,
`gatherTimeout`. `cluster.enabled` **requires** a backplane
(`backplane.provider` or `backplane.config`); without one, `start()` fails
with `INVALID_OPTIONS` naming both, rather than starting a cluster of one.

**[DECIDED] Backplane messages are MessagePack, not JSON**, encoded with
the **server's own `ISerializer`** (§8.1.4). This is a correctness
requirement, not an optimization. A forwarded join's `options`, a proxied
broadcast's payload and a room message all pass through the backplane, and
JSON silently rewrites exactly the values the wire protocol carries
faithfully: a `Uint8Array` became `{"0":1,"1":2,"2":3}`, `NaN` and
`±Infinity` became `null`, and a `Date` became an ISO string. So the same
game code behaved differently depending on where the room happened to
live, with no error anywhere. Using the serializer that *decoded the value
off the wire in the first place* makes the round trip an identity: a
handler on the owning process receives what a handler on the edge would.
`packages/testing/src/cluster/fidelity.test.ts` joins a local room and a
remote one of the same type with the same options and compares them value
for value, over all four kinds; every case fails if the encoding is put
back to JSON. Frame bytes ride along as MessagePack `bin`, so relaying
costs no base64 either.

**[DECIDED] A cluster's serializer must carry binary, and that is checked
at startup.** Since relayed frames travel *inside* a backplane message, as
a `Uint8Array` property, a custom `ServerOptions.serializer` that flattens
binary breaks frame relay — at runtime, in cluster mode only, with no error
anywhere. The symptom would be that clients whose room happens to live on
another process stop receiving state, which is about the worst way to
learn it. So `ClusterNode.start()` encodes and decodes a short probe
(`00 01 7f 80 c3 a9 ff`, nested in an object, as frames really travel)
through the configured serializer before it subscribes to anything, and
refuses to start if the bytes don't come back identical, naming the
serializer by `getName()` and saying how it failed. It runs **once, on the
`start()` path** — never per tick, per message or per connection — and
reports through `start()`'s existing `Result` (`INVALID_OPTIONS`), beside
the "cluster.enabled needs a backplane" check, rather than throwing: two
adjacent configuration checks in one function should fail the same way.
The probe deliberately covers what a text-oriented serializer gets wrong:
a NUL, the `0x80` boundary, a valid UTF-8 sequence (`c3 a9`) that must not
be folded into one character, and `0xff`, which is not valid UTF-8 at all.
The check is about the guarantee, not about being MessagePack:
`JsonSerializer` wraps a `Uint8Array` rather than flattening it, so it
passes. `packages/testing/src/cluster/serializer.test.ts` covers a
serializer that loses the type, one that mangles the bytes, one that is
neither MessagePack nor broken, and that **nothing fires without cluster
mode** — a single-process server never puts frame bytes inside another
encoding, so its serializer is its own business. That the check isn't
vacuous was verified by bypassing it: a cross-process join then fails.

**Known limitations, deliberately:** a value must be one MessagePack can
carry, so anything that isn't — a `Map`, a `Set`, a class instance — still
arrives as a plain object, and `-0` arrives as `0` (PROTOCOL.md §4). This
is not an asymmetry for anything a *client* sent, which by definition came
through the same serializer; it only bites *untyped* options a server built
itself and handed to `createRoom`/`reserve`. **[DECIDED]** Typed options
(§4.1.2) are immune: they cross the backplane as encoded bytes, and the
owner only decodes them. A `ConnectionContext` carries `ip`,
`searchParams`, `headers`, `token` and `protocol` to the owner's `onAuth`,
but not a custom transport's extra properties. And
`ClientMetrics.avgLatency` is not recorded for a seat whose `PING` lands on
another process (the round trip is measured where the socket is, and
forwarding it would cost a message per ping for a metric that is off by
default).

**Tests** (`packages/testing/src/cluster/`, on `createClusterHarness`:
several real servers in one `bun test` process, each with its own
transport, sharing one `ManualClock` and one backplane bus, §11.2):
matchmaking and `RoomProxy` (`matchmaking.test.ts`), join routing
(`routing.test.ts`), a seat whose socket and room are on different
processes — state, filtering, messages both ways, raw messages, leaving,
kicking, a room disposed remotely (`seat.test.ts`), cross-process
reservations and reconnection (`resume.test.ts`), processes dying and
stopping (`failure.test.ts`), byte-identity with a local seat
(`wire.test.ts`), and the whole thing again over a real `RedisBackplane`
(`redis.integration.test.ts`, with `REDIS_URL`).

#### 6.4.2 Process metadata and draining — **[DECIDED]** (`packages/core/src/{server,matchmaker}.ts`, `cluster/`)

Processes describe themselves, and a process can be **drained** for a
zero-downtime deploy. Both work without cluster mode too (one instance
behind a load balancer during a deploy).

**Process metadata.** `ServerOptions.cluster.metadata` sets it at start,
`server.setProcessMetadata()` replaces it later, `getProcessMetadata()`
reads it. `ProcessInfo.metadata` is now **always present** (default `{}`);
the "reserved" wording is gone. It reaches other processes in the
`pi!` reply that `getAllProcesses()` and every selector read, and in every
heartbeat (below).

- **Size limit: 1,024 bytes encoded** (`MAX_PROCESS_METADATA_BYTES`),
  measured with the server's own `ISerializer`, i.e. exactly what rides in
  the heartbeat. It must be a plain object. Past the limit (or not an
  object, or unencodable): the **static option throws a `TypeError` from
  the constructor** (a definition-time error, §2 / CLAUDE.md rule 1), and
  **the setter returns `INVALID_OPTIONS` and changes nothing**.
  1 KiB is several short fields; at the default 2 s interval it costs a
  peer at most ~0.5 KiB/s per process, and metadata describes a process,
  it doesn't carry data.
- **Stored as the serializer round trip** of the value (encode, then
  decode): a deep copy the caller can't mutate afterwards, and exactly
  what peers see, so the local `ProcessInfo` never differs from a remote
  one.
- **Typing: `Record<string, unknown>`, not a generic.** A generic
  `metadata: M` would have to thread through `ServerOptions`,
  `BungohanServer`, `MatchMaker`, `ProcessInfo` and `ProcessSelector`, and
  would still be a lie: the value comes off a backplane from *other*
  processes, possibly other builds, so nothing checks it against `M`. A
  selector narrows the field it reads (the docs example has a three-line
  `regionOf`), which is honest about where the value came from.
- A setter change (and a drain change) **publishes a heartbeat at once**
  (`ClusterNode.announce()`), so peers don't wait up to an interval.

**Draining is a first-class state, not a metadata key**, so the framework
honours it itself instead of relying on every selector to check.
`server.drain({ timeout? })` → `Promise<Result<DrainResult>>` with
`outcome: "drained" | "timeout" | "cancelled"` and the rooms still held;
`cancelDrain()`; `isDraining()`; `isReady()`; `ProcessInfo.draining`.
`drain()` on a stopped server is `INVALID_STATE`; calling it again while
draining just adds a waiter; a timeout ends *the wait*, not the drain (a
deploy script then calls `stop()`); `stop()` settles pending waiters with
`"drained"` (its rooms are gone). The timeout is a `Clock` timer, so tests
drive it with `ManualClock`. Completion is checked from the host's
`roomDisposed` callback, the one place a room leaves the `RoomManager`.

Semantics:

- **No new rooms on a draining process, ever.** Guarded at every creation
  point: `matchMaker.createRoom` (in cluster mode it places the room
  elsewhere, least loaded; without cluster mode `SERVER_SHUTTING_DOWN`),
  a client's `JOIN_OR_CREATE`/`CREATE`, and the owner side of a peer's
  `create?` and forwarded create (below). `_createAndJoin` checks again
  *after* the static `onAuth` await, because a drain that began, and even
  resolved, during `onAuth` must not be followed by a room it never
  counted.
- **Selectors are offered only non-draining processes**, and are **not
  called at all** when that list is empty (`SERVER_SHUTTING_DOWN`
  instead), so a selector never has to handle an empty array.
- **A client's `JOIN_OR_CREATE` reaching a draining process** that needs a
  new room gets one elsewhere. The edge forwards the join with a new
  `JoinTarget` `{ kind: "create", roomType, createOptions }`; the chosen
  process runs **exactly the local create path** (static `onAuth`,
  `onCreate`, seat, `onJoin`) with the edge's `roomRef`, then sends
  `JOIN_SUCCESS` as for any forwarded join. The alternative, "create a
  room remotely, then forward a `JOIN_BY_ID`", was rejected: it would run
  the *instance* `onAuth` instead of the static one, so a static `onAuth`
  that gates room creation would be bypassed. The candidate list comes
  from the **heartbeat registry** (`ClusterNode.placementCandidates()`:
  non-draining peers, fewest rooms then seats), not a `pi?` gather, so a
  client join doesn't pay a 200 ms collection window. This is what the
  heartbeat's `draining`/`meta` fields are for. A candidate that refuses
  with `SERVER_SHUTTING_DOWN`, `ROOM_TYPE_NOT_DEFINED`, `TIMEOUT` or
  `CONNECTION_LOST` passes the turn to the next; none left is
  `SERVER_SHUTTING_DOWN`.
- **Matchmaking steers away, strictly.** A draining process's rooms are
  skipped by the local lookup (`_findAvailable`, the client routing
  loop), it doesn't answer `find?`, and an owner that began draining
  refuses a matchmaking-mode forwarded join (`ROOM_NOT_FOUND`, the
  existing lost-race code) and a new `reserve?` (`SERVER_SHUTTING_DOWN`;
  `_findOrCreate` now retries on it as on `ROOM_FULL`). "Prefer" was
  read strictly — there is **no fallback into a draining room** when
  nothing else exists: filling its rooms would keep it alive and make the
  drain unbounded. **`query()` leaves out a draining process's rooms by
  default** (a first cut listed them as "informational", but a lobby that
  lists with `query()` and joins by id, like `apps/example-shooter`'s,
  then kept feeding the drain until its timeout). The opt-in is
  `MatchMakerQueryOptions.includeDraining`, and `RoomListingInfo.draining`
  says which listed rooms are draining (always false without the
  opt-in). The filter runs at the **source**: `q?` carries
  `includeDraining`, and a draining process answers with no rooms rather
  than shipping listings the requester would drop. `joinById` is
  unaffected, so a listing opted into is still joinable. The shooter's
  code lookup opts in (a room code is an invite); its public list doesn't.
- **Explicit paths are untouched**: `joinById` (client and matchmaker),
  reconnection, consuming a reservation made before the drain, and
  `RoomProxy` control. `_route` refuses only on `_shuttingDown`, as
  before.
- **No process can take a new room** (single process draining, or every
  process draining): **`SERVER_SHUTTING_DOWN`, reused, no new code.** To
  a client it means the same thing either way — this server won't take
  you now, retry (a load balancer will have sent the retry elsewhere) —
  and client-js treats it as an ordinary join error. PROTOCOL.md §8.1's
  row was reworded to say so; no byte, vector or client changed. A
  JOIN-only (mode 2) with nothing available stays `ROOM_NOT_FOUND`.
- **Races.** A process that starts draining while a create is forwarded to
  it refuses (`SERVER_SHUTTING_DOWN`), and the requester retries
  elsewhere: `matchMaker._place` strikes it off the list it already
  gathered and asks the selector (or picks the least loaded) again, so
  the loop is bounded by the cluster size; the edge's forwarded-create
  loop moves to the next candidate. The owner checks before running any
  room code, so a refusal normally runs no `onAuth`; only a drain that
  begins *during* the owner's static `onAuth` makes the next candidate
  run it a second time. A local client create caught the same way (drain
  begun during its static `onAuth`) is not rerouted: it fails with
  `SERVER_SHUTTING_DOWN`, since rerouting would run that hook twice for a
  join that arrived before the drain.

**Load balancers: readiness.** `GET /ready` (on by default,
`http.enableReadiness`): 200 `{ status: "ready" }` when running and not
draining, 503 with `"draining"` or `"shutting_down"` otherwise. `/health`
stays liveness (200, now with a `draining` field). A draining process
**still accepts connections**: a reconnecting player may need to reach
its held seat, which outside cluster mode can only be on this process.
Readiness is what keeps new players away.

**Drain-first shutdown.** `gracefulShutdown.drainTimeout` (ms, default 0
= today's behaviour): a signal drains for up to that long, then runs the
usual `stop()` → `onShutdown` → exit. The stuck-shutdown timer
(`gracefulShutdown.timeout`) is armed **after** the drain, so it bounds
`stop()` alone. A second signal cuts the drain short (it settles only the
signal's own waiter, not a user's `drain()`).

**Cluster protocol bumped to 2.** Heartbeats carry `draining` and `meta`,
and `JoinTarget` gained `create`, which a version-1 process can't handle.
By §6.4.1's rule a mixed cluster degrades to "those processes don't see
each other"; nothing of version 1 was released, so this costs nothing,
and later rolling deploys between version-2 builds work.

**Limitation, documented:** a `ProcessSelector` sees processes, not the
player. Region placement works when server code places the room with the
player's region in hand (`createRoom`/`reserve` with a region selector);
a client's own `joinOrCreate` creates on the process it reached, and
`joinOrCreate`/`reserve` take any available room before a selector is
consulted.

**Tests:** `packages/testing/src/cluster/drain.test.ts` (metadata reaching
other selectors, static and after runtime updates, and in heartbeats;
draining excluded from selection; `createRoom` and a client's
`joinOrCreate` on a draining process placed elsewhere, with the static
`onAuth` run once on the owner; a refusing candidate skipped; matchmaking
and `reserve` avoiding draining rooms while `joinById`, reconnection and
an earlier reservation work; `drain()` on the last room and on timeout;
every process draining; the three races; `query()` with and without
`includeDraining`), `core/drain.test.ts` (single-process drain, `query()`,
metadata limits, `/ready`, drain-first SIGTERM including the timeout and
a second signal), two cases in `redis.integration.test.ts`, and the
shooter lobby (`apps/example-shooter/server/src/rooms/rooms.test.ts`)
dropping a draining room from its list, single-process and across two
processes, while its code lookup and `joinById` still reach it. Each owner-side draining guard was checked
by disabling it: a race test fails for each.

#### 6.4.3 Application pub/sub — **[DECIDED]** (`packages/core/src/server.ts`, `cluster/`)

An event that reaches one process (a webhook, an admin call) often has to reach all of them, and the cluster already runs pub/sub. `server.publish(channel, message)` / `server.subscribe(channel, handler)` expose it:

- A publish is one `{ t: "app", ch, m }` message on the all-process channel, which every node already subscribes to, so there is no per-channel backplane subscription to manage and an app channel can't collide with the framework's messages. A node that predates the type ignores it. The cluster `namespace` separates clusters as it does for everything else.
- Every process's handlers get it, **the publisher's included**, and so does a server without cluster mode (local only): the same code runs on one process or many. Local delivery is a serializer round trip of the message, queued as a microtask, so every handler everywhere gets a decoded copy and never runs inside `publish()`.
- `publish` returns `INVALID_OPTIONS` if the message can't be encoded, and `INVALID_STATE` in cluster mode before `start()` (a message the peers would silently miss). A handler that throws or rejects goes to `onError` (`source: "callback"`).
- Best effort, per the backplane: no storage, no retry, a process that is down misses it; one publisher's messages arrive in order. The scaling guide says to treat it as a hint to re-read durable data.

#### 6.4.4 Cluster-wide creation locks — **[DECIDED]** (`packages/core/src/cluster/locks.ts`, `node.ts`, `matchmaker.ts`)

A find-or-create that found no room anywhere created one, and two processes doing that at once each created one: the §6.8.5 registry of pending creations was per process. The documented workaround (route a type's matchmaking through one process) had no support. Now the registry's claim also takes a **cluster-wide lock** for its pool, and a claimant looks across the cluster only once it holds it.

- **Pool.** A room type (the same key a client's `JOIN_OR_CREATE` uses), or a type plus a `Placement.key`, or a type plus `where` entries (sorted). Pool names are JSON because they cross the backplane, whose serializer replaces NUL and lone surrogates in raw strings: an early version with NUL separators filed a remote request under a different pool than the coordinator's own, and locked nothing. For the same reason a key with NUL or a lone surrogate is refused (`INVALID_OPTIONS`).
- **Coordinator.** Rendezvous hashing (FNV-1a over `pool + NUL + processId`, highest wins) over this process and its live peers. No election and no extra service; losing a member moves only the pools it coordinated. The coordinator keeps a `LockTable`: one holder per pool, waiters in arrival order.
- **Messages.** `lock?` (directed, answered by `lock!` when granted, possibly much later), `unlock` (fire and forget; also sent to give up a request still queued). A `lock!` for a request that already gave up is answered with `unlock` at once. When this process is the coordinator, it uses its own table directly.
- **Failure.** A lost process's leases end and its waiters leave the queue (`processLost`, from the registry). A waiter whose coordinator is lost asks the new coordinator (up to three times). A lease is taken back after `6 × requestTimeout` (30 s by default), which also bounds a waiter's wait. A waiter that times out creates **without** the lock, and logs why: creating two rooms is better than failing a join.
- **Where it applies.** The matchmaker's `joinOrCreate`/`reserve` (`_findOrCreate`), a keyed `createRoom` (check, then create, under the lock), and a client's `JOIN_OR_CREATE` (`_routeByType`). The cost is one round trip, only on the create path. Placement is unchanged: the claimant still creates the room here or where its selector says, so a client's creating join still runs the static `onAuth` before the room exists.
- **What it doesn't promise.** Processes that disagree about membership (one just joined, one was just dropped) can pick different coordinators for a moment, and then both create. The scaling guide says so, in place of the old limitation.
- **Harness.** A join waiting on a lock isn't in a cluster broadcast window, so `joinRealWait` could spend real time on it; the grant arrives as backplane messages, which keep flowing while the harness waits. Measured with `joinRealWait: 2000` and three processes creating at once, in every order: 2–11 ms of real time, one room.

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

### 6.7 Wire protocol and join handshake — **[DECIDED]**

This is the protocol every client (client-js, Unity, Godot, …) implements. It supersedes the loose descriptions in §4, §4.2 (envelope compaction), §5.5 (join handshake) and §8.1.1 (message-type table). Constants live in `packages/types/src/protocol.ts`; the frame codec in `packages/serializer/src/frame.ts`.

**[DECIDED] `PROTOCOL.md` (repo root) is authoritative for the bytes.** It is written for client authors, stands alone (no references to TypeScript source), and specifies every rule in bytes: connection and version negotiation, frames and varints, every frame body, the join sequence, the compatibility rules, the state op stream and its semantics, the numeric rules, and both codecs. `conformance/v1/` is its executable form (§11.3). This section and §5.7 keep the design rationale; where they describe a byte layout, `PROTOCOL.md` wins, and a wire change is made there first.

#### 6.7.1 Frames

One transport message (one WebSocket binary message) is one frame:

```
frame  = type:u8  header:varint{N(type)}  body:bytes
varint = unsigned LEB128, at most 5 bytes, value ≤ 0xFFFFFFFF
```

`N(type)`, the number of header varints, is fixed per frame type (tables below). The body is the rest of the frame. It is one of:

- **ser**: one value encoded with the connection's `ISerializer` (MessagePack by default; not negotiated, both ends are configured with the same one).
- **codec**: bytes produced by the room's state codec session (§8.1.5), carried as-is. No second encoding layer, no `bin` header.
- **empty**: zero bytes.

Why a binary header instead of the §4.2 MessagePack envelope array: the header costs exactly `1 + Σ varint` bytes (usually 2–3), a state frame's codec bytes aren't wrapped in a MessagePack `bin` (saving 2–3 more bytes per patch), and the header parses the same way in any language, whatever serializer the body uses. A one-SET position patch is **6 bytes** on the wire under the default `schema` codec (2 header + 4 op, §8.1.2), and 9 under `messagepack` (2 + 7), instead of the 12 an array envelope would cost. The §4 string enums stay for readability. Only these numeric ids are sent.

On the server, a frame that doesn't parse is a protocol violation (§6.7.6). A client drops a frame of a type it doesn't know (§6.7.7).

**Client → server** (`ClientFrameType`):

| id | Frame | Header varints | Body |
|---|---|---|---|
| 0 | `ROOM_MESSAGE` | `roomRef`, `messageId` | codec: the contract message, encoded by the room's codec (**[DECIDED]** §8.1.2; was ser) |
| 1 | `ROOM_MESSAGE_RAW` | `roomRef` | ser: `[type: string, payload: any]` |
| 2 | `JOIN` | `requestId` | ser: `[mode, target, options, contractHash, createOptions]` (§6.7.3) |
| 3 | `LEAVE` | `roomRef` | empty |
| 4 | `PING` | `nonce`, `rtt` | empty. `rtt` is the client's last measured round trip in whole ms (sub-ms rounds up to 1), or `0` if it has none yet |

**Server → client** (`ServerFrameType`):

| id | Frame | Header varints | Body |
|---|---|---|---|
| 0 | `ROOM_MESSAGE` | `roomRef`, `messageId` | codec: the contract message |
| 1 | `ROOM_MESSAGE_RAW` | `roomRef` | ser: `[type: string, payload: any]` |
| 2 | `STATE_SNAPSHOT` | `roomRef` | codec: the full-state ops (§5.7.10) |
| 3 | `STATE_PATCH` | `roomRef` | codec: one sync tick's ops |
| 4 | `JOIN_SUCCESS` | `requestId`, `roomRef` | ser: the handshake (§6.7.4) |
| 5 | `JOIN_ERROR` | `requestId` | ser: `[code: string, message: string]` |
| 6 | `CLIENT_JOINED` | `roomRef` | ser: `sessionId` |
| 7 | `CLIENT_LEFT` | `roomRef` | ser: `sessionId` |
| 8 | `LEAVE` | `roomRef`, `code` | empty, or ser: `reason` |
| 9 | `ERROR` | `roomRef` (`0` = the connection) | ser: `[code: string, message: string]` |
| 10 | `PONG` | `nonce` | empty |

- **`roomRef`** is the per-connection room handle (§4.2 envelope compaction). The server assigns it in `JOIN_SUCCESS`, counting up from `1` per connection, and **never reuses one on that connection**. Reuse would let a message the client sent to a room it had just been kicked from reach whichever room took the handle next. A reconnect is a new connection and starts again at `1`. Every frame for a room is scoped by its `roomRef`, so one connection can be in several rooms at once.
- **`messageId`** indexes the room's message tables from the handshake: client→server ids index `clientMessages`, server→client ids index `serverMessages`. The two directions are separate id spaces.
- **Raw messages** (`sendRaw`/`broadcastRaw`/`onMessageRaw`) carry their type name inline and a MessagePack payload with no contract. They are never in the tables.

#### 6.7.2 Sequence

```
client                                        server
  │ ── connect, subprotocol "bungohan.v1" ──▶ │ version check (§6.7.7); else close 1002
  │                                            │ Connection created, server.onConnect
  │ ── JOIN(requestId, [mode, target, …]) ──▶ │ 1. decode + shape check
  │                                            │ 2. contract hash check (before any hook)
  │                                            │ 3. matchmaking: find / create room, take a seat
  │                                            │    (create: static onAuth → room.onCreate)
  │                                            │ 4. instance onAuth (joining an existing room)
  │                                            │ 5. room.onJoin(client, options, auth)
  │ ◀── JOIN_SUCCESS(requestId, roomRef, hs) ─ │ 6. handshake; then any frames onJoin queued
  │ ◀── ROOM_MESSAGE …  (allowed from here) ── │    CLIENT_JOINED → the other members
  │                                            │    server.onJoin
  │ ◀── STATE_SNAPSHOT(roomRef, ops) ──────── │ 7. at the room's next sync boundary
  │ ◀── STATE_PATCH(roomRef, ops) … ───────── │    every later sync tick that changed something
  │ ── ROOM_MESSAGE / PING … ───────────────▶ │
  │ ── LEAVE(roomRef) ──────────────────────▶ │ room.onLeave(client, true)
  │ ◀── LEAVE(roomRef, 1000) ──────────────── │ CLIENT_LEFT → the others; server.onLeave
```

- **The seat is taken before the first `await`** (step 3), so concurrent joins can't overfill a room. A room counts connected clients, clients still joining, clients awaiting reconnection and unconsumed reservations against `maxClients`. A room being created is registered at once, so a concurrent `joinOrCreate` waits for it rather than creating a second one.
- **Auth.** The static `onAuth` runs only when the join creates the room, before `onCreate`. The instance `onAuth` runs only when joining an existing room (including through a reservation). A truthy object becomes `client.auth`, and `true` becomes a copy of the connection's `auth` (`{}` without `ServerOptions.authenticate`, §10.1). Before step 1's matchmaking, a join waits for the connection's `authenticate` to finish, and a refused connection fails every join with `AUTH_FAILED` (§10.1). `false` (or any other falsy value) refuses the join with `AUTH_FAILED`.
- **Frames for a joining client are queued** from the moment it has a seat, and released right after its `JOIN_SUCCESS`. So `send(client, …)` inside `onJoin`, or a `broadcast` during it, reaches the joiner *after* the handshake. If the join fails, the queue is dropped.
- **The snapshot is admitted at a sync boundary** (§5.7.10), not immediately. On its next sync tick the room generates and sends patches to the clients that already have a snapshot, calls `clearChangeTrees`, and then encodes one snapshot per waiting client (`encodeSnapshot(state, client)`, so filtered fields are per client). The wait is at most one sync interval (50 ms at 20 Hz), and it never costs the other clients an extra frame. A client has no state before its snapshot, and gets no `STATE_PATCH` before it. Clients should consider a join complete when the first `STATE_SNAPSHOT` arrives. `ROOM_MESSAGE`s may arrive between `JOIN_SUCCESS` and the snapshot.
- **Every `STATE_SNAPSHOT` starts a fresh stream.** The client discards its replica and codec session and starts new ones, and the snapshot replays the whole class table as `DEFINE`s. Most snapshots follow a `JOIN_SUCCESS` (including a reconnect). A room that *replaces* its state object mid-game also re-sends every client a snapshot at the next boundary, so clients must handle a snapshot at any time, not only after a join.
- **If the connection closes mid-join**, the seat is released with no further hooks if `onJoin` hadn't completed. If it had, the close is handled like any disconnect (§6.7.5).

#### 6.7.3 `JOIN` request

Body: `[mode: uint, target: string, options: any, contractHash: string | null, createOptions: bin | null]`. Elements after these five are ignored (§6.7.7). **[DECIDED]** `createOptions` and the typed form of `options` are §4.1.2 (bytes in PROTOCOL.md §6.2.1).

| mode | Name | `target` | Behavior |
|---|---|---|---|
| 0 | `JOIN_OR_CREATE` | room type | join the first available public room of the type, else create one |
| 1 | `CREATE` | room type | always create |
| 2 | `JOIN` | room type | join an available public room; `ROOM_NOT_FOUND` if none |
| 3 | `JOIN_BY_ID` | room id | join that room (private rooms included) |
| 4 | `RECONNECT` | reconnection token | resume a held seat (§6.7.5); `options` is ignored |
| 5 | `CONSUME_RESERVATION` | reservation id | take a reserved seat; `options` are the reservation's |

"Available" means public, unlocked, not full and not being disposed.

For a room type without typed options, `options` is passed to `onCreate`/`onAuth`/`onJoin` as-is (`null` → `{}`); with them, the hooks get what decoding produced (§4.1.2). **`contractHash`** is the hash of the client's contract (§6.7.4). When it is a string that differs from the room type's, the join fails with `CONTRACT_MISMATCH` before any hook runs, and before a room is created. `null` skips the check, which is for raw-only clients and debugging tools. The check is strict: any change to any message of the contract changes the hash. That is what Phase 1's strict positional arrays need (§8.1.1: "version skew is caught at join by the contract hash"). Per-message compatibility (an old client staying compatible after the server *adds* a message) would be a later, additive change. The handshake already resolves ids by name, so the wire allows it.

`requestId` is echoed in `JOIN_SUCCESS`/`JOIN_ERROR`, so a client can run several joins concurrently. It should be unique among a connection's in-flight joins.

#### 6.7.4 `JOIN_SUCCESS` handshake

Header: `requestId`, `roomRef`. Body:

```
[roomId: string, roomType: string, sessionId: string, reconnectionToken: string | null,
 contractHash: string, stateCodec: string, clientMessages: string[], serverMessages: string[]]
```

- **`sessionId`** identifies the seat. It is stable across reconnection, and is the id other clients see in `CLIENT_JOINED`/`CLIENT_LEFT`.
- **`reconnectionToken`** is an opaque secret, or `null` when the room doesn't allow reconnection. It is **replaced on every successful (re)join**, and the old one stops working.
- **`stateCodec`** names the room's `IStateCodec`: **[DECIDED]** `"schema"` by default, or `"messagepack"`. It selects the encoding of the room's state frames **and** its contract messages, in both directions, so a room has one codec, not two (§8.1.2). A client that has no decoder for it must `LEAVE` and fail the join locally (`CODEC_MISMATCH`). The server never falls back to another codec.
- **`clientMessages` / `serverMessages`** are the message-type tables (§8.1.1): message names in the contract's key order, and a message's id is its index. Clients resolve ids **by name** at runtime and never bake them in (§4.2). A received `ROOM_MESSAGE` whose id the client can't map is dropped (and logged).
- **`contractHash`** is the room type's contract hash, even for a room with `EmptyContract`. A client that sent `null` can still compare it.

**Contract hash** (`contractHash(contract)` in `@bungohan/types`): FNV-1a 32-bit over the UTF-8 bytes of the canonical layout string, as 8 lowercase hex digits. The layout string is built like this (`messageLayout`, `contractLayout`):

```
contract = "client{" messages "}server{" messages "}"      messages sorted by name (UTF-16 code unit order), joined by ";"
message  = name "(" field ("," field)* ")"                 fields in declaration (wire) order; "()" if none
field    = fieldName ":" type
           [ "options{" [ "create:" message ] [ ";" ] [ "join:" message ] "}" ]   only when options are declared (§4.1.2)
type     = "int8" | "int16" | "int32" | "uint8" | "uint16" | "uint32" | "float32" | "float64"
         | "string" | "bool" | "fixed:" digit
         | "enum[" value ("|" value)* "]"                  value: JSON.stringify of the literal
         | "array<" type ">" | "map<" type ">" | "optional<" type ">" | "nested<" message ">"
```

Only TypeScript computes hashes (the server, and `@bungohan/codegen`, which bakes the client's hash into generated bindings). Other clients just compare strings, so the canonical form never needs porting. Sorting by name makes the hash independent of key order. Ids *do* follow key order, which is fine, because they are resolved by name.

#### 6.7.5 Leaving, reconnection and reservations

- **Consented leave.** The client sends `LEAVE(roomRef)`. The server releases the seat: `onLeave(client, true)`, `LEAVE(roomRef, 1000)` to that client (an acknowledgement; no frame for that `roomRef` follows it), `CLIENT_LEFT` to the others, `server.onLeave`. The client may treat itself as having left as soon as it sends the frame.
- **Server-initiated leave.** `room.disconnectClient(client, code = 4000, reason?)` (kick) or `room.leave(client, consented)` send `LEAVE(roomRef, code[, reason])`, release the seat and call `onLeave`. It removes the client from **this room only**, not from the connection. Closing the whole connection is `transport.disconnect`. Codes (`LeaveCode`): `1000 CONSENTED`, `4000 KICKED`, `4001 SERVER_SHUTDOWN`, **`4002 ROOM_DISPOSED` [new]**.
- **Unconsented disconnect** (the transport closed). If the room has `allowReconnection` and `reconnectionTimeout > 0` (seconds), and the server isn't shutting down, the seat is **held**. The `Client` stays in `room.clients` with `client.connected === false`, frames addressed to it are dropped, and it is left out of state sync. `onLeave` is deferred. Otherwise the seat is released at once with `onLeave(client, false)` and `CLIENT_LEFT`.
  - When the last *connected* client of a room with held seats drops, the room **pauses** (`onPause`): both loops stop. The first reconnect **resumes** it (`onResume`), before the reconnected client is admitted.
  - **[DECIDED] A new join resumes a paused room too**, when the joiner becomes joined (right after its `JOIN_SUCCESS`). Before this fix, only reconnects, holds and releases re-evaluated the pause. A newcomer to a paused room got no snapshot (its join hung, or timed out) until a held seat expired and its release resumed the room. A connectionless `room.join()` (bot) doesn't count as connected, so it doesn't resume one.
  - **[DECIDED] `onDisconnect(client)`** runs when a seat becomes held (`client.connected` is now false), before the room possibly pauses. It's where a game stops what the player was doing, e.g. drops their last input, which would otherwise keep running during the grace period. **`onReconnect(client)`** runs when a held seat is resumed, right after its `JOIN_SUCCESS` (and after `onResume`, if the room was paused), so what it sends reaches the client after the handshake, like `onJoin`'s messages. A drop that releases the seat at once (no reconnection) gets `onLeave(client, false)` only, and a held seat that expires gets `onLeave(client, false)` with no `onReconnect`. Both hooks are synchronous and caught like every hook (`source: "onDisconnect"` / `"onReconnect"`).
  - When the timeout expires, the seat is released: `onLeave(client, false)`, `CLIENT_LEFT`, `server.onLeave`.
- **Reconnect.** `JOIN` with mode `RECONNECT` and the token as `target`. It fails with `INVALID_TOKEN` if the token is unknown, or its seat is no longer held (expired, or already reconnected). On success, the *same* `Client` (same `sessionId`) is bound to the new connection with a new `roomRef` and a new token. No `onAuth`/`onJoin` runs. `JOIN_SUCCESS` follows, and a **full `STATE_SNAPSHOT` at the next sync boundary, always**. Nothing is replayed: messages sent while it was away are lost, and the snapshot restores state. `CLIENT_JOINED` is not re-sent, because the seat never left.
- **Reservations.** `matchMaker.reserve(type, options)` finds or creates a room and holds a seat under a pre-assigned `sessionId` until `expiresAt` (default 60 s; the server's clock). `JOIN` with mode `CONSUME_RESERVATION` consumes it. The instance `onAuth` and `onJoin` run with the reservation's options. An expired reservation frees its seat and may auto-dispose an empty room.

#### 6.7.6 Errors a client can receive

`JOIN_ERROR` codes (string, the join failed and nothing about it remains on the server):

| Code | When |
|---|---|
| `INVALID_OPTIONS` | the `JOIN` body has the wrong shape, or an unknown `mode` |
| `SERVER_SHUTTING_DOWN` | the server has begun graceful shutdown **[new]** |
| `ROOM_TYPE_NOT_DEFINED` | no room type of that name (modes 0–2) |
| `CONTRACT_MISMATCH` | the client's `contractHash` differs from the room type's **[new]** |
| `ROOM_NOT_FOUND` | mode 2: no available room; mode 3: no such room, or it is being disposed |
| `ROOM_LOCKED` | mode 3: the room is locked |
| `ROOM_FULL` | mode 3: the room is at `maxClients` |
| `ALREADY_JOINED` | this connection already has a seat in that room **[new]** |
| `AUTH_FAILED` | `onAuth` (static or instance) returned a falsy value |
| `JOIN_FAILED` | `onAuth`, `onCreate` or `onJoin` threw. The error goes to `server.onError`, and the client gets no details **[new]** |
| `INVALID_TOKEN` | mode 4: unknown token, or the seat is no longer held |
| `RESERVATION_NOT_FOUND` / `RESERVATION_EXPIRED` | mode 5 |

**Protocol violations** close the connection. The server sends `ERROR(0, ["INVALID_MESSAGE", why])`, then closes it with `1008 POLICY_VIOLATION`, and logs the reason. They are: an unparseable frame, an unknown frame type, a body the serializer can't decode, a `JOIN` whose body isn't an array, a `ROOM_MESSAGE` with a `messageId` outside the room's table, and a contract payload the room's codec rejects (§4.1: malformed frames never reach a handler). A `ROOM_MESSAGE`/`LEAVE` for a `roomRef` the connection doesn't hold is **dropped silently**, not a violation: it can legitimately race a kick. A well-formed message with no registered handler is dropped with a server-side warning (a server bug, not the client's).

Other close codes: `1001 GOING_AWAY` when the server shuts down (after every room has sent `LEAVE(…, 4001)`), and `1002 PROTOCOL_ERROR` for a rejected protocol version (§6.7.7).

`PING(nonce, rtt)` is answered at once with `PONG(nonce)`. The client measures the round trip. The server records the reported `rtt` into `ClientMetrics.avgLatency` (when metrics are on) for every seat of that connection. It's metrics only, and never trusted for game logic.

#### 6.7.7 Forward compatibility and versioning — **[DECIDED]**

No client has shipped yet, so these rules are in the protocol from v1. They let the server or clients evolve without breaking the other side, and give a clean break when that's impossible.

**1. Array bodies: receivers ignore trailing elements they don't know.** This applies to the `JOIN` body, the `JOIN_SUCCESS` handshake, `JOIN_ERROR`, `ERROR`, and raw messages (`[type, payload]`) in both directions. A receiver reads the elements it knows by position, requires only those (fewer is malformed, as before), and ignores the rest. So a later version may **append** fields but never reorder or remove them. A v2 `JOIN` may carry a fifth element that a v1 server skips, and a v2 handshake a ninth element that a v1 client skips. The server's `parseJoin` accepts `length >= 2` (mode and target are required; options and hash default to `{}` and `null`).

- **Contract payloads are deliberately excluded.** A `ROOM_MESSAGE`'s packed payload stays strict (§8.1.1): an extra field is a violation. Version skew there is caught up front by the contract hash (§6.7.3), not tolerated field by field.

**2. Unknown server frame types are dropped by clients, not fatal.** A newer server may send a frame type an older client predates. The client can't know that type's header layout, but a frame is exactly one transport message, so it skips the whole frame, logs it, and carries on. The same applies to a `ROOM_MESSAGE` whose `messageId` the client can't map (§6.7.4). The rule is asymmetric: **the server still treats an unknown client frame type as a protocol violation** (`ERROR` then close 1008). The server is always at least as new as the protocol it accepts (point 3), so an unknown type from a client means a broken client, not a newer one.

**3. The protocol version is the WebSocket subprotocol**, currently **`bungohan.v1`** (`PROTOCOL_VERSION` in `@bungohan/types`). It is negotiated in the opening handshake, **before any frame is parsed**, so it keeps working even if a later version changes the frame format itself.

- **Client:** offers it as a subprotocol: `new WebSocket(url, ["bungohan.v1"])`. Godot's `WebSocketPeer.supported_protocols` and most C# WebSocket libraries support this. A client that supports several versions offers them all, in its preferred order.
- **Server:** picks the first version on its own accepted list that the client offered, and answers with it (`Sec-WebSocket-Protocol`). The accepted connection exposes it as `ConnectionContext.protocol`.
- **Mismatch:** the connection is closed with **`1002 PROTOCOL_ERROR`** and a readable reason naming what the server expects. The reason is either `unsupported protocol bungohan.v0; expected bungohan.v1` or `no protocol version offered; expected bungohan.v1` (clipped to the 123-byte close-reason limit).
  - To make that reason visible to every client, the transport **completes the upgrade, echoing the client's own first offer, then closes at once**. It doesn't answer with an HTTP error, because browsers (and Bun's client) surface a refused upgrade only as "Expected 101", with no status and no body (measured on Bun 1.3.13).
  - A rejected connection never reaches `onConnection`, `server.onConnect`, or the frame parser.
- **`ITransport.acceptProtocols(protocols)`** is the seam. **[DECIDED]** It is **required**, not optional: a transport must set `ConnectionContext.protocol` to the negotiated version on every connection it accepts, because core rejects any connection without one. Making it optional only let a custom transport compile and then admit nobody. `packages/transport/src/transport.test-d.ts` proves that an object or class missing it is a compile error. Core calls it with `[PROTOCOL_VERSION]` in `start()`. `WebSocketTransport` checks the protocol at upgrade, and `LoopbackTransport` at `connect({ protocols })`, which is `[PROTOCOL_VERSION]` by default in the test harness. Both share `negotiateProtocol` (`@bungohan/transport`).
  - **Core checks again in its connection handler.** A connection whose `context.protocol` isn't an accepted version is closed with 1002 before anything else. So a transport that negotiates badly can't let an unversioned client through; it just can't accept anyone. A custom `ITransport` must negotiate the subprotocol and report it, and the required `acceptProtocols` makes that part of the interface.
- **Bump the version only for a breaking change**, meaning one that rules 1 and 2 can't absorb (a new frame layout, changed element meaning). A server that wants to keep old clients during a migration accepts several versions and branches on `context.protocol`.

### 6.8 Core, single-process — **[DECIDED]** (`packages/core`)

This is how §6.1–6.3, §6.5 and §6.6 were built. **[DECIDED]** Cluster mode (§6.4) is built too; §6.4.1 is how, and what stays local below describes a server without it.

#### 6.8.1 Clients, connections, rooms

- **`Client` is a seat in one room, not a connection.** It has a stable `sessionId` (and `id`, the same value, which is what `createFiltered` filters receive), `auth` (what `onAuth` returned), a free `userData` slot, `status` (`joining` / `joined` / `reconnecting` / `left`), `connected`, `room` and `connection`. The same object survives a reconnection, so game code keyed by `client.sessionId` keeps working. A **`Connection`** is one transport connection (`id`, `context`, `connectedAt`, `getClients()`). It can hold seats in several rooms. **Deviation:** `server.onConnect` receives the `Connection`, since no seat exists yet when a connection opens. `onJoin`/`onLeave` receive the `Client`.
- **Room classes take no constructor arguments.** The server wires a room up after `new` (`_setup`). This lets `defineRoomType` construct a *probe* instance to find the state class for validation, and makes `new MyRoom()` safe in unit tests: a room no server set up has a detached host that logs and drops, and never throws.
- **The contract travels as `static contract`**, because a TypeScript type parameter doesn't exist at runtime. `defineRoomType` enforces it at compile time. A room typed `Room<S, C>` must declare `public static override contract = c` with `typeof c` equal to `C`, or the `defineRoomType` call is a type error (`RoomClass<R>`, proven in `room.test-d.ts`). A room without a contract declares nothing.
- **`state`** is assigned as a field initializer or in `onCreate`. A room with no state still completes joins with an empty `STATE_SNAPSHOT`. **Replacing** `this.state` later is supported: at the next sync boundary the room validates the new class, starts a new codec session, and re-sends every client a full snapshot (§6.7.2).
- **Deviations from the §6.2 signatures**, to satisfy CLAUDE.md rule 1:
  - `loadState(): Promise<Result<TState | undefined, BungohanError>>`, and `saveState(state = this.state): Promise<Result<void, BungohanError>>`. The key comes from an overridable `protected stateKey()` (default `room:<type>:<id>:state`). **[DECIDED]** Room ids stay random and are never reissued or chosen by the caller (a caller-chosen id would have to be unique across a cluster, and a private room's id is its only protection). So persistence survives a restart only under a domain key (`stateKey()` overridden), with the app re-creating the rooms at startup (`matchMaker.createRoom`) and players joining as new seats. The rooms guide says so; there is no "rehydrate on `joinById`" path. Values are stored as `toPlain`/`fromPlain` data (`@bungohan/state`): a JSON tree with `"$class"` on every schema object, full-precision primitives, maps as `[key, value][]`. A room without a store gets `ok(undefined)`.
  - `start()`/`stop()` return `Result<void, BungohanError>`.
  - `send`/`broadcast`/`sendRaw`/`broadcastRaw` stay `void`, as typed in §4.1. A payload that got past the types, or a name not in the contract, goes to `server.onError` (`source: "send"`).
- **[DECIDED] Typed options** (§4.1.2) change the hook parameter types above: `onCreate(options: RoomOnCreateOptions & InferCreateOptions<C>)`, `onAuth`/`onJoin(…, options: InferJoinOptions<C>, …)`, and `room.join(client, options?: InferJoinOptions<C>)`, all untyped (`Record<string, unknown>`) for a contract that declares no options. The matchmaker's `createRoom`/`joinOrCreate`/`reserve` also take the room class.
- **Other room API decisions:**
  - `disconnectClient(client, code = 4000, reason?)` removes the client from *this room* (`LEAVE` frame). It does not close the connection.
  - `join(client, options)` seats a connectionless client (bots, tests) through the instance `onAuth` and `onJoin`. `leave(client, consented = true)` sends `LEAVE(1000 | 4000)`.
  - Additions: `dispose()` (sends `LEAVE(4002)`), `getSeatCount()` (clients plus open reservations), `isAvailable()`, and `protected get clock()`, the server's clock, for game timers that tests can drive.
  - `clients` includes joining and held seats.
- **Hooks never crash a room.** Every hook, message handler (sync throw or rejected promise) and server callback is caught and routed to `server.onError(error, context)`. The context is `{ source, room?, client?, connection?, messageType? }`, where `source` is one of the hook names, `"send"`, `"sync"`, `"transport"`, `"protocol"` or `"callback"`. Without an `onError` callback, errors are logged. Handlers are not awaited, so a slow async handler doesn't block the next message. The flip side is that async handlers can finish out of order, even for one client. **[DECIDED]** Code that needs ordering across an `await` uses the room's serial queue: `onMessage(type, handler, { serial: true })` (and `onMessageRaw`) queues the handler, and `protected serial(task)` queues anything else, a timer callback for instance. One queue per room, one task at a time, in the order queued; a throw is reported (`source: "onMessage"` with the message type, or the new `"serial"`) and the queue carries on; the returned promise never rejects. Tasks not yet started when the room begins disposing are dropped. A running one isn't interrupted, and disposal doesn't wait for it: waiting would deadlock a task that awaits `dispose()`. Handlers without the option are unchanged and cost nothing extra. `onJoin` throwing → `JOIN_FAILED`, with the seat released and no `onLeave` (the join never completed). `onLeave` throwing still releases the seat. `server.onJoin` does not fire on a reconnect (the seat never left). **[DECIDED]** A reconnect runs the room's `onReconnect` instead (§6.7.5).
- **`autoDispose`** fires when the last seat *and* the last reservation are gone. A room created by `matchMaker.createRoom` that nobody ever joins lives until disposed, as before.

#### 6.8.2 Loops and time

- **`ServerOptions.clock`** (default `SystemClock`: `performance.timeOrigin + performance.now()`, with sub-ms precision so tick durations mean something) drives everything. **[DECIDED]** `Clock`, `TimerId` and `SystemClock` live in `@bungohan/types` (`packages/types/src/clock.ts`, browser-safe), because client-js needs the same seam and must not import core. Core imports them from there and re-exports them for convenience. Nothing else in core reads wall-clock time. `BungohanError` takes its `timestamp` as a constructor argument, `(code, message, timestamp, context?)`, supplied from the clock.
- **Simulation**: `SimulationLoop`, a fixed timestep with an accumulator. A timer wakes it about once per step, and each wake adds the real elapsed time and runs as many whole steps as fit, each `onTick(stepMs)`. A wake runs at most **`simulation.maxCatchUpSteps` (default 5)** steps, and any backlog beyond that is dropped (counted in `RoomMetrics.droppedSimulationMs`), so one slow tick can't snowball into ever-longer catch-ups. A 1e-6 ms tolerance keeps float error in timer due times from skipping or doubling a step.
- **Sync**: `IntervalLoop` at `sync.tickRate` (default 20 Hz), independent of the simulation rate. `setSimulationTickRate`/`setStateSyncTickRate` restart the corresponding loop.
- **[DECIDED] Per-room rates work from `onCreate`.** The loops are built after `onCreate` returns, so the setters used to hit `undefined` and silently do nothing there, where a room would naturally configure itself. The room now keeps the requested rate and builds its loops with it (else the server's `simulation.tickRate` / `sync.tickRate`). A rate that isn't finite and positive is ignored.
- A paused room (§6.7.5) stops both loops.

#### 6.8.3 Sync boundary

Each sync tick runs this sequence: `onBeforeSync` → adopt a replaced state → `generateDeltas(state, clientsWithSnapshots)` → group clients by the returned op array (clients with identical visibility share one array, §5.6) → **encode each distinct array once** with the room's single codec session → group again by `roomRef` (in practice every client uses `1`) → one frame per group through `transport.broadcast` → `clearChangeTrees` → one snapshot per waiting client. An idle tick sends nothing. A single position update is **6 bytes on the wire** (2-byte header, then the 4-byte `schema` op), asserted byte for byte in `packages/testing/src/core/sync.test.ts`; 9 under `messagepack`. Clients awaiting reconnection are left out of `generateDeltas`. Their snapshot on return resets their filter-visibility memory.

#### 6.8.4 Startup validation

`defineRoomType` (and `matchMaker.registerRoomType`) validates, then **throws one `TypeError` listing every problem**. This is the definition-time exception of CLAUDE.md rule 1. It checks:

- the contract, with `validateContract` (`@bungohan/types`): every entry is a message whose name equals its key, field names are identifiers, fixed decimals are 0–9, enums are non-empty, distinct and made of strings or finite numbers, there is no optional-in-optional, **[DECIDED]** no array or map holds messages that encode to zero bytes (§8.1.2), and nested messages are well formed;
- the state, with `validateSchemaClass` (`@bungohan/state`): every Schema class reachable from the probe's state (nested fields, declared collection element classes, and the classes of initial elements) has its own `schemaName`, and no two reachable classes share one. It also checks every collection descriptor. It runs once per class. A constructor that throws is reported, not propagated;
- a duplicate room type name.

A state first assigned in `onCreate` isn't visible to the probe. It is validated when the room is created, and a failure is a `Result` error (the join gets `JOIN_FAILED`), never a throw. Either way, **the state package's log-and-skip path never fires for a registered room**. Only an element *subclass* first seen mid-game can still reach it, because subclasses can't be enumerated up front.

#### 6.8.5 Server, matchmaker, errors

- **New `ServerOptions`:** `clock`, `stateCodec` (§8.1.4), `simulation.maxCatchUpSteps`, `transport.config.compressionThreshold` (passed through to `WebSocketTransport`), and `gracefulShutdown.handleSignals` (default true; the test harness turns it off). The **default port is 6060**, not alpha 1's 6000, which browsers refuse to connect to (Chrome's restricted-ports list). A store is used only if `store.provider` or `store.config` (→ `RedisStore`) is given, and one the server created is closed on `stop()`.
- **Graceful shutdown.** `stop()` refuses new joins (`SERVER_SHUTTING_DOWN`), disposes every room (`LEAVE(4001)`, then `onLeave(client, false)`, then `onDispose`), and closes the transport (1001) and the HTTP server. On SIGTERM/SIGINT the server runs `stop()`, then `onShutdown`, then `process.exit(0)`, or `exit(1)` if that takes longer than `gracefulShutdown.timeout` (default 30 s). The handlers are installed by `start()` and removed by `stop()`.
- **Without cluster mode** (`cluster.enabled` unset, the default), `getAllProcesses()` returns this process only and a `ProcessSelector` is called with that one-element list: picking this process works, and picking any other returns `CLUSTER_NOT_IMPLEMENTED`, which is now what that code means — "there is no cluster to route to", not "unfinished". With cluster mode on, both are real (§6.4.1). `start()` with `cluster.enabled` and no backplane fails with `INVALID_OPTIONS`.
- **`DefineRoomOptions`** defaults: `maxClients` unlimited, `autoDispose` true, `allowReconnection` true, `reconnectionTimeout` 30 s, `visibility` public, `locked` false. There is a new `reservationTimeout` (60 s). An expired reservation is remembered for one more timeout, so a late client hears `RESERVATION_EXPIRED` rather than `RESERVATION_NOT_FOUND`.
- **[DECIDED] Concurrent find-or-create** (§6.7.2, `MatchMaker._creation` / `_claimCreation`). The room is registered at once, but alpha 2 still created duplicates, because each path had an await between "no available room" and "create one": the matchmaker's `joinOrCreate` awaited `joinRoom`, and a client's `JOIN_OR_CREATE` awaited the static `onAuth` (and, clustered, the cluster lookup). Now the matchmaker keeps one registry of pending creations per room type, shared by `joinOrCreate`, `reserve` and a client's `JOIN_OR_CREATE`. A call that finds no room registers itself synchronously, before its first await, and releases once the room is ready (or wasn't created). A call that sees a pending creation waits for it and looks again, so it joins that room. If the room failed to create, or filled up before this call took a seat (a `reserve` checks after readiness, a client join sees the creator's seat), the next look finds nothing and this call creates its own. A `JOIN_OR_CREATE` that finds a room still being created by some other path (`createRoom`, mode `CREATE`) likewise waits for it before taking a seat, rather than failing with it. `packages/testing/src/core/concurrency.test.ts` covers each path, their mix, filling up and failing; `cluster/routing.test.ts` the clustered case.
- **[DECIDED] `server.getPort()`** returns the port the transport is listening on (`undefined` before `start()`, after `stop()`, and for a transport without ports), so a server started with port `0` can say which one it got. It reads the new optional `ITransport.getPort?()`, which `WebSocketTransport` implements.
- **[DECIDED] `Placement`: `where` pools and keyed rooms.** Server-side `joinOrCreate`, `reserve`, `createRoom` and `joinRoom` take `ProcessSelector | Placement` where they took a selector (`{ process, where, key }`; a bare selector still works). `where` matches metadata entries with `===` (values `string | number | boolean | null`) and is applied to a room created for the call, **after** the create options' `metadata`, so the room matches; one room type then serves pools configured at run time. `key` names at most one room of the type across the cluster: found whether or not it's available (a full or locked keyed room is `ROOM_FULL`/`ROOM_LOCKED` from `reserve`, never a second room; `reserve` takes its seat by `joinById`'s rules, private included), found on a draining process too, and `createRoom` with a taken key is the new `ROOM_EXISTS`. `Room.key` is fixed at creation (`RoomPlacement`, passed through `RoomManager._create` and the backplane's `create?`) and appears in `RoomInfo`, `RoomProxy` and `RoomListingInfo`. The backplane's `find?` carries `where`/`key`. Concurrency is §6.4.4. Clients get neither: that would be a new JOIN mode on the wire, and which pool or room a player may enter is the server's decision (a lobby reserves). This leaves the decision that room ids are never chosen by the caller intact: a key is not an id, and clients still reach a private keyed room only through its id.
- **[DECIDED] `matchMaker.reserveById(roomId, joinOptions?)`** holds a seat in one chosen room, for server code that picked it (with `query`) and must not race other players for the last seat, as sending the client the id would. It finds the room as `joinById` does, on any process (`RoomProxy`), and takes the seat with `joinById`'s rules (`Room._acceptsNewSeat`, shared with `_seat`): private rooms are fine, `ROOM_LOCKED`, `ROOM_FULL`, `ROOM_NOT_FOUND` otherwise. Like `joinById` it isn't matchmaking, so it also works on a draining process: the backplane's `reserve?` carries `byId: true`, which skips the owner's draining refusal. Join options are untyped here (a room id can't carry its class's contract to the compiler) and are converted where the room runs.
- **`matchMaker.query`** returns ready, undisposed rooms of the type. It skips private rooms unless `includePrivate: true` (new). `removeRoom(id)` disposes the room.
- **`ErrorCode`** = the §6.5 codes, plus the §6.7.6 join codes, plus `ROOM_CREATE_FAILED`, `STORE_FAILED`, `CLUSTER_NOT_IMPLEMENTED` and `INVALID_STATE`.
- **`getMatchMaker()`** throws if no server exists, as §6.3 says. This is a setup error.

#### 6.8.6 Metrics and HTTP

- **Off by default and free when off.** With metrics disabled there is no `MetricsCollector`, and rooms and clients hold no stats objects. Every recording site is an optional call on `undefined`, so nothing is counted or allocated. The getters return `METRICS_DISABLED`.
- `ServerMetrics`: uptime, connections, rooms, messages, bytes in/out, errors, memory. `RoomMetrics`: messages, sync count, simulation ticks, average tick/sync duration, `avgStateDeltaBytes`, `avgStateSnapshotBytes`, `droppedSimulationMs`, **[DECIDED]** `syncPauses` (§6.9). `ClientMetrics`: frames and bytes each way, `avgLatency` (the mean of the `rtt` values reported in `PING`, §6.7.6), `lastMessageAt`. There is no compression-ratio metric (§5.7.8).
- **HTTP** (`http.enabled`): a separate `Bun.serve` with `GET /health`, `/metrics` (404 when metrics are off) and `/rooms`, each switchable, plus CORS. **[DECIDED]** The bodies are typed and exported from core (`HealthResponse`, `ReadyResponse`, `MetricsResponse` = `{ server: ServerMetrics, rooms: RoomMetricsEntry[] }`, `RoomsResponseEntry`), since a reader in another process otherwise guesses `/metrics` is a bare `ServerMetrics`. **[DECIDED]** `http.fetch` (`HttpFallback`) serves the app's own routes on the same port: built-in endpoints answer first, then the fallback gets every other request (`OPTIONS` included), and `undefined` falls through to the built-in preflight/404. Its responses are sent as returned (no CORS headers added); a throw answers 500 and is reported with `source: "http"`. **[DECIDED]** A private room can be joined by id (`JOIN_BY_ID`), so its id is what keeps it private, and nothing unauthenticated may reveal it: `/rooms` lists public rooms only, and `/metrics` keeps a private room's entry (it is still load) but drops its `roomId`.

#### 6.8.7 Testing

- `@bungohan/testing` depends on core. Core's own unit tests (`loop.test.ts`, `room.test.ts`, `room.test-d.ts`) use no harness. **Core's end-to-end suites live in `packages/testing/src/core/`**, which avoids a core ↔ testing dependency cycle.
- `ServerHarness` / `createServerHarness({ define, server, transport })` is the server half of §11.2: a real `BungohanServer` on `LoopbackTransport` + `ManualClock`, with `connect()`, `tick(ms)`, `flush()`, `flushSync()`, `bytesSent()`/`bytesReceived()` (**[DECIDED]** semantics in §11.2: no shortcuts past the rooms' loops). **[DECIDED]** `createTestHarness` (with client-js) is built; see §11.2.
- `TestClient` / `TestRoom` is a wire-level driver. It builds and parses frames byte by byte, keeps a replica with `applyDelta` (a fresh one per snapshot), decodes contract messages, and records raw frames for byte assertions. It stands in for client-js now and serves as an executable reference for non-JS client authors. **[DECIDED]** Like a real client, it picks the codec the handshake names from `DriverOptions.stateCodecs` (default `schema` and `messagepack`), leaves the seat with `CODEC_MISMATCH` when it lacks it, and encodes and decodes contract messages with it. A frame for a `roomRef` it doesn't hold is dropped silently (PROTOCOL.md §7.1), and a `JOIN_SUCCESS`/`JOIN_ERROR` for a JOIN it didn't send through `request()` is recorded in `unmatched`, not thrown.

### 6.9 Per-connection limits — **[DECIDED]** (`packages/core`)

A server with no limits can be exhausted by one connection: a client that
stops reading makes the server queue frames for it without bound, and a
client that floods makes it decode without bound. Both are **on by
default** with headroom normal play never reaches (`ServerOptions.limits`,
`false` to disable; every number `0` means "no limit").

- **Why patches can't just be dropped.** State patches are deltas, so
  skipping one desyncs that client permanently. A slow client is therefore
  *paused* rather than skipped: above `pauseBytes` (default 256 KiB) the
  seat leaves `generateDeltas` exactly as a reconnecting seat does, and at
  or below `resumeBytes` (64 KiB) it returns through the snapshot path and
  is re-synced in full. The two thresholds are hysteresis: one value would
  re-snapshot a flapping client on every tick.
- **Shedding.** A paused seat whose queue is still over `pauseBytes` after
  `maxPausedMs` (15 s), or any connection over `disconnectBytes` (4 MiB) at
  send time, is closed with **1013 `TRY_AGAIN_LATER`** (PROTOCOL.md §8.3),
  not 1008: nothing it sent was malformed, and it may come back. No `ERROR`
  frame is sent first, since the connection is already the problem.
- **Inbound.** Token buckets per connection: `messages.perSecond` (200)
  with `messages.burst` (400) on top, and `messages.bytesPerSecond` (1 MiB).
  Both are charged **before the frame is decoded**, so a flood costs a clock
  read rather than a parse. `joins.perMinute` (60) is separate and fails the
  join with `RATE_LIMITED` instead of closing the connection: a bad join is
  not a reason to drop a player who is otherwise fine.
- **`ITransport.bufferedAmount(clientId)`** is how core sees a queue, and is
  **required**, like `acceptProtocols`: a transport that answered `0` while
  queueing without limit would silently defeat the whole mechanism.
  `WebSocketTransport` returns Bun's `getBufferedAmount()`;
  `LoopbackTransport` counts what `flush()` has not delivered.
- **Cluster (§6.4).** The owning process cannot see a seat whose socket is
  on another process, so `queuedFor` returns `undefined` there and the
  pause never applies; the edge process, which owns that socket, still
  enforces the hard limit. A remote seat is therefore shed rather than
  paused. Noted as a limitation rather than solved: forwarding queue depth
  would cost a backplane message per seat per tick.
- **Metrics:** `ServerMetrics.totalShed`, and `RoomMetrics.syncPauses` (one per pause, not per paused tick).
- **Testing:** `LoopbackTransport.stall(clientId)` / `unstall(clientId)`
  simulate a client that has stopped reading, which is what backpressure is
  about; `ServerHarness.tick` delivers in slices of one sync period rather
  than all at the end, because a real socket drains while time passes and a
  client that received nothing for a whole 60-second `tick` would otherwise
  look like one that stopped reading.

### 6.10 `@bungohan/schema`: the shared-definitions package — **[DECIDED]**

A game's shared module (its state classes and contract) is imported by both
the server and the browser, so it can't import `@bungohan/core` (not
browser-safe). Having it import `@bungohan/client-js` worked, but made every
server depend on the client package, and once published it invites two
copies of `@bungohan/state` (and so two `Schema` classes, splitting
`instanceof` and the schema registry) whenever core and client-js resolve
different versions.

`@bungohan/schema` holds exactly the definitions — `Schema`, the field
factories, `createFiltered`, `f`, `defineMessage`, `defineContract` and their
types — re-exported from `@bungohan/state` and `@bungohan/types`. Shared
modules import only it. Core and client-js `export *` from it, so single-side
files keep one import, and the list exists once rather than hand-duplicated
in both packages (which had already drifted). Runtime pieces (`SchemaRegistry`,
clocks, `LeaveCode`) stay in core and client-js. The browser-safety audit
covers it directly, since every game ships it to the browser. When
publishing, `@bungohan/state` should be a peer dependency of core,
client-js and schema, so an app always resolves exactly one copy.

**[DECIDED] As published (§13.3):** an *exact-version* peer dependency, not a
range, with every other internal dependency exact-pinned too, which is what
makes the release lockstep. `bun run check:pack` fails unless a project
installed from the tarballs holds exactly one copy, in its lockfile and on
disk.

## 7. `@bungohan/client-js` — Reference Client Implementation

### 7.1 Client — **[KEEP]**

```typescript
function createBungohanClient<T = unknown>(options: ClientOptions): IBungohanClient<T>;
// class BungohanClient also exported directly for `new BungohanClient(options)`

interface ClientOptions {
  url: string;
  token?: string | TokenProvider; // [DECIDED] a provider fetches one per connection (§10.1)
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

**[DECIDED] As built** (`packages/client-js/src/react/index.ts`):

- The subpath export `@bungohan/client-js/react` is the only module that imports React. `react` is an optional peer dependency (`>=18`), and the main entry never imports it (checked by the browser-safety test, §7.5).
- **[DECIDED]** `mode` also takes **`"joinById"`**, in which case the first argument is the room id (a room picked from a list), joined with `client.joinById`.
- `useRoom(roomType, options?, mode = "joinOrCreate", join?)`: the fourth argument is the runtime `{ state, contract }` (§7.5), which also types the result. It joins on mount and leaves on unmount, and again when `roomType` or `mode` change. `options` and `join` are read when the join starts. A join that resolves after unmount (e.g. React StrictMode's double effect) gives its seat straight back. `status` gains **`"left"`** (with `leaveCode`) for a room the server ended (kick, dispose, reconnection given up), and `error` is a `ClientError`.
- `useRoomState(room)` without a selector returns `room.state` and re-renders after **every applied state frame**: the replica is mutated in place, so its identity can't signal change. With a selector, it re-renders only when `shallowEqual(previous, next)` fails. **[DECIDED]** An optional third argument, `isEqual(previous, next)`, replaces `shallowEqual`, for selections deeper than one level (e.g. a list of row objects, which `shallowEqual` would always see as changed). `shallowEqual` (exported) is `Object.is`, or same-prototype arrays/objects with `Object.is`-equal elements/own keys. Select plain values (`s => s.score.get()`, `s => [...s.players.keys()]`), not live wrappers, whose identity never changes. Built on `useSyncExternalStore` over `room.onStateChange`, so a replica reset (§7.5) is followed too.
- `useRoomMessage(room, type, cb)` is typed from the room's contract, like `room.onMessage`. The latest `cb` is always called, so it needn't be memoized. A message sent in the server's `onJoin` still reaches it, although React subscribes in an effect after the join resolves (the unclaimed-event rule, §7.5).
- `useBungohan()` outside a `<BungohanProvider>` throws. That's a component-tree setup error, like any missing React context, not a runtime condition.
- Tests (`packages/testing/src/client-js/react.test.ts`) render with react-dom into a happy-dom document, against a real server and client. The selector claim is tested by **counting renders**: three patches that change state but not the selected value cause 0 renders, and one that changes it causes exactly 1.

### 7.5 client-js as built — **[DECIDED]** (`packages/client-js`)

client-js implements §6.7, including §6.7.7, and is the reference for other clients alongside the byte-level `TestClient` (§6.8.7). Where it deviates from the §7.1/§7.2 signatures, it's to follow CLAUDE.md rule 1 (every fallible operation returns `Result`) or because a type parameter doesn't exist at runtime.

**Joining and typing.**

- **The state class and the contract are runtime arguments:** `client.joinOrCreate(type, options, { state: ShooterState, contract: shooterContract })`. TypeScript infers `IRoom<ShooterState, typeof shooterContract>` from them, so there are no generic arguments to write. The §4.1 spelling `joinOrCreate<S, typeof c>(type)` still type-checks, but without the contract object at runtime typed `send` fails (`UNKNOWN_MESSAGE`), since the descriptor is what packs the payload. Without `state`, state frames are still decoded (the codec session stays in step) but not applied, and `room.state` is an empty `Schema`.
- **[DECIDED] The `state` class registers what it reaches.** Before each replica is built, client-js registers every class `reachableSchemaClasses(state)` lists (§5.7.2): nested fields and declared collection element classes, walked once per state class. So classes the client only ever receives (e.g. `Player` inside a map) need no `SchemaRegistry.register`. Registering again per replica, not once per class, keeps it right even if the registry was cleared.
- **The contract hash** sent in the `JOIN` is `contractHash(contract)`, computed once per contract object, or `null` without a contract. Resumes send the same hash.
- **[DECIDED] Typed options** (§4.1.2): with a contract that declares them, the join methods' `options` are typed (`CreateArg<C>` in the creating modes, `InferJoinOptions<C>` otherwise) and the contract argument is required; `joinBody` encodes them before anything is sent, so options that got past the types fail locally with `ENCODE_FAILED`. `joinWith(mode, target, options, join?)` is the one untyped-by-signature entry point, for code generic over the contract.
- **Message ids resolve by name** from the handshake's tables, per join and again per resume. A typed `send` of a name that isn't in both the local contract and the server's table is `UNKNOWN_MESSAGE`. A received id with no name, or a name with no local descriptor, is dropped and logged.
- **A join completes with the first `STATE_SNAPSHOT`** (§6.7.2). `JOIN_SUCCESS` binds the room; the returned promise resolves only when the snapshot has been applied, so `room.state` is always populated.
- **Unknown state codec:** the client sends `LEAVE(roomRef)` for the seat the server gave it, and the join fails locally with `CODEC_MISMATCH`. Codecs are `ClientOptions.stateCodecs` (**[DECIDED]** default `[SchemaCodec, MessagePackStateCodec]`), matched by `getName()`. The room's codec also encodes `send` and decodes typed messages (§8.1.2).
- `JOIN_ERROR` codes map to `ClientError` codes one to one. A code this client doesn't know (a newer server) becomes `JOIN_FAILED`, with the original in `error.context.code`.
- **Frames held during a first join.** A message the server sends in `onJoin` arrives between `JOIN_SUCCESS` and the snapshot, before the caller has the room to register a handler on. So from `JOIN_SUCCESS` on, a new room **holds its frames**, in order, except the first snapshot (which completes the join) and a `LEAVE` before it (which fails the join with `LEFT`). The held frames are handled on the **client clock's next turn** (a 0 ms timer), after the code awaiting the join has run. Order is kept, including relative to patches. A held event (contract or raw message, `CLIENT_JOINED`/`CLIENT_LEFT`) that still finds no handler is kept as **unclaimed** (at most 64, oldest dropped) and delivered to the first handler registered for it, on the next clock turn. React needs this: `useRoomMessage` subscribes in an effect, which may run after that 0 ms timer. Only pre-join events are kept; later ones with no handler are dropped with a warning. A resumed seat already has its handlers and holds nothing.

**Rooms.**

- `send`/`sendRaw` return `Result<void, ClientError>`: `NOT_JOINED` after leaving, `NOT_CONNECTED` while reconnecting, `UNKNOWN_MESSAGE`, `ENCODE_FAILED`. Nothing is queued while reconnecting. Messages are lost, as on the server side (§6.7.5).
- `leave()` returns `Promise<Result<void, ClientError>>` and has **no `consented` parameter**: the wire only has consented leaves, and an unconsented leave is a dropped connection. It sends `LEAVE` and resolves at once, without waiting for the `LEAVE(1000)` acknowledgement (§6.7.5 allows that). It fires `onLeave(1000)` and then removes every listener. While reconnecting it sends nothing, and the seat is simply not resumed.
- **Leaving removes every listener** (§7.2), whoever ends the room: `leave()`, a server `LEAVE`, or a reconnection that fails. `onLeave` fires first, with the `LeaveCode`, then all message, state, error, presence and `listen()` registrations go. A disconnect that can't be resumed is `LeaveCode.DISCONNECTED` (1001).
- `onMessageRaw(cb)` receives the raw (`ROOM_MESSAGE_RAW`) messages; contract messages go to the typed `onMessage`. `room.onError(cb)` receives `(code: string, message: string)`, because the wire's `ERROR` code is a string. It also reports local failures such as `DESYNC`. `removeListener(event, cb)` takes a `RoomEvent` name.
- `room.status` is `joining | joined | reconnecting | left`. `client.getRooms()` holds rooms that have had a snapshot, including reconnecting ones, keyed by room id.
- A frame for a `roomRef` the client doesn't hold is dropped silently. It is normally the `LEAVE(1000)` that acknowledges our own `LEAVE`.

**State (§7.3).**

- The replica is built with `applyDelta`, so the §5.3 wrapper listeners (`onChange`, `onAdd`, `onRemove`) work on `room.state` exactly as §5.7.9 describes. `room.onStateChange(cb)` fires after every applied snapshot or patch frame.
- **Every `STATE_SNAPSHOT` resets the replica**: a new codec session and a **new root object** (§6.7.2), whether it follows a join, a reconnect, or the server replacing its state. So hold on to `room`, not `room.state`, and listeners registered straight on an old replica's wrappers go quiet.
- **`room.listen(attach)`** is how listeners survive resets. `attach(state)` registers wrapper listeners and returns their cleanup. It runs at once on the current replica, and again on every new replica **before its snapshot is applied**. So the snapshot's content arrives through the listeners: `onAdd` per element, `onChange` per non-zero root field. The cleanup runs when that replica is discarded, when the room is left, or on unsubscribe. The pattern for mirroring a collection is `room.listen(s => { s.players.forEach(spawn); return s.players.onAdd(spawn) })`. That handles the current content and future additions, and after a reset the forEach finds nothing and the adds replay everything. (`listen` is a client-js room method; `@bungohan/state` itself has no `listen`.)
- **[DECIDED] Unknown classes are loud.** An instance of a class this client has no registered class for (an element subclass no declaration names, or a class a newer server added) is still left out of the replica, with its subtree (§5.7.2). It is no longer silent: client-js logs it through `ClientOptions.logger.error` and fires `room.onError("UNKNOWN_CLASS", message)`, once per class per replica. The message names the class and says how to fix it. It is not a desync (the rest of the state is correct), so it doesn't trigger a re-sync. One raised while joining (in the join's own snapshot, before the caller holds the room) is kept, like an early message, and delivered to the first `onError` handler.
- **Desync.** An `applyDelta` or `decodeOps` error, or a patch before any snapshot, fires `room.onError("DESYNC", …)`. Protocol v1 has no "resend the snapshot" frame, so the client re-syncs **through reconnection**. It closes the connection with code 4000 and resumes every seat with its token, and each room gets a fresh snapshot. A room without a token is left.

**Connection and reconnection.**

- `ClientOptions` additions: `stateCodecs`, `transport` (`IClientTransport`), `clock` (default `SystemClock`), `pingInterval` (default 5000 ms, 0 disables), `joinTimeout` (default 10000 ms, 0 disables; `TIMEOUT`, and a seat already given is left), `logger` (`warn`/`error`, default `console`; dropped frames and throwing listeners go here, and a throwing listener never breaks the client). `token` is sent as `?token=`. `autoConnect` (default true) connects at construction, and a join on a disconnected client connects first either way. `createBungohanClient(options)` has no type parameter.
- **`connect()`** resolves when the connection opens. A first connect that never opens fails with `CONNECTION_FAILED` and is **not retried**, since nothing was lost yet.
- **PING.** Every `pingInterval` the client sends `PING(nonce, rtt)`. `rtt` is the last round trip in whole ms (sub-ms rounds up to 1), or 0 before the first `PONG`, per §6.7.1. `client.latency` exposes the measurement.
- **What counts as unexpected.** A close is unexpected unless the client closed the connection itself, or its code is `1000` on an open connection (the server closed it on purpose), `1002` (protocol version, terminal: `onError(PROTOCOL_ERROR)`), or `1008` (protocol violation). `1001` (server restart) and `1006` (network) are unexpected.
- **On an unexpected close:** pending joins fail with `CONNECTION_LOST`, seats that had no snapshot yet are left, and every joined seat with a token becomes `reconnecting`. `onDisconnect` fires, and `connectionState` is `"reconnecting"`. Attempt *n* (from 0) is scheduled after `min(delay × factor^n, delayMax)` on the client's clock (default 1000, 2000, 4000, … up to 30000 ms). When a connection opens, `onReconnect` fires, the attempt count resets, and each seat is resumed with `JOIN(RECONNECT, token)`. A seat without a token (the room disallows reconnection) is left with 1001. A resume that fails (`INVALID_TOKEN`, …) leaves that room with 1001 and reports the error on the room. A resume interrupted by another drop is retried on the next connection.
- **The token stays current.** `room.reconnectionToken` is replaced from every `JOIN_SUCCESS` (join and resume), because the server replaces it on every successful (re)join and the old one stops working.
- After `maxAttempts` failed attempts (default 10), the client gives up: every room is left with 1001, `onError(RECONNECTION_FAILED)` fires, and the state is `"disconnected"`. `reconnection.enabled: false` goes straight there.
- `client.reconnect(roomId, token)` resumes a held seat explicitly (e.g. after a page reload). A token that turns out to belong to a different room fails with `INVALID_TOKEN`, and the seat the server resumed is left.
- `disconnect()` leaves every room (consented), then closes with 1000. No reconnection follows. **[DECIDED]** `disconnect()`, `leaveAll()` and `room.leave()` do all their sending **synchronously**, before they return; the promises they return are already settled. (`leaveAll()` used to `await` each room's leave in turn, so only the first `LEAVE` went out in the caller's turn.) Page-exit handlers depend on it, below.

**[DECIDED] Leaving with the page: `client.leaveOnPageExit(target?) → () => void`.**

- **Opt-in, never a default.** Whether closing or reloading the page gives up the seat is the game's choice: a refresh-resumable game keeps the seat and resumes it with `client.reconnect` on the next load (the token saved in `sessionStorage`). So client-js never installs a window listener on its own; the app calls this where it creates the client. What the framework owns is doing it correctly in every browser.
- **What it does.** It listens on `target` (default the global `window`) for **both** `beforeunload` and `pagehide`. The first to fire runs `disconnect()`'s synchronous body: `LEAVE` for every room (joined, joining, reconnecting), then close with 1000, all inside the event handler, before any `await`. The second event is ignored. It returns a function that removes both listeners. It never calls `preventDefault()` or sets `returnValue`, which would make `beforeunload` show the browser's "leave this page?" prompt. If some *other* `beforeunload` handler does, and the user stays, the seats are already given up; that's the accepted cost.
- **Why both events.** Measured with a probe page sending a WebSocket message from page-exit events, reloaded in headless Chromium and headless Zen 1.21 (Firefox engine):

  | Event | Chromium | Zen (Firefox) |
  |---|---|---|
  | message sent in `pagehide` on reload | delivered | **dropped** |
  | message sent in `pagehide` on tab close | delivered | delivered |
  | message sent in `beforeunload` on reload | delivered | delivered |
  | close code the server sees | 1001 | 1001 |

  With `pagehide` alone (what the apps and docs did before), a Firefox reload closes with 1001 and no `LEAVE`; the server can't tell that from a network drop (§6.7.5), holds the seat for `reconnectionTimeout` (30 s), and the old player stays in the room as a ghost. `beforeunload` covers that case; `pagehide` stays for the exits that don't fire `beforeunload` (mobile browsers don't fire it reliably). Checked against our own code: with the helper restricted to `pagehide`, the Firefox check below fails even though the leave is synchronous.
- **Outside a browser** (no `window`: Bun, Node, workers, the test harness) it is a no-op returning a no-op, and client-js stays browser-safe (§7.5 browser safety). No React API: the client is created outside React, and that is where the call goes.
- **Tests.** Unit tests on a scripted server with an `EventTarget` as the window (`client.test.ts`): `beforeunload` sends every `LEAVE` and the close with no `await` in between; a following `pagehide` sends nothing; `pagehide` alone works; the unsubscribe removes both; no window is a no-op. End to end, a page exit is a consented leave (`onLeave(client, true)`, no held seat). **`bun run check:firefox`** (`apps/tutorial/server/scripts/firefox-reload-check.ts`) is the real-browser regression check, since `check:browser` runs Chromium only: the tutorial server in-process, the vanilla tutorial client in headless Firefox/Zen over WebDriver BiDi (`session.new`, `browsingContext.getTree`, `…navigate`, `…reload`), and after each of two reloads the room must hold exactly one seat. It failed (one held ghost seat per reload) before the helper and passes with it. The binary comes from `FIREFOX` (default `firefox`, else `zen-browser`, on PATH). `bun run verify` runs it; `--no-firefox` skips it explicitly and shows as SKIPPED.

**Transport seam.** `IClientTransport.open(url, protocols, { onOpen, onMessage, onClose }) → Result<ClientSocket, ClientError>`. It fails synchronously only when a connection can't even be attempted, and reports everything else through `onClose` (never before `open` returns). `ClientSocket` is `send(data) → boolean` and `close(code?, reason?)`. The default `WebSocketClientTransport` uses the platform `WebSocket` with `binaryType = "arraybuffer"`, offering `["bungohan.v1"]`. A text message is passed on as bytes, so the frame parser drops it as an unknown frame. `LoopbackClientTransport` (`@bungohan/testing`) is the in-process one.

**Errors.** `ClientError` has the §6.5 shape. `ClientErrorCode` is the §6.7.6 `JOIN_ERROR` codes plus `CONNECTION_FAILED`, `CONNECTION_LOST`, `RECONNECTION_FAILED`, `NOT_CONNECTED`, `PROTOCOL_ERROR`, `CODEC_MISMATCH`, `INVALID_MESSAGE`, `UNKNOWN_MESSAGE`, `ENCODE_FAILED`, `NOT_JOINED`, `LEFT`, `TIMEOUT`, `DESYNC`, `SERVER_ERROR` (a connection-level `ERROR` frame, reported through `client.onError`) and **[DECIDED]** `UNKNOWN_CLASS` (reported through `room.onError`, above).

**[DECIDED] Re-exports.** client-js re-exports what apps otherwise pulled in three more packages for: `SchemaRegistry` (from state), `LeaveCode` (from types), and `ok`, `err`, `Ok`, `Err`, `Result`, `tryCatch`, `tryCatchAsync` (from result). They are the same objects, not copies (`exports.test.ts`). **[DECIDED]** Both client-js and core also re-export the authoring set: `Schema`, `SchemaRegistry`, every `create*` factory, `f`, `defineMessage`, `defineContract`, and the types `Infer`, `InferCreateOptions`, `InferJoinOptions`, `CreateArg`, `Contract`, `EmptyContract`, `MessageDef`, `Reservation` (client-js adds `Clock`/`TimerId`; core adds `ConnectionContext`, `ITransport`, `IStore`, `MemoryStore`, `RedisStore` and `StateOf`). **[DECIDED]** Core re-exports the same `Result` helpers as client-js (a server-side test double returns an `Err` without depending on `@bungohan/result`), plus `AuthResult` (what both `onAuth`s return) and `LimitOptions` (the type of `ServerOptions.limits`). `ResolvedLimits` stays internal: no public signature uses it. So a server file imports from core alone and a client file from client-js alone. A module both sides import (state and contract) uses client-js, since core would pull the server into the browser bundle; the objects are the same either way.

**Browser safety (CLAUDE.md rule 5)** is a test (`packages/client-js/src/browser-safety.test.ts`). It runs the real `bun build --target=browser --metafile` on client-js, its React entry (with `react` external), and state, types, serializer and result. It fails on any `bun:`/`node:` import, bare Node builtin, or `@bungohan/core` anywhere in the module graph. The metafile audit is what matters. **Measured on Bun 1.3.13: a browser build of `import … from "node:fs"` succeeds**, with `fs` replaced by an empty stub, and `path` is silently polyfilled. The build's exit code alone proves nothing, so the test also checks that the audit catches exactly those cases. (It spawns the CLI, because `Bun.build()` inside `bun test` run from the repo root failed to resolve isolated-install dependencies that the CLI resolves fine.)

**Tests.** Unit tests against a scripted server (`packages/client-js/src/client.test.ts`: §6.7.7 trailing elements, unknown codes and frames, PING/rtt, timeouts, 1002, codec mismatch, desync). Client typing lives in `room.test-d.ts`. End-to-end tests through the harness are in `packages/testing/src/client-js/`, plus one real-WebSocket test of the default transport against core's `WebSocketTransport`.

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
// [DECIDED] acceptProtocols(protocols) (required) + ConnectionContext.protocol: the protocol version as the WebSocket subprotocol (§6.7.7)
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

// backplane — [DECIDED] byte-oriented, like ITransport (see below)
interface IBackplane {
  publish(channel: string, data: Uint8Array): Promise<Result<void, Error>>;
  subscribe(channel: string, callback: (data: Uint8Array) => void): Promise<Result<void, Error>>;
  unsubscribe(channel: string): Promise<Result<void, Error>>;
  close(): Promise<Result<void, Error>>;
}
// RedisBackplane: two Bun RedisClient connections (publisher + subscriber),
// supports multiple local callbacks per channel via Map<channel, Set<callback>> while only issuing one real Redis SUBSCRIBE per channel
// extra connect()/isConnected(); BackplaneError codes: CONNECTION_FAILED | INVALID_OPTIONS
```

**[FIX]** package export consistency: every one of these packages must re-export its `*Error` class and `ErrorCode` type from its `index.ts` (the old `backplane` package inconsistently omitted this while `store` did export it — normalize this across all four).

**[DECIDED] How these four packages were built** (`packages/{serializer,transport,store,backplane}`):

- **Error types.** Each package exports `XError` and a *prefixed* code type: `SerializerErrorCode`, `TransportErrorCode`, `StoreErrorCode`, `BackplaneErrorCode`, like `@bungohan/state`'s `StateErrorCode`. An unprefixed `ErrorCode` from every package would collide in core, which already has its own `ErrorCode` (§6.5). Every error class has the §6.5 shape (`code`, `timestamp`, `context?`).
- **`ISerializer` returns `Result`** (deviation from the `[KEEP]` signature above): `encode(message): Result<Uint8Array, SerializerError>` and `decode(data): Result<unknown, SerializerError>`, with codes `ENCODE_FAILED` and `DECODE_FAILED`. `decode` runs on every inbound frame of untrusted bytes, and the old signature could only report garbage by throwing, which framework code may not do on a per-message path.
- **MessagePack buffers.** In `@msgpack/msgpack` 3.1.3, `Encoder.encode()` returns a **copy** (`bytes.slice`). Only `encodeSharedRef()` returns a view into the reused buffer. `MessagePackSerializer` reuses one `Encoder`/`Decoder` pair (with `ignoreUndefined: true`) and calls `encode()`, so every returned `Uint8Array` is owned by the caller and safe to queue or retain. The copy is one small memcpy per encode (per broadcast, not per client). CLAUDE.md's "Encoder.encode() returns a view" gotcha describes `encodeSharedRef`, which nothing uses. The decoder rejects truncated input, trailing bytes and `__proto__` keys.
- **`JsonSerializer`** is debug-only: `TextEncoder`/`TextDecoder` (fatal on bad UTF-8) are reused, `Uint8Array` round-trips as `{__type:"Uint8Array", data:[…]}`, and a top-level `undefined` encodes as `null`.
- **Transport** (`WebSocketTransport` on `Bun.serve`). The `on*` methods *register* the single handler for their event; a later call replaces it (core is the only consumer). Handler exceptions go to the `onError` handler, never into Bun's socket loop. Other behavior:
  - The token comes from `?token=` or `Authorization: Bearer …` (the scheme is matched case-insensitively). `context.token` is absent when there is none.
  - Non-upgrade HTTP requests get `426`. Text frames are passed on as their UTF-8 bytes, for the decoder to reject.
  - `send` returns `CONNECTION_LOST` when Bun reports the frame dropped (status 0); backpressure (-1) counts as sent. `broadcast` delivers to every reachable client and returns one error that lists the failed ids in `context`.
  - `disconnect()` stops counting the client as connected immediately, and `onDisconnect` still fires when the close completes. It fires for **every** close, server-initiated ones included.
  - `getPort()` returns the bound port (for `listen(0)`).
  - `close()` sends every client 1001, then stops **gracefully and without awaiting**. On Bun 1.3.13 the promise from `server.stop()` never settles once the server has initiated a WebSocket close, although the port is freed at once. `stop(true)` straight after `ws.close()` drops output Bun hasn't flushed yet (e.g. the upgrade response to a client that has only just connected); `stop(false)` flushes it.
  - Bun's own WebSocket *client* reports a received 1001 as 1000; the bytes on the wire are correct. Keep this in mind for client-js tests run under Bun.
- **Store.** `get` of a missing or expired key is `ok(undefined)` (JSON `null` is a real value). Deleting a missing key is not an error. A TTL is a positive whole number of seconds, otherwise `INVALID_OPTIONS`; `RedisStore` uses `SETEX`. `undefined`, cyclic and `BigInt` values are `SERIALIZATION_FAILED`, and so is a stored value that isn't JSON. A failed command is `OPERATION_FAILED`. Those two codes are additions to the `[KEEP]` list above, which only had `CONNECTION_FAILED | INVALID_OPTIONS` and used `INVALID_OPTIONS` for everything.
- **Backplane.** A process receives its own publications on channels it subscribes to, as in Redis. `subscribe` resolves once the subscription is live. `unsubscribe` removes every callback on the channel. A throwing callback is logged and skipped, and doesn't affect the others. `RedisBackplane` issues one `SUBSCRIBE` per channel, and concurrent `subscribe` calls share the in-flight one. A failed `SUBSCRIBE` rolls back its callback so that a retry re-subscribes. `unsubscribe` during an in-flight `SUBSCRIBE` waits for it, so the channel ends up unsubscribed.
- **[DECIDED] The backplane carries bytes, not JSON**, and doesn't decide what they mean — the same shape as `ITransport`. The encoding belongs to the publisher, which for cluster mode is core with the server's `ISerializer` (§6.4.1 says why that matters). Each callback gets its own copy of the bytes, and `MemoryBackplane` copies at publish time like a socket write, so a publisher that reuses its buffer can't corrupt delivery. `SERIALIZATION_FAILED` is gone from `BackplaneErrorCode`: there is nothing left for the backplane to serialize.
- **[DECIDED] Bun's Redis client cannot carry binary pub/sub payloads.** `RedisClient.publish` refuses a `Uint8Array` or a `Buffer` (`ERR_INVALID_ARG_TYPE`), a subscriber's listener is typed `(message: string, …)`, and Bun's own typings note that buffer subscriptions "are not yet implemented". So the bytes travel as a **latin1 string** — one code unit per byte, byte-exact and no larger, where base64 would cost a third more on every cluster message. Measured on Bun 1.3.13 against a real Redis: all 256 byte values, sequences that are valid UTF-8 (`c3 a9`, `e2 82 ac`) and 4 KB of random bytes all come back unchanged, so Bun decodes a pub/sub payload as binary rather than as UTF-8. That is behaviour rather than a documented promise, so `redis.integration.test.ts` pins it with all 256 values through a real Redis; if it ever changes, that test fails, and in the meantime a corrupted payload fails the receiving serializer's decode and is dropped with a log rather than silently mis-read.
- **Redis clients.** `new RedisClient(url)` throws on a malformed URL, and a constructor can't return a `Result`. So `RedisStore`/`RedisBackplane` construction never throws: a bad URL makes every operation return `INVALID_OPTIONS`. Both accept injected clients (`client` / `clients: { publisher, subscriber }`) typed by minimal interfaces (`RedisStoreClient`, `RedisPubSubClient`) that Bun's `RedisClient` satisfies. That is how the unit tests use in-memory fakes. `redisUrl()` URL-encodes the password (the old code didn't), and `redis` passes `RedisOptions` through.
- **In-memory implementations ship as real exports.** `MemoryStore` (JSON copy semantics identical to Redis; injectable `now` for manual clocks) and `MemoryBackplane` plus `MemoryBus` (several backplanes on one bus simulate a cluster in one process). Delivery copies the bytes at publish time and hands them over on a microtask, in publish order, and is never re-entrant. They are the single-process defaults for core and the test doubles for §2's "mock store / mock backplane".
- **[DECIDED] MessagePack strings are strict UTF-8.** `@msgpack/msgpack` decodes invalid UTF-8 leniently (a lone `ff` becomes `"ÿ"`), which PROTOCOL.md §4 forbids. `MessagePackSerializer.decode` walks the MessagePack structure first and checks every string and map key with a fatal decoder, so such a body is `DECODE_FAILED`.
- **Integration tests** (`*.integration.test.ts` in store and backplane) run against a real Redis when `REDIS_URL` is set and skip otherwise. Each run uses unique key/channel prefixes and cleans up after itself.

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
3. **Encode once, send to many.** For any broadcast or unfiltered state patch, encode a single `Uint8Array` and hand that same buffer to `transport.broadcast(clientIds, data)` — never re-encode per client. (`Encoder.encode()` returns a fresh copy in `@msgpack/msgpack` 3.1.3, so the buffer is safe to queue or retain; see §8's MessagePack buffers note.)

**Message-type interning** — an easy, large win the old code missed entirely: `room.send("playerMove", ...)` shipped the literal string `"playerMove"` on every single input, potentially 60×/second per client. The join handshake now includes the room's message-type table (`{ "playerMove": 1, "chat": 2, ... }`, derived from the room's contract in §4.1), and the wire carries the numeric id. Ids are assigned by the server at runtime and resolved by name on the client, never baked into generated bindings (§4.2). Messages sent through the untyped `sendRaw`/`onMessageRaw` escape hatch aren't in the table and fall back to an inline string plus MessagePack payload, so nothing breaks.

Note that contract-declared messages (§4.1) have known field types, so they skip MessagePack entirely and encode through the §8.1.2 codec like state ops — tag-free. MessagePack remains the encoder only for `sendRaw`/`onMessageRaw` traffic.

**[DECIDED] Phase 1 contract messages** (`packages/serializer/src/message-codec.ts`). **Now the `messagepack` codec's message encoding** (§8.1.2: the room's codec encodes its contract messages; this is no longer the active `ISerializer`'s job). Contract messages go through MessagePack **positionally**: `packMessage(def, payload)` returns a plain array in `fieldNames` order, and `unpackMessage(def, wire)` reads one back. `PlayerMove {x: 145.5, y: -3.25}` is 7 B instead of 23 B as a keyed MessagePack map. Wire form per field:

| Field | Wire value |
|---|---|
| `f.int8`…`f.uint32` | integer, **truncated toward zero and saturated** to the range, NaN → 0 (the §5.7.6.1 philosophy) |
| `f.float32` | `Math.fround(value)`. Phase 1 still pays float64 width in MessagePack; the precision semantics already match Phase 2 |
| `f.float64` / `f.string` / `f.bool` | the value |
| `f.fixed(n)` | int32 per §5.7.6.1 |
| `f.enum(...)` | index into `values` |
| `f.array(X)` / `f.map(X)` | array / string-keyed map of X |
| `f.nested(M)` | M's own positional array |
| `f.optional(X)` | X, or `null` when absent. At message level, **trailing** absent optionals are trimmed, so an unset optional tail costs 0 bytes |

Decoding is **type-directed**: each value is read as its declared kind, and a mismatch, a missing required field, too many fields, an out-of-range enum index or a non-int32 fixed value is `DECODE_FAILED`. Such a payload never reaches a handler. In Phase 1 the self-describing MessagePack value has to be checked against the declared kind as it is read. That check *is* the decoding, not a separate validation pass, and it is what makes §4.1's "a handler typed `{ x: number }` only ever receives a number" true before Phase 2. Absent optionals are omitted from the decoded object (`"key" in msg` is false). A map key `__proto__` is rejected (JSON can carry it and it would replace the prototype). Arrays are strict, with no forward-compatible extra fields: version skew is caught at join by the contract hash (§4.2). `packMessage` fails (`ENCODE_FAILED`, naming the field path) only for payloads that got past the types, e.g. an enum value not in the list.

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

**[DECIDED] `SchemaCodec` as built** (`packages/serializer/src/schema-codec.ts`, codec name `"schema"`, the default). **PROTOCOL.md §13.1 is the byte layout.** This records why it looks the way it does. The list above was a starting point: every rule costs every client implementation, so each was kept only if it paid for itself in measured bytes. The measurements below were taken before any codec code, with a size model over the §11.1 scenarios plus a 30-tick shooter-like stream built from the example app's real classes (8 players, 20 enemies, 30 bullets with spawns and despawns, sizes are op bodies in bytes). The built codec's numbers are in §11.1.

| Scenario | MessagePack | A: op 3 bits + field 5 bits | B1: A + "same target" bit | **B2 (built): B1, a ref value also counts as "last"** | C: A, refId as zigzag delta |
|---|---|---|---|---|---|
| snapshot, 100 entities | 4,032 | 3,451 | 3,053 | **2,953** | 3,523 |
| one position update | 8 | 5 | 5 | **5** | 5 |
| all 100 entities move | 1,396 | 911 | 811 | **811** | 912 |
| churn 10 + 10 | 433 | 370 | 320 | **310** | 390 |
| shooter snapshot | 2,588 | 1,963 | 1,829 | **1,771** | 1,963 |
| shooter tick (mean of 30) | 901 | 525 | 457 | **456** | 525 |

- **Op header: 3-bit op code, 1 "same target" bit, 4-bit field index** (15 escapes to a varint). Two bits can't hold five ops (`DEFINE` included). The S bit ("target = the previous op's target") saves 11–13% everywhere, because an instance's SETs are consecutive. It costs a field bit: fields 15 and up take one extra byte, and no class measured, nor any in the example app, has more than 11 fields.
- **A ref value also becomes "last"** (B2): the content of a new instance, which always follows the op placing it, needs no target. That's another 3% on snapshots and spawns for one assignment in the decoder. Kept.
- **Delta-coded refIds** (C): no gain over absolute varints. Dropped.
- **Boolean bit-packing in state ops: dropped.** It only helps when two or more bools of one instance change in one tick. Its upper bound over all the scenarios was 0 B, and 3 B over 30 shooter ticks (0.1 B/tick), which doesn't pay for a second SET encoding in every client.
- **Bools in contract messages: packed, as message flags**, together with `optional` presence bits (PROTOCOL.md §13.1.6). Measured on the example's `input` message, the most frequent client→server message: 9 B in MessagePack, 7 B with one byte per bool, **3 B** with flags. Optional presence costs a bit instead of a byte, which also removes the MessagePack codec's "trim trailing absent optionals" rule from this codec.
- **8-bit integers are one raw byte; wider integers are (zigzag) varints.** Same size in every scenario (values under 128), a byte smaller for 128–255 (health, counts), and simpler than a varint.
- **`DEFINE` type strings stay strings** (140 B for the §11.1 table vs 145 B in MessagePack). A compact type code would save ~40 B once per join but add a second encoding of the §5.7.2 grammar.
- **A ref always carries its classId**, even for a refId the session has seen. Omitting it would need one encoder session per client: the room's single session knows refIds that a late joiner's or a filtered client's session never saw.
- **Floats are IEEE bits, little-endian, NaN canonical, −0 preserved.** (MessagePack encodes −0 as the integer 0; both are documented, and the vectors pin the difference.)
- **Tag-free decoding needs to know what each refId is.** Sessions keep a *target table* (refId → class, or collection type), fed by the root (refId 0 is always class 0) and by every ref read or written. It never needs pruning: blocks are reused only within their class (§5.7.9), so a refId means the same thing for the whole stream.
- **One codec per room.** `IStateCodec` gained `encodeMessage(def, payload)` / `decodeMessage(def, bytes)`, and the handshake's `stateCodec` selects the encoding of state *and* contract messages, both directions (§8.1.1 intended contract messages to skip MessagePack). Raw messages and control bodies stay on the connection's `ISerializer` (MessagePack).
- **Sessions are all-or-nothing per frame**: a failed encode or decode rolls back the `DEFINE`s and refIds it bound, so a refused frame never desynchronizes the room's encoder from what was actually sent.
- **Counts are bounded by the bytes left in the body** (a decoder never allocates from a hostile count). Since an array of zero-field messages would encode each element in zero bytes, **[DECIDED]** `validateContract` rejects arrays and maps whose elements are messages with no data (a definition-time error, §6.8.4).
- **The §8.1.2 prediction** (4 bytes for `[SET, refId=12, field=3, 145.5]` at 2 dp) is **5 bytes** as built: the value is zigzag(14550) = 29100, a 3-byte varint, not 2. The prediction holds for |value| ≤ 81.91 at 2 dp, or at 1 dp (the example app's positions, zigzag(1455) = 2910). With the S bit, the second axis of a move costs 3 B. The test `bandwidth.test.ts` checks the exact 5 bytes.

#### 8.1.3 Phasing

`SchemaCodec` is the largest piece of new work in this spec, so build it in two stages and keep both behind the same seam:

- **Phase 1** — implement state sync over `MessagePackSerializer` using the positional `WireOp[]` encoding from §5.7.3. Fully correct, already a big improvement, gets the system working end to end.
- **Phase 2** — implement `SchemaCodec` against the same `WireOp[]` input/output and swap it in via `ServerOptions.stateCodec`.
- **[DECIDED] Both phases are done.** `SchemaCodec` is the default in core, client-js and the test driver; `MessagePackStateCodec` stays selectable (`ServerOptions.stateCodec`), and client-js and the driver implement both by default, so either server configuration works with a default client.

Because both stages consume and produce identical `WireOp[]`, Phase 2 is a drop-in swap with no changes to the state layer, and the §11.1 bandwidth tests can run against both to prove the improvement rather than assume it. Keep `MessagePackSerializer` selectable for state sync permanently — it's invaluable for debugging, since its output is inspectable without the schema table.

#### 8.1.4 Server option

```typescript
interface ServerOptions {
  // ...
  serializer?: ISerializer;   // room messages — default MessagePackSerializer
  stateCodec?: IStateCodec;   // [NEW] state sync and contract messages — [DECIDED] default SchemaCodec
}
```

The browser SDK negotiates this at join: the handshake names which codec the room is using, and the client selects the matching decoder rather than being configured separately. A mismatch is a hard error at join time, not a silent decode corruption.

#### 8.1.5 State codec sessions — **[DECIDED]** (`packages/serializer/src/state-codec.ts`)

The §8.1.2 `IStateCodec` signature (`encodeOps(ops, table)`) is replaced by codec **sessions**, which own the table. The table grows mid-stream through `DEFINE` ops, and a tag-free decoder must know each class before the ops that use it:

```typescript
interface IStateCodec {
  getName(): string                       // named in the join handshake
  createSession(): IStateCodecSession     // one per stream: per room on the server, per joined room on a client
}
interface IStateCodecSession {
  encodeOps(ops: readonly WireOp[]): Result<Uint8Array, SerializerError>
  decodeOps(data: Uint8Array): Result<WireOp[], SerializerError>
  getTable(): SchemaTable                 // a copy, maintained from the DEFINEs seen, in stream order
}
```

- A session applies every `DEFINE` it encodes or decodes (`ClassTable`). A new class must take the next `classId`, and an existing one must be restated identically; a late joiner's snapshot replays the whole table, which is fine. A `DEFINE` that contradicts the table or skips an id is an error (`ENCODE_FAILED` / `DECODE_FAILED`). One server session per room is enough: every client's stream carries the same `DEFINE` sequence, because `DEFINE`s are never filtered.
- `decodeOps` guarantees **well-formed ops** (`isWireOp`: op code, arity, and value types; `DEFINE` types must parse per the §5.7.2 grammar). Whether refs and field indices make sense for the receiving tree remains `applyDelta`'s job.
- **Phase 1 `MessagePackStateCodec`** encodes the `WireOp[]` array as-is. Its output is byte-identical to `encode(ops)`, so the §5.7.11 / §11.1 baselines apply to it unchanged, and it stays inspectable without the table.
- **[DECIDED]** `IStateCodec` also has `encodeMessage(def, payload)` and `decodeMessage(def, bytes)` (§8.1.2): messages need no session, since their declarations are the whole layout. `ClassTable` gained `truncate(size)` for the sessions' rollback.

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

### 10.1 Connection authentication — **[DECIDED]** (`packages/core/src/server.ts`, `packages/client-js/src/client.ts`)

`onAuth` runs once per *join*, and every join on a connection sees the same `context.token`. So a credential that can be used only once (a login ticket redeemed with `GETDEL`, a short-lived signed URL) was spent by the first join and refused on every later one: a player moving lobby → match → lobby on one connection couldn't. And the client's `token` was a string fixed at construction, so an automatic reconnect reused a ticket that was already spent. The framework still verifies nothing itself; what it adds is the place to do it once, and a way for the client to fetch a fresh credential for each connection.

- **`ServerOptions.authenticate?: (context: ConnectionContext) => AuthResult | Promise<AuthResult>`.** It starts once per accepted connection, right after the protocol check; `server.onConnect`'s callbacks run straight after, while it is still pending. The transport doesn't wait for it, so the socket opens at once. Same results as `onAuth`: an object admits the connection and becomes `connection.auth`, `true` admits it as `{}`, anything falsy refuses it. Without the option every connection is admitted with `{}`.
- **Every `JOIN` waits for it**, whatever its mode (including `RECONNECT` and reservations): a join that arrives while it is still running is parsed and then waits; frames other than `JOIN` are unaffected (a connection has no seat before its first join). A refused connection answers **every** `JOIN` with `JOIN_ERROR AUTH_FAILED`, and a throw with `JOIN_FAILED` (reported to `server.onError` with the new `source: "authenticate"`). The outcome is computed once and kept for the life of the connection: it isn't retried per join.
- **A refused connection is not closed.** Refusal travels as the existing `AUTH_FAILED` join error, so the wire format doesn't change and every client, including ones built before this, already handles it. A new close code would have sent older clients into a reconnect loop against a server that refuses them each time. The socket stays subject to the usual limits (§6.9) and idle timeout. A client that wants to try other credentials reconnects.
- **[DECIDED] A room that overrides only the instance `onAuth` gets a startup warning.** The default static `onAuth` admits everyone, so such a room admits the creating join unchecked, silently. `registerRoomType` logs it (not a throw: a room that lets anyone create is legitimate, and says so by overriding the static hook to return `true`). A static hook inherited from a base class counts as overridden.
- **Rooms inherit it.** `onAuth` returning `true` (which is what the default hooks do) now gives the seat a shallow copy of `connection.auth` instead of `{}`, so a server with `authenticate` and rooms that don't override `onAuth` gets `client.auth` filled in everywhere. A room that returns an object still sets `client.auth` to that object; a hook reads the connection's result as `client.connection?.auth`, which is set when both `onAuth` hooks run. `room.join(client)` for a connectionless client (a bot) inherits `{}`.
- **Cluster mode.** `authenticate` runs on the process that holds the socket, never on the process that owns the room: a forwarded join carries `connection.auth` next to the packed context (`JoinForwardRequest.auth`), and the owning process's `RemoteConnection` exposes it. A one-time credential is redeemed exactly once however many processes the player's rooms live on. It must survive the backplane's serializer, like join options.
- **`Connection.auth`** is `undefined` while `authenticate` is running and after it refused or threw; `{}` or the returned object once admitted.
- **Client: `token?: string | (() => string | undefined | Promise<string | undefined>)`.** A function is called before **every** socket the client opens, the first connect and each automatic reconnection attempt, so each connection can carry a fresh one-time credential. A string behaves as before. A provider that throws, rejects or returns a non-string other than `undefined` fails that attempt like a socket that couldn't open (`CONNECTION_FAILED` on a first connect, the next backoff step on a reconnection). A `disconnect()` while the provider is pending wins: the socket is never opened. The C# and GDScript clients keep their fixed token; nothing on the wire depends on which one a client has.

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

**[DECIDED] Both codecs, side by side** (`packages/serializer/src/bandwidth.test.ts`, moved from `@bungohan/state`, which can't depend on the codecs). Every scenario runs through a real codec session (snapshot first, so the session knows every refId, as on a server), and each codec's size must stay under its measured number + 5%. A 100-entity room (`Entity`: `x`/`y` fixed:2, `angle` fixed:3, `hp` float64 = 100, `alive`, `kind`), op body bytes (a frame adds 2):

| Scenario | `messagepack` | `schema` | §8.1.2 prediction |
|---|---|---|---|
| idle tick | 0 | 0 | 0 |
| one position update (x = 145.5) | 8 | **5** | ~4 (see §8.1.2: 5 is right for this value) |
| one entity, both axes | 15 | **8** | – |
| all 100 entities move | 1,396 | **811** (−42%) | – |
| churn: 10 spawns + 10 despawns | 433 | **310** (−28%) | – |
| join snapshot, 100 entities | 4,032 | **2,953** (−27%) | – |
| 30,000-tick churn, per tick (flat) | 138 | **94** (−32%) | – |

On the wire: the core end-to-end fixture's one-position patch is 6 B (was 9), checked byte for byte. In the example app's two-tab browser run (headless Chromium, real server, Vite client, frames captured over CDP and decoded with `SchemaCodec`), the shooter's `STATE_PATCH` bodies averaged ~9 B and every `input` message was 3 B.

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

**[DECIDED] Building blocks** (`packages/testing`; `createTestHarness` itself waits for core and client-js):

- **`LoopbackTransport`** is a complete `ITransport`, and only bytes cross it. Core and the client must encode and decode every frame exactly as over WebSocket. Frames are **copied at send time** (like a socket write), so a sender that reuses or mutates its buffer afterwards can't corrupt delivery. Its behavior:
  - `connect(options?)` returns the client end, a `LoopbackSocket` (`send`, `close`, `onMessage`, `onClose`, `readyState`). The server's `onConnection` has already run by the time `connect()` returns.
  - Nothing is delivered until **`await transport.flush()`**. That delivers every queued frame and close in FIFO order and lets promise continuations settle between events, so replies from async handlers are delivered by the same flush. It gives up with a `Result` error after `maxFlushEvents` (endless ping-pong).
  - Ordering: a close queued after a frame arrives after it. Frames a client sent before the server disconnected it are dropped. A client's frames sent before its own `close()` still arrive.
  - It mirrors `WebSocketTransport`: 1001 on `close()`, `onDisconnect` for every close, and 1009 for client frames over `maxPayloadLength`.
  - `stats()` / `resetStats()` count bytes and frames per direction; they back `harness.bytesSent()` / `bytesReceived()`.
- **`ManualClock`** implements `Clock` (`now`, `setTimeout`/`clearTimeout`, `setInterval`/`clearInterval`). `await clock.advance(ms)` fires due timers in due-time order (ties in scheduling order), setting `now()` to each timer's due time, and **settles promise continuations after each timer**, so a tick's async work finishes before the next tick. Delays clamp like the platform's (negative/NaN → 0; intervals ≥ 1 ms). `advance` calls made during an advance (e.g. from a timer) run after it, in order. Settling uses `setImmediate` (the next macrotask), which is not a sleep.
- **Errors from code under test propagate.** An exception from a timer callback rejects `advance()`, and one from a *client-side* socket listener rejects `flush()`. A failed `expect()` inside a callback therefore fails the test instead of vanishing. Server-side handlers keep `ITransport` semantics (routed to `onError`), because that is what core sees in production.
- ~~`Clock` lives in `@bungohan/testing` for now.~~ ~~`Clock` now lives in `@bungohan/core`.~~ **[DECIDED] `Clock` lives in `@bungohan/types`** (`packages/types/src/clock.ts`, with the browser-safe `SystemClock`), shared by core (`ServerOptions.clock`) and client-js (`ClientOptions.clock`: PING and reconnection backoff). Core and testing re-export it. `ManualClock` implements it, so one clock drives server and clients in the harness.
- `end-to-end.test.ts` wires what exists so far the way core and client-js will: state → `MessagePackStateCodec` → loopback → decode → `applyDelta`, with positionally packed contract messages going the other way, driven by `ManualClock` at 20 Hz. A two-input steer produces one 7-byte sync frame, and an idle tick produces nothing. (It predates core and pins the MessagePack path; core's own suites now run on `schema`.)

- **[DECIDED] `createTestHarness`** (`packages/testing/src/harness.ts`) is built: a real server on `LoopbackTransport` + `ManualClock`, with real client-js clients.
  - `await createTestHarness({ rooms: { game: GameRoom, other: [OtherRoom, defineOptions] }, client, server, autoJoin })` is async, like `createServerHarness`. `rooms` entries are type-checked per class (`RoomClass<R>`).
  - `await harness.connect(options?)` returns a connected `BungohanClient` on the harness's loopback **and clock**, so reconnection backoff and PING advance with `tick()`. `options` are `ClientOptions` minus transport and clock, and `client` sets defaults for every connect. **[DECIDED]** `options.autoJoin` overrides the harness's `autoJoin` for one client; only automatically delivered clients' joins keep delivery going.
  - **Automatic join delivery** (`autoJoin`, default true). ~~A `JOIN` a harness client sends triggers flush → one sync boundary in every room → flush.~~ **[DECIDED] No shortcuts past the rooms' loops.** The old delivery called `room._syncNow()` directly, a sync no real server would run. That hid a core bug: a join into a paused room completed in tests but hung in production (§6.7.5). Now the harness follows each client's joins by their frames. A `JOIN` is in flight until its `JOIN_ERROR`, or until the `STATE_SNAPSHOT` (or `LEAVE`) of the roomRef its `JOIN_SUCCESS` assigned, or until the client leaves that seat itself (after a join timeout). Delivery flushes, then advances the shared clock **timer by timer** (every loop, timeout and backoff runs as it falls due) until no join is in flight, capped at 60 s of simulated time. So `await client.joinOrCreate(…)` still resolves with no manual pumping, but **time moves**, typically up to one sync period, exactly as long as the join would take on a real server. A room whose loop can't serve the join before the client's `joinTimeout` makes it time out, as it would in production. This applies to resumes after a reconnect as well. Nothing else a client sends is delivered until the test flushes or ticks. When the shortcut was removed, no pre-existing test depended on it. Only the new paused-room tests failed, and only while the §6.7.5 fix was reverted.
  - **[DECIDED] `joinRealWait`** (real ms, default 0). Delivery can't see real I/O (a `fetch`) that `onAuth`/`onCreate`/`onJoin` await, so simulated time races past it: the client's `joinTimeout` fires, or, with no timer left, delivery stops and the reply is never delivered. The server counts `JOIN` frames being handled (`_joinActivity()`, internal). With `joinRealWait`, before each clock step delivery waits up to that much real time for a running join to finish. Default 0 keeps the harness free of wall-clock time; when delivery gives up while the server still runs a join, it warns and names the option. **[DECIDED]** In a cluster: the owning process counts a forwarded join (`remoteJoin`) too, since its hooks run there; `ClusterHarness.run` gives running joins the same real-time wait before each clock step (it used to race the shared clock past them to the client's `joinTimeout`); and a process waiting on one of the cluster's own broadcast windows (`_joinActivity().clockBound`, from `PendingRequests.windows()`) gets no real-time wait, because only moving the clock ends a window. Without that, every join that looked for a room across the cluster cost a full `joinRealWait` of real time.
  - **[DECIDED] `snapshotFor(state, client)`** (`packages/testing/src/snapshot.ts`) returns what one client would decode from its join snapshot: `encodeSnapshot` with that client's filters, through `SchemaCodec`, `applyDelta` into a new instance. It settles the state's pending changes first (`generateDeltas` + `clearChangeTrees`), so it is for states a test built, never a running room's. It lives in testing, not schema, because schema holds definitions only.
  - **[DECIDED] `tick(ms)` delivers first:** flush, advance `ms`, flush. Before, it advanced first, so a message sent right before `tick()` was handled after that tick's sync boundaries, and its effect only went out a tick later.
  - **[DECIDED] `flushSync()` goes through the loops:** it ticks by the longest sync period among the rooms whose sync loop is running, so every running room reaches a boundary. Time moves by that period, and a paused room doesn't sync. It used to call `_syncNow()` on every room directly.
  - **`harness.flush()` also runs clock timers already due (`advance(0)`)**, because client-js defers work to its clock's next turn with 0 ms timers (§7.5). Time does not move. It also waits for automatic join delivery, including deliveries started while it ran.
  - `ManualClock.nextDue()` gives the next timer's due time (what join delivery steps through), and `LoopbackClientTransport` takes `onReceive`/`onClose` hooks (what it follows joins with).
  - **[DECIDED]** `harness.stateOf(RoomClass, room)` returns a room's server-side state typed by its class (`StateOf<R>`, from a type-only `Room.__state`), for a room id or anything with an `id`, and throws if no such room of that class is on the harness's server. Rooms keep `state` `protected`; tests no longer need `public override state`.
  - `harness.offline = true` makes new connections fail like an unreachable server (never open, close 1006). `harness.dropConnection(client, code = 1006)` drops a client's connection from the network side. `harness.socketOf(client)` returns its current `LoopbackSocket`, to inject frames with `transport.send`. `harness.driver()` returns a byte-level `TestClient` on the same server. `harness.stop()` disconnects every client, then stops the server.
  - `ServerHarness` (with `TestClient`) is unchanged. Both share one base class for the server, loopback, clock, `tick`/`flush`/`flushSync` and byte counters.
  - **[DECIDED] `createClusterHarness`** (`packages/testing/src/cluster.ts`) is the §6.4 harness: `size` real `BungohanServer`s in one `bun test` process, each a full `TestHarness` with its own transport and clients, sharing one `ManualClock` (so every heartbeat, deadline and sync loop in the cluster runs on the time a test advances) and one backplane bus (`MemoryBackplane`s on a shared `MemoryBus` by default, or injected `backplanes` — real `RedisBackplane`s in `redis.integration.test.ts`). `flush()` covers every node, since a frame for a client on one process may be produced on another; `run(promise)` advances timer by timer until cross-process work settles; `kill(index)` stops a process the way a crash does (no goodbye, so peers notice by heartbeat timeout); and `settle` lets a backplane that goes over a socket be waited for. Each harness gets a fresh channel `namespace`, so runs can share a Redis. The join pump is the `TestHarness` one, now driven through a replaceable network hook.
  - `LoopbackSocket.protocol` exposes the negotiated subprotocol, like `WebSocket.protocol`.
  - End-to-end suites (`packages/testing/src/client-js/`) cover: join, typed messages both ways, raw messages, an `onJoin` message reaching a handler registered after the join, state listeners, `listen()` across a mid-game snapshot, listener removal on leave, kicks, reconnection driven by the clock (default delay, backoff while offline, giving up, rooms without reconnection), explicit `reconnect()` and `consumeReservation()`, unknown frame types and message ids being dropped, contract mismatch, and codec mismatch.

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

**[DECIDED] As built.** The format is PROTOCOL.md §14 (JSON, hex with optional spaces, `{"f64": bits}` for NaN/±Infinity/−0, message declarations as JSON).

- **Hand-written (`0xx-*.json`, `"generated": false`)**, computed byte by byte from PROTOCOL.md *before* `SchemaCodec` existed, so they test the implementation against the document and not against itself: varints and zigzag (`001`), the numeric rules including half-way negatives, saturation, NaN and −0 (`002`), frames and MessagePack bodies (`003`), `schema` state streams with every op kind, value type, key type, the S bit, the field escape and inline `DEFINE`s, plus the same stream under `messagepack` (`004`), malformed bodies and unencodable ops (`005`), contract messages under both codecs (`006`), malformed messages (`007`), and the compatibility/violation rules (`008`). `SchemaCodec` matched every one of them on its first run. That run's only failures were two gaps the vectors exposed elsewhere, both fixed: `MessagePackSerializer` accepted invalid UTF-8, and `TestClient` threw on frames for a `roomRef` it didn't hold. The runner itself was then checked by corrupting single bytes of a vector. **Never regenerate these.** If one is wrong, fix it by hand, against PROTOCOL.md.
- **Generated (`1xx-*.json`, `"generated": true`)** by `bun run vectors` (`packages/testing/src/conformance/generate.ts`), deterministically, from the real state layer and both codecs: frames at every varint boundary and handshake bodies (`101`), snapshots with `DEFINE`s, every collection element type, nested schemas and a late joiner, refId reuse, numeric edges (`102`), per-client filtered streams (`103`), contract messages over every field kind with seeded random payloads and the example's contract (`104`), and unknown frame types and trailing elements (`105`).
- **[DECIDED] Fix found by the C# runner:** `normalize` (`vectors.ts`) dropped map entries whose value is an absent optional, so `104`'s `decoded` said `"sparse": {}` for a payload `{"x": null}`. The key belongs in the map (PROTOCOL.md §14: absent values inside a map are `null`); both TypeScript decoders already kept it, as an own property set to `undefined`. `normalize` now maps those to `null`, and `bun run vectors` changed only the nine `sparse` expectations.
- **[DECIDED] Replica and string vectors (`009`, `010`, hand-written).** `009` is a `replica` case kind (PROTOCOL.md §14): declared classes, op frames, and the expected tree after each frame, with `"$"` labels that pin object identity. The runners build the classes at run time (`replica.ts`, `ReplicaVectors.cs`, `tests/replica_vectors.gd`). It pins the nested-field replacement rule (§5.7.9): all three receivers failed it before the fix (TypeScript kept the old refIds bound to the nested object and double-counted its holder; C# and GDScript kept the old collection elements bound). `010` pins U+0000 → U+FFFD (PROTOCOL.md §1.3) in both codecs, which TypeScript and C# failed before; its lone-surrogate case also caught `@msgpack/msgpack` writing a short string's lone surrogate as invalid UTF-8.
- **[DECIDED] Join options (`011`, hand-written, new `join` case kind, PROTOCOL.md §14).** Thirteen cases against one room type, `options`, declaring create and join options: the §6.2.1 example, saturation and a negative fixed value, `null` for an unread `createOptions`, an options map from an untyped client, a stale hash winning over bad options, a missing element, a trailing byte, an unused flag bit, an enum index out of range, `null` create options with required fields, and a `bin16` a decoder must accept; plus that mode `JOIN` decodes join options before looking for a room and never reads create options. Every runner builds the frames byte for byte, and sends each case's bytes to a real server and checks the reply and, on success, what the room received: `bun test` on the loopback, C# and GDScript against the interop server's `options` room over a real WebSocket. The implementation passed all of them on the first run; the TypeScript runner was then checked by corrupting a byte and an expected reply.
- **Runner:** `packages/testing/src/conformance/conformance.test.ts`, part of `bun test`. Every codec case runs in both directions (encode → exact bytes, bytes → decoded ops/payload) for each codec it names. Behavior cases run against a real server (server side) and against both the byte-level `TestClient` and client-js (client side).
- `conformance/` is excluded from Biome: the files are golden data, laid out for reading.

## 12. Build Order

Given package dependencies, implement in this order so each layer can be tested against real (not mocked) lower layers:

1. `@bungohan/result` — no deps
2. `@bungohan/types` — no deps. Includes the §4.1 contract builders (`defineMessage`, `defineContract`, `f`, `Infer`) and the `WireOp`/`SchemaTable` types, so both `state` and `serializer` can depend on the wire vocabulary without depending on each other.
3. `@bungohan/state` — depends on `result`, `types`
4. `@bungohan/serializer` — depends on `types` (external: `@msgpack/msgpack`). Ship `MessagePackSerializer` + `JsonSerializer` first; `SchemaCodec` (§8.1.2) is Phase 2. **[DECIDED] Done**, and the default.
5. `@bungohan/transport` — depends on `result`; external: Bun native `Bun.serve`
6. `@bungohan/store` — depends on `result`; external: Bun native `RedisClient`
7. `@bungohan/backplane` — depends on `result`; external: Bun native `RedisClient`
8. `@bungohan/core` — depends on all of the above
9. `@bungohan/client-js` — depends on `result`, `serializer`, `state`, `types` (never `core`, never Bun/Node-only APIs — must run in a browser)
10. `@bungohan/testing` — depends on `core` + `client-js`; the loopback harness (§11.2). Build it early enough to use it while developing 8 and 9.
11. `PROTOCOL.md` + `conformance/` vectors (§11.3) — write these as the wire format stabilizes, not after. They're the contract every non-JS client implements against. **[DECIDED] Done** for v1 (§6.7, §11.3).
12. `@bungohan/codegen` — depends on `types`; emits C#/GDScript/JSON bindings (§4.2). **[DECIDED] Done**, with the C# and GDScript protocol cores it binds to (§4.2.1).
13. Cluster mode (§6.4) — depends on `core` + `backplane`. **[DECIDED] Done**, with no wire change (§6.4.1).
14. `apps/example-shooter` — exercises everything end-to-end; port the existing app's server/client/shared code onto the rebuilt API, adjusting call sites for the **[NEW]**/**[FIX]** items above (it can now use `server.onJoin(...)` instead of hand-rolling it via `RoomManager`, should declare its messages through a §4.1 contract, and should switch from its bespoke `useBungohan` hook to the real `@bungohan/client-js/react` one).

## 13. Publishing to npm — **[DECIDED]**

Eleven packages ship: `result`, `types`, `state`, `schema`, `serializer`,
`transport`, `store`, `backplane`, `core`, `client-js` (with its `/react`
subpath) and `testing`. `@bungohan/codegen` stays unpublished — its targets
are the deferred C#/Godot clients — and every app and docs example is
`"private": true`. The operational checklist is `RELEASING.md`; this section
is why it looks the way it does.

### 13.1 Build: `tsc`, and why declaration emit decided it

The repo is on TypeScript 7 (the native port), so the first question was what
7.0.2 can actually emit, not what a bundler could. It emits `.d.ts` and keeps
JSDoc verbatim, which settled it: `tsc` alone, no second tool, no `.d.ts`
bundler. The JSDoc mattering is the point of the §JSDoc rule — the contract
lives on the interface, and an editor only shows it if it survives emit, so
`check:pack` asserts it in the shipped declarations for members like
`IBungohanClient.connect` and `Room.onJoin`.

Two things TypeScript 7 changed that the build had to absorb:

- **`baseUrl` was removed** (TS5102). `paths` in `tsconfig.build.json` are
  therefore written relative to that file, with no `baseUrl`.
- Each package compiles against its siblings' **built** `.d.ts`, via those
  `paths`, and so must be built in dependency order. That is deliberate: it
  typechecks the emitted declarations the way an installed copy sees them,
  rather than against source that will never ship.

`declarationMap` is off (its maps would point at a `src/` that isn't
shipped); `sourceMap` with `inlineSources` is on, so a user stepping into
the library sees the TypeScript without a separate `src/` in the tarball.

**Extensions.** `tsc` emits `from "./room"` unchanged, which only a bundler
resolves. `scripts/build.ts` rewrites relative specifiers to an explicit
`.js` in both `.js` and `.d.ts` output, then fails if any relative target
doesn't exist. That is what makes the packages valid under `node16`
resolution, which `check:pack` checks with a config of its own.

### 13.2 `publishConfig`, and why the pack step is a script

The monorepo must keep running on raw TypeScript: `bun test`, the apps and
the docs examples all resolve `@bungohan/*` through the workspace symlinks to
`src/index.ts`, with no build. So `packages/*/package.json` keeps `main` and
`exports` pointing at `./src`, and the published entry points live under
`publishConfig` — npm's own place for exactly this.

A custom export condition (`"development": "./src/index.ts"`) was the
obvious alternative and was rejected on evidence: Bun does not apply
`development` by default (verified — it resolves to the `default` branch),
and a condition that needs `--conditions` on every `bun test`, `bun run`,
`vite` and `bun build` invocation is a dev workflow that breaks the first
time someone forgets a flag.

**Neither `bun pm pack` nor `npm pack` applies `publishConfig`** — verified
directly: both packed a manifest still claiming `"main": "./src/index.ts"`,
a file absent from the tarball. `npm publish` applies its directives and
`bun publish` does not, so relying on it would make the published artifact
depend on which tool ran. `bun run pack` therefore applies it itself, and:

- resolves `workspace:*` and `catalog:` to exact versions (rather than
  trusting `bun publish` to, since the tarball is what gets published);
- drops `scripts` and `devDependencies` (a `prepare` script in a tarball
  runs on install);
- rewrites the READMEs' relative links to absolute GitHub URLs — npm's
  viewer resolves relative links against `repository.directory`, which
  `../../docs/…` escapes;
- stages `dist` + `README.md` + `LICENSE` and packs that, so the tarball
  cannot contain more than `files` lists.

Each package holds its own `LICENSE`, a copy of the root one rather than a
file the pack step conjures: `files` can only include what is inside the
package, and a license should be visible where the package is, on GitHub as
well as on npm. Hard copies drift, so `scripts/license.test.ts` (in
`bun test`) checks every copy byte for byte against the root and fails a
published package that doesn't list `LICENSE` in `files`.

**The tarball is what gets published**, never a package directory: `bun
publish .pack/bungohan-core-<v>.tgz`. Each package carries a
`prepublishOnly` guard that refuses a publish from its own directory, since
that path would produce the broken manifest above.

### 13.3 One `@bungohan/state`: exact peers

§6.10's requirement, applied. `@bungohan/state` is a **peer dependency at an
exact version** (`"0.1.0-alpha.1"`, not a range) of `core`, `client-js` and
`schema`, and a `devDependency` for the monorepo. A range would let two
satisfying versions coexist under some resolvers; an exact pin makes a
mismatched pair an install error rather than a silent second `Schema` class.
Every other internal dependency is exact-pinned too, so resolvers dedupe.

That is what makes the release **lockstep**: a package bumped on its own
would stop satisfying its siblings' pins. `bun run version <semver>` moves
them together.

Versions and engines: `0.1.0-alpha.1` on the `alpha` dist-tag. Server
packages (`transport`, `store`, `backplane`, `core`, `testing`) declare
`engines.bun`; the browser-safe ones (`result`, `types`, `state`, `schema`,
`serializer`, `client-js`) declare none, because they must run in a browser
and a bundler. `sideEffects: false` everywhere — every module-level binding
in these packages is a local constant, nothing mutates shared state on
import.

### 13.4 `check:pack`: proof from tarballs, outside the repo

`bun run check:pack` (part of `bun run verify`, opt out with `--no-pack`)
builds, packs, and installs **only the tarballs** into a fresh project in the
system temp directory — outside this repo, so nothing can resolve through a
workspace symlink and pass on source that is not in any tarball. The fixture
(`scripts/pack-fixture/`) is an ordinary small game: a shared module
importing only `@bungohan/schema`, a Bun server on `@bungohan/core`, a
browser client on `@bungohan/client-js` and its React subpath, and a
`@bungohan/testing` suite.

**A local registry, not `file:` deps.** A tarball's own `@bungohan/*`
dependencies are version ranges, and only a registry answers those. Installing
the tarballs as `file:` paths fails outright (they resolve to npm, where the
packages don't exist yet), and forcing them with `overrides` would guarantee
one `@bungohan/state` by construction and prove nothing. So
`scripts/mini-registry.ts` serves the packed tarballs over HTTP — a packument
and a tarball per package, which is all `bun install` asks for a fixed
version — and the fixture points only the `@bungohan` scope at it. React,
Vite and both TypeScripts come from npm as usual, which is why the check
needs the network.

What it asserts: no `workspace:`/`catalog:` reached a manifest and every
entry point resolves to a file that is in the tarball; the lockfile *and*
`node_modules` hold exactly one `@bungohan/state`, including from the two
install lines the docs actually give (`bun add @bungohan/core
@bungohan/schema` and the client's), where `state` is named in neither and
arrives only as a peer; the published `.d.ts`
typecheck under TypeScript 7 and the latest 5.x, as declarations with
`skipLibCheck` off and `types: []` (so they stand alone — no published
declaration references a Bun global), and under `node16` as well as
`bundler` resolution; the JSDoc survived emit; the harness runs a test; a
real client joins a real server over a socket and receives state; and the
browser entry bundles with both `bun build --target=browser` and Vite with
no server code in the graph.

**Tree-shaking hides modules from an audit.** `sideEffects: false` is right
for users, and it means a library entry that nothing consumes is dead code:
bundling `client-js/src/index.ts` on its own dropped its graph from 50 inputs
to 17, losing `@bungohan/serializer` and `@msgpack/msgpack` — modules the
browser audit then never looked at. Both audits (this one and
`packages/client-js/src/browser-safety.test.ts`) therefore bundle through a
generated wrapper that assigns the entry's namespace to a global, which
nothing can shake out.

**The browser audit runs against both bundlers' module graphs**, not against
text. `@bungohan/core` is named in a couple of module-header comments that a
non-minifying bundler keeps, so matching the package name in the output says
nothing; Bun's `--metafile` and Vite's source-map `sources` say what actually
got bundled. Both were checked by importing `createBungohanServer` into the
fixture's browser entry and confirming both fail.
