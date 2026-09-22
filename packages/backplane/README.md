# @bungohan/backplane

The pub/sub backplane [Bungohan](../../docs/README.md) processes talk to each
other over in cluster mode: an in-memory implementation for one process, and
a Redis one (on Bun's own `RedisClient`) for many.

```sh
bun add @bungohan/backplane
```

Requires Bun 1.3.3 or newer. [`@bungohan/core`](../core/README.md) depends on
it; you choose the implementation `backplane: new RedisBackplane({ url })`
for a cluster, the default `MemoryBackplane` for one process.

Implement `IBackplane` to back it with something else. See the
[cluster mode guide](../../docs/guides/scaling.md).
