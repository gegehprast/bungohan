# @bungohan/client-js

The browser client of [Bungohan](../../docs/README.md), an authoritative
multiplayer game server framework for Bun. It joins rooms, sends typed
messages, keeps a live copy of each room's state, and reconnects on its
own. React hooks are at `@bungohan/client-js/react`.

```sh
bun add @bungohan/client-js@alpha @bungohan/schema@alpha
```

Published at `0.1.0-alpha.4` on the `alpha` tag. `react` (18 or newer)
is an optional peer dependency, needed only for
`@bungohan/client-js/react`.

<!-- snippet: docs/examples/src/getting-started/client.ts#client -->
[`docs/examples/src/getting-started/client.ts`](../../docs/examples/src/getting-started/client.ts)

```ts
import { createBungohanClient } from "@bungohan/client-js"
import { CounterState, counterContract } from "./shared"

const url = process.env["SERVER_URL"] ?? "ws://localhost:6060"
const client = createBungohanClient({ url })

const joined = await client.joinOrCreate("counter", undefined, {
  state: CounterState,
  contract: counterContract,
})
if (joined.isErr()) throw joined.error
const room = joined.value

room.state.count.onChange((count) => {
  console.log(`count is now ${count}`)
  if (count >= 3) void client.disconnect()
})

for (let i = 0; i < 3; i++) room.send("increment", { by: 1 })
```
<!-- /snippet -->

`CounterState` and `counterContract` come from a module the server
imports too: see [Getting started](../../docs/getting-started.md).

## Documentation

- [client-js and the React hooks](../../docs/guides/client.md)
- [Getting started](../../docs/getting-started.md) and the
  [tutorial](../../docs/tutorial.md), which builds a vanilla and a React
  client
- [Messages](../../docs/guides/messages.md),
  [join options](../../docs/guides/options.md),
  [state](../../docs/guides/state.md)
- [Gotchas](../../docs/gotchas.md) and the
  [option reference](../../docs/reference.md#clientoptions)

The server is [`@bungohan/core`](../core/README.md).
