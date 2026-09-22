# @bungohan/transport

The WebSocket transport of [Bungohan](../../docs/README.md), built on
`Bun.serve()`. It accepts connections, negotiates the subprotocol, and
hands core a socket it can write binary frames to.

```sh
bun add @bungohan/transport
```

Requires Bun 1.3.3 or newer. [`@bungohan/core`](../core/README.md) depends
on it and configures it so `transport: { config: { port: 6060 } }`
is all a normal server needs.

Install it directly only to implement `ITransport` against it, or to serve
your own HTTP routes from the same server. See the
[production guide](../../docs/guides/production.md) and the
[option reference](../../docs/reference.md).
