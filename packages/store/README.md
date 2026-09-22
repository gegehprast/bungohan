# @bungohan/store

The key-value store [Bungohan](../../docs/README.md) keeps room metadata and
seat reservations in: an in-memory implementation for a single process, and
a Redis one (on Bun's own `RedisClient`) for a cluster.

```sh
bun add @bungohan/store
```

Requires Bun 1.3.3 or newer. [`@bungohan/core`](../core/README.md) depends
on it; you choose the implementation `store: new RedisStore({ url })` for a cluster,
the default `MemoryStore` for one process.

Implement `IStore` to back it with something else. See the
[cluster mode guide](../../docs/guides/scaling.md).
