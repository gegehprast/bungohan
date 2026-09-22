# @bungohan/schema

The definitions a [Bungohan](../../docs/README.md) game shares between its
server and its browser client: state schemas (`Schema` and the field
factories) and message contracts (`defineMessage`, `defineContract`, `f`).

```sh
bun add @bungohan/schema
```

Put your state classes and contract in one module that imports only this
package, and import that module from both sides. It contains no server code,
so it's safe to ship to a browser, and it means your server never depends on
the client package (or the client on the server's).

`@bungohan/core` and `@bungohan/client-js` re-export everything here, so a
file that belongs to only one side can keep importing from its own package.

See the [getting started guide](../../docs/getting-started.md) and the
[state guide](../../docs/guides/state.md).
