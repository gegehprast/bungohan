# @bungohan/result

The `Result<T, E>` type used across [Bungohan](../../docs/README.md). Any
framework operation that can fail returns one instead of throwing, so the
failure is part of the signature and the compiler makes you handle it.

```sh
bun add @bungohan/result
```

So `await server.start()` hands back a result you check with `isErr()`
before using `.value`, rather than a promise you have to remember to wrap.
Build one with `ok(value)` or `err(error)`, and wrap a throwing API with
`tryCatch` / `tryCatchAsync`. Nothing here is Bungohan-specific, and it has
no dependencies.

Framework code never throws, with two exceptions: your own lifecycle hooks
may throw (the framework catches and logs), and a malformed schema or
message declaration throws once, when the module that declares it loads.
See [Gotchas](../../docs/gotchas.md).
