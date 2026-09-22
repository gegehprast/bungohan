# @bungohan/serializer

The codecs [Bungohan](../../docs/README.md) puts on the wire: the frame
header, the message codec (a compact binary one driven by the contract, and
a JSON one for debugging), and the state-delta codec.

```sh
bun add @bungohan/serializer
```

A server or client already pulls this in; install it directly only to
choose a serializer explicitly or to implement `ISerializer` yourself.

Pass `serializer: { messages: "json" }` to `createBungohanServer` for
readable frames while debugging, and leave it alone in production.

It runs in a browser as well as on Bun. See the
[option reference](../../docs/reference.md) for the serializer options and
the [state guide](../../docs/guides/state.md) for what ends up in a patch.
