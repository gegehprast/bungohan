# @bungohan/state

The state engine of [Bungohan](../../docs/README.md): schema classes whose
fields are created with factories, change tracking, and the binary encoder
and decoder that turn a frame's changes into a few bytes on the wire.

```sh
bun add @bungohan/state
```

Game code doesn't import this directly — it imports
[`@bungohan/schema`](../schema/README.md), which re-exports `Schema` and the
factories. Install it explicitly only if you need the runtime pieces
(`SchemaRegistry`, the encoder, the decoder) or are building a client.

**Exactly one copy per app.** A second copy means a second `Schema` class,
which splits `instanceof` and the schema registry, and state stops syncing.
`@bungohan/core`, `@bungohan/client-js` and `@bungohan/schema` therefore
take it as an exact-version peer dependency: install one version of it and
matching versions of them.

See the [state guide](../../docs/guides/state.md) for schemas, collections,
filtering and what each field kind costs.
