# @bungohan/types

The wire-protocol vocabulary of [Bungohan](../../docs/README.md): the
numeric field kinds (`f.uint8`, `f.fixed2`, …), the state operations, the
frame and handshake shapes, and the typed message contracts built with
`defineMessage` and `defineContract`.

```sh
bun add @bungohan/types
```

You normally don't install this directly. Game code imports
[`@bungohan/schema`](../schema/README.md), which re-exports the parts you
declare state and messages with; [`@bungohan/core`](../core/README.md) and
[`@bungohan/client-js`](../client-js/README.md) re-export them too.

Install it on its own when you're implementing the protocol — a transport,
a serializer, or a client for another engine. It is pure types plus a few
small helpers, safe in a browser, and depends on nothing.

The bytes themselves are specified in `PROTOCOL.md`, not here. See the
[state guide](../../docs/guides/state.md) for what the field kinds cost.
