# Reference: the main option objects

The four option objects you configure most, copied straight from the
source, so the defaults in their comments are the real ones. For
everything else, the types and their JSDoc (in your editor, or in each
package's `src/`) are the reference.

## `ServerOptions`

`createBungohanServer(options)` in `@bungohan/core`.

<!-- snippet: packages/core/src/types.ts#server-options -->
[`packages/core/src/types.ts`](../packages/core/src/types.ts)

```ts
/** `createBungohanServer`'s options. Every field is optional. */
export interface ServerOptions {
  /** Port only ever lives at `transport.config.port`. */
  transport?: {
    provider?: ITransport
    config?: {
      /** Default 6060. `0` picks a free port; `server.getPort()` says which. */
      port?: number
      maxPayloadLength?: number
      idleTimeout?: number
      compression?: boolean
      /** Smallest frame worth deflating, in bytes. Default 128. */
      compressionThreshold?: number
    }
  }
  /**
   * Where rooms' `saveState`/`loadState` go. `provider` takes any
   * `IStore`; `config` builds a Redis store (closed on `stop()`). Without
   * either, both calls are no-ops.
   */
  store?: {
    provider?: IStore
    config?: { url?: string; host?: string; port?: number; password?: string }
  }
  /**
   * Cluster mode. With `enabled`, rooms may live on any
   * process: matchmaking looks across the cluster, and a client connected
   * here can sit in a room that runs elsewhere. It needs a backplane.
   *
   * Every timing is measured on {@link ServerOptions.clock}, never on
   * wall-clock time, so tests drive them with a manual clock.
   */
  cluster?: {
    enabled?: boolean
    /** This process's id in the cluster. Default: a random nanoid. */
    processId?: string
    /**
     * Channel prefix, so unrelated clusters (or test runs) can share one
     * Redis. Default `"bungohan"`.
     */
    namespace?: string
    /** How often this process announces itself. Default 2,000 ms. */
    heartbeatInterval?: number
    /**
     * How long a process may be silent before peers drop it and end what
     * depended on it. Default 6,000 ms (three heartbeats).
     */
    peerTimeout?: number
    /** How long a directed request waits for its reply. Default 5,000 ms. */
    requestTimeout?: number
    /**
     * How long a broadcast (process info, room lookup, query) collects
     * answers. Default 200 ms.
     */
    gatherTimeout?: number
    backplane?: {
      provider?: IBackplane
      config?: { url?: string; host?: string; port?: number; password?: string }
    }
  }
  /** Room messages and envelope bodies. Default `MessagePackSerializer`. */
  serializer?: ISerializer
  /**
   * The rooms' codec: state sync and contract messages.
   * Default `SchemaCodec`; `MessagePackStateCodec` is inspectable, for
   * debugging.
   */
  stateCodec?: IStateCodec
  /** Off by default; when off, metrics cost nothing. */
  metrics?: { enabled?: boolean }
  /**
   * A small HTTP server on its own port: `GET /health`, `GET /metrics`
   * and `GET /rooms` (public rooms), each switchable. Off unless
   * `enabled`.
   */
  http?: {
    enabled?: boolean
    /** Default 8080. */
    port?: number
    /** Default `"0.0.0.0"`. */
    hostname?: string
    /** Default true. */
    cors?: boolean
    /** Default true. */
    enableMetrics?: boolean
    /** Default true. */
    enableHealthCheck?: boolean
    /** Default true. */
    enableRoomsList?: boolean
  }
  /** Default 60 steps per second. */
  simulation?: { tickRate?: number; maxCatchUpSteps?: number }
  /** Default 20 Hz. */
  sync?: { tickRate?: number }
  /**
   * What SIGTERM/SIGINT do: `stop()`, then `onShutdown`, then exit the
   * process.
   */
  gracefulShutdown?: {
    /** Milliseconds before a stuck shutdown exits with code 1. Default 30,000. */
    timeout?: number
    /** Runs after `stop()`, before the process exits. */
    onShutdown?: () => Promise<void>
    /** Install SIGTERM/SIGINT handlers in `start()`. Default true. */
    handleSignals?: boolean
  }
  /** Log level and destination. Default: `"info"` to the console. */
  logger?: LoggerOptions
  /** Time source for every loop and timeout. Default `SystemClock`. */
  clock?: Clock
  /**
   * Per-connection limits. On by default, with headroom a
   * normal game never reaches. `false` turns every limit off.
   */
  limits?: LimitOptions | false
}
```
<!-- /snippet -->

The ones you'll usually touch:

- `transport.config.port`: the WebSocket port. There is no top-level
  `port`.
- `simulation.tickRate` / `sync.tickRate`: see
  [production](guides/production.md#tick-rates).
- `limits`: see [below](#limitoptions).
- `metrics`, `http`, `gracefulShutdown`: see
  [production](guides/production.md).
- `store`: where `saveState`/`loadState` go
  ([rooms](guides/rooms.md#persistence)). `config` builds a Redis store,
  and `provider` takes any `IStore` (`MemoryStore` from `@bungohan/core`
  works for development).
- `cluster`: see [scaling](guides/scaling.md).

`stateCodec` and `serializer` choose the wire encodings. The defaults are
right for production, and the client accepts either state codec.
`MessagePackStateCodec` from `@bungohan/serializer` is easier to inspect
when you debug frames by hand.

## `LimitOptions`

`ServerOptions.limits`. What happens when each is passed is in
[production](guides/production.md#limits).

<!-- snippet: packages/core/src/types.ts#limit-options -->
[`packages/core/src/types.ts`](../packages/core/src/types.ts)

```ts
/**
 * Per-connection limits. Every number is a maximum, and `0`
 * means "no limit" for that one.
 */
export interface LimitOptions {
  /**
   * Outgoing bytes a connection may have queued. A client that stops
   * reading (a backgrounded tab, a stalled link) would otherwise grow the
   * server's memory without bound, because state patches can't simply be
   * dropped: they are deltas, so a skipped one desyncs that client for
   * good.
   */
  backpressure?: {
    /**
     * Above this, the client stops being sent state patches and gets a
     * fresh snapshot once it drains. Default 262,144 (256 KiB).
     */
    pauseBytes?: number
    /** Resume at or below this. Default 65,536 (64 KiB). */
    resumeBytes?: number
    /** Close (1013) above this, however briefly. Default 4,194,304 (4 MiB). */
    disconnectBytes?: number
    /** Close (1013) after this long paused. Default 15,000 ms. */
    maxPausedMs?: number
  }
  /** Incoming frames, counted per connection. */
  messages?: {
    /** Sustained frames per second. Default 200. */
    perSecond?: number
    /** Frames a burst may add on top of the sustained rate. Default 400. */
    burst?: number
    /** Sustained bytes per second. Default 1,048,576 (1 MiB). */
    bytesPerSecond?: number
  }
  /** `JOIN` frames, which are also what create rooms. */
  joins?: {
    /** Attempts per connection per minute. Default 60. */
    perMinute?: number
  }
}
```
<!-- /snippet -->

## `DefineRoomOptions`

The third argument of `server.defineRoomType(name, RoomClass, options)`.
A room can change `maxClients`, `autoDispose`, `allowReconnection`,
`reconnectionTimeout` and `metadata` on itself (they're public fields),
and visibility and locking with `makePrivate()`/`makePublic()` and
`lock()`/`unlock()`.

<!-- snippet: packages/core/src/types.ts#define-room-options -->
[`packages/core/src/types.ts`](../packages/core/src/types.ts)

```ts
/** Per room type (`defineRoomType`); every field is optional. */
export interface DefineRoomOptions {
  /** Default unlimited. */
  maxClients?: number
  /** Dispose when the last seat is released. Default true. */
  autoDispose?: boolean
  /** Hold a disconnected client's seat for reconnection. Default true. */
  allowReconnection?: boolean
  /** Seconds a held seat waits. Default 30. */
  reconnectionTimeout?: number
  /** Default `"public"`. */
  visibility?: "public" | "private"
  /** Default false. */
  locked?: boolean
  /**
   * Each new room's starting `metadata`, merged with the `metadata` of
   * its create options.
   */
  metadata?: Record<string, unknown>
  /** Seconds a reservation holds its seat. Default 60. */
  reservationTimeout?: number
}
```
<!-- /snippet -->

## `ClientOptions`

`createBungohanClient(options)` in `@bungohan/client-js`.

<!-- snippet: packages/client-js/src/client.ts#client-options -->
[`packages/client-js/src/client.ts`](../packages/client-js/src/client.ts)

```ts
/** `createBungohanClient`'s options. Only `url` is required. */
export interface ClientOptions {
  /** Server URL, e.g. `wss://game.example.com`. */
  url: string
  /** Sent as `?token=` (the server's `ConnectionContext.token`). */
  token?: string
  /**
   * Open the connection as soon as the client is created. Either way, a
   * join on a disconnected client connects first. Default `true`.
   */
  autoConnect?: boolean
  /** Default `{ enabled: true, maxAttempts: 10, delay: 1000, delayMax: 30000, factor: 2 }`. */
  reconnection?: Partial<ReconnectionOptions>
  /** Room messages. Must match the server's. Default MessagePack. */
  serializer?: ISerializer
  /**
   * State codecs this client can decode. The handshake names the room's;
   * one missing here fails the join with `CODEC_MISMATCH`.
   * Default: `[new SchemaCodec(), new MessagePackStateCodec()]`, so either
   * server setting works.
   */
  stateCodecs?: IStateCodec[]
  /** How connections are opened. Default: the platform `WebSocket`. */
  transport?: IClientTransport
  /** Timers for PING and reconnection. Default `SystemClock`. */
  clock?: Clock
  /** Milliseconds between PINGs (round-trip measurement); 0 disables. Default 5000. */
  pingInterval?: number
  /** A join the server hasn't answered by then fails with `TIMEOUT`; 0 disables. Default 10000. */
  joinTimeout?: number
  /** Where dropped frames and listener errors are reported. Default `console`. */
  logger?: ClientLogger
}
```
<!-- /snippet -->

`ReconnectionOptions` has `enabled`, `maxAttempts`, `delay`, `delayMax`
and `factor`: attempt *n* (from 0) waits `min(delay × factor^n,
delayMax)` ms. Pass only the ones you change. `serializer` must match the
server's.
