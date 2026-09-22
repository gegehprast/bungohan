# client-js and the React hooks

`@bungohan/client-js` is the browser client. It has no dependency on
Node or Bun APIs (it runs under Bun too), and its React bindings live at
`@bungohan/client-js/react`, which is the only entry point that imports
React.

## The client

<!-- snippet: docs/examples/src/client.ts#create -->
[`docs/examples/src/client.ts`](../examples/src/client.ts)

```ts
export function connect(url: string, token?: string): BungohanClient {
  return createBungohanClient({
    url, // ws:// or wss://
    token, // sent as ?token=…, read by the server's onAuth
    reconnection: { maxAttempts: 5 }, // the rest keeps its defaults
  })
}
```
<!-- /snippet -->

Create **one client per page** and share it. One connection can hold
seats in several rooms at once (a lobby and a game, say). The client
connects as soon as it's created (`autoConnect`), and a join on a
disconnected client connects first either way. The options and their
defaults are in the [reference](../reference.md#clientoptions).

`client.disconnect()` leaves every room and closes the connection.

### Leaving with the page

Without a leave, a closed or reloaded tab looks to the server like a
dropped connection: it holds that player's seat (and character) for the
reconnection timeout, 30 s by default. Opt in to leaving with the page
where you create the client:

<!-- snippet: docs/examples/src/client.ts#page-exit -->
[`docs/examples/src/client.ts`](../examples/src/client.ts)

```ts
export function connectThisPage(url: string): BungohanClient {
  const client = createBungohanClient({ url })
  // Closing, reloading or navigating away from the page gives every seat
  // up at once, instead of the server holding it for a reconnection.
  client.leaveOnPageExit()
  return client
}
```
<!-- /snippet -->

`leaveOnPageExit()` sends a `LEAVE` for every room and closes the
connection when the page is closed, reloaded or navigated away from. It
returns a function that removes its listeners. Outside a browser (Bun,
Node, a worker) it does nothing, so shared code can call it anywhere.

It listens for both `beforeunload` and `pagehide`, because neither alone
works everywhere ([why](../gotchas.md#pagehide-alone-doesnt-leave-on-a-firefox-reload)).
It never cancels `beforeunload`, so it never triggers the browser's
"leave this page?" prompt. If some other `beforeunload` handler of yours
does, and the player stays, the seats are already given up by then.

It's opt-in because it's a game design choice. Don't call it if a reload
should resume the seat instead ([below](#resuming-after-a-reload)).

## Joining

Every join takes the room type (or id), the options, and
`{ state, contract }`:

- `state` is your state class. The client builds its replica from it,
  and finds every class the state refers to through it.
- `contract` types and encodes messages and options. It also sends the
  contract's hash, so a stale client fails with `CONTRACT_MISMATCH`
  rather than mis-reading messages.

From these two values TypeScript infers the room's full type
(`IRoom<State, typeof contract>`), with no type arguments to write. A join
resolves once the first state snapshot has arrived, so `room.state` is
always filled in when you get the room.

Joins, like everything else that can fail, return a `Result`:

<!-- snippet: docs/examples/src/client.ts#errors -->
[`docs/examples/src/client.ts`](../examples/src/client.ts)

```ts
export async function enter(client: IBungohanClient, name: string) {
  const joined = await client.joinOrCreate(
    "arena",
    { create: { gems: 5 }, join: { name } },
    arena,
  )
  if (joined.isErr()) {
    // Every failure is a value, never a throw: a ClientError with a code.
    switch (joined.error.code) {
      case "ROOM_FULL":
        return "The arena is full."
      case "CONNECTION_FAILED":
        return "The server is unreachable."
      default:
        return `Could not join: ${joined.error.message}`
    }
  }
  return joined.value
}
```
<!-- /snippet -->

The error codes are the `ClientErrorCode` type. Besides the server's
refusals (`ROOM_FULL`, `AUTH_FAILED`, …) there are local ones:
`CONNECTION_FAILED`, `TIMEOUT` (no answer within `joinTimeout`),
`CODEC_MISMATCH`, `ENCODE_FAILED` and others.

## Listening to state

`room.state` is a replica: the same classes as on the server, updated in
place as patches arrive. You can read it whenever you like (each frame of
a render loop, for instance), or listen to it:

- `room.onStateChange(cb)` fires after every applied snapshot or patch.
- The wrappers' listeners (`onChange`, `onAdd`, `onRemove`, see
  [state](state.md#listening-to-changes)) fire per field and per element.

**The replica is replaced** by every snapshot: after a reconnection, or
when the server replaces its state or re-syncs a slow client. Keep the
`room`, not `room.state`, and register wrapper listeners through
`room.listen`, which re-runs on every new replica:

<!-- snippet: docs/examples/src/client.ts#listen -->
[`docs/examples/src/client.ts`](../examples/src/client.ts)

```ts
/** Mirrors players and gems into a game engine's scene. */
export function mirror(room: ArenaView, scene: Scene): () => void {
  // listen() runs now and again on every new replica (after a reconnect),
  // before its snapshot applies, so the snapshot's content arrives
  // through onAdd and nothing is missed or doubled.
  return room.listen((state) => {
    for (const [id, player] of state.players) scene.addPlayer(id, player)
    for (const [id, gem] of state.gems) scene.addGem(id, gem)
    const offs = [
      state.players.onAdd((player, id) => scene.addPlayer(id, player)),
      state.players.onRemove((_player, id) => scene.remove(`player:${id}`)),
      state.gems.onAdd((gem, id) => scene.addGem(id, gem)),
      state.gems.onRemove((_gem, id) => scene.remove(`gem:${id}`)),
    ]
    return () => {
      for (const off of offs) off()
      scene.clear() // this replica is gone; the next one re-adds everything
    }
  })
}

export interface Scene {
  addPlayer(id: string, player: Player): void
  addGem(id: number, gem: Gem): void
  remove(key: string): void
  clear(): void
}
```
<!-- /snippet -->

`listen(attach)` runs `attach` on the current replica straight away, and
again on each new one *before* its snapshot is applied. So on a new
replica the loops find nothing, and every element arrives through
`onAdd`. What `attach` returns runs when that replica is discarded, when
the room is left, or when you call the function `listen` returned.

Listeners fire after a whole patch is applied, in the order the changes
happened. An object created by the patch fires no listeners of its own:
its parent collection's `onAdd` sees it fully populated.

## Room and connection events

<!-- snippet: docs/examples/src/client.ts#room-events -->
[`docs/examples/src/client.ts`](../examples/src/client.ts)

```ts
export function watchRoom(room: ArenaView): void {
  room.onClientJoin(({ sessionId }) => console.log(`${sessionId} joined`))
  room.onClientLeave(({ sessionId }) => console.log(`${sessionId} left`))
  room.onError((code, message) => console.log(`room error ${code}: ${message}`))
  room.onLeave((code) => {
    // Every listener on the room is removed right after this one runs.
    if (code === LeaveCode.KICKED) console.log("you were kicked")
    else if (code === LeaveCode.DISCONNECTED) console.log("could not resume")
  })
}
```
<!-- /snippet -->

`onLeave` receives a `LeaveCode`: `CONSENTED` (1000, you left),
`DISCONNECTED` (1001, the seat couldn't be resumed), `KICKED` (4000),
`SERVER_SHUTDOWN` (4001) or `ROOM_DISPOSED` (4002). **When a room is
left, every listener on it is removed**, right after the `onLeave`
callbacks run, so there is nothing to clean up.

`room.onError(code, message)` reports errors for this room. That includes
`DESYNC` (a patch that couldn't be applied, after which the client
re-syncs by reconnecting) and `UNKNOWN_CLASS` (the server sent a class
this client has no class for, usually a subclass it doesn't import).

<!-- snippet: docs/examples/src/client.ts#connection-events -->
[`docs/examples/src/client.ts`](../examples/src/client.ts)

```ts
export function watchConnection(client: IBungohanClient): () => void {
  const offs = [
    client.onDisconnect(() => console.log("connection lost, retrying…")),
    client.onReconnect(() => console.log("reconnected; resuming rooms")),
    client.onError((error) => console.log(`client error ${error.code}`)),
  ]
  return () => {
    for (const off of offs) off()
  }
}
```
<!-- /snippet -->

When the connection drops unexpectedly, the client retries with
exponential backoff (1 s, 2 s, 4 s, … up to 30 s, 10 attempts by default)
and resumes every held seat with a fresh snapshot. Meanwhile each room's
`status` is `"reconnecting"`, and `send` fails with `NOT_CONNECTED`
(nothing is queued). If it gives up, each room is left with
`DISCONNECTED`, and `client.onError` reports `RECONNECTION_FAILED`.

`client.connectionState` and `client.latency` (the last measured round
trip, in ms) are there for a status indicator.

## Resuming after a reload

A reload loses the page's client, but the server still holds the seat
for a while. Save the room id and its current reconnection token, and
hand them to `client.reconnect` on the next load:

<!-- snippet: docs/examples/src/client.ts#reload -->
[`docs/examples/src/client.ts`](../examples/src/client.ts)

```ts
/** Remembers the seat, so a page reload can take it back. */
export function remember(room: ArenaView, storage: Storage): void {
  const save = () => {
    const token = room.reconnectionToken // replaced on every (re)join
    if (token !== undefined) {
      storage.setItem("seat", JSON.stringify({ roomId: room.id, token }))
    }
  }
  save()
  room.onStateChange(save)
  room.onLeave((code) => {
    // 1001 means this client lost the connection: the server may still
    // hold the seat. Any other code means the seat is gone.
    if (code !== LeaveCode.DISCONNECTED) storage.removeItem("seat")
  })
}

/** After a reload: resume the held seat, if it's still held. */
export async function resume(client: IBungohanClient, storage: Storage) {
  const saved = storage.getItem("seat")
  if (saved === null) return undefined
  const { roomId, token } = JSON.parse(saved) as {
    roomId: string
    token: string
  }
  const resumed = await client.reconnect(roomId, token, arena)
  if (resumed.isErr()) storage.removeItem("seat") // expired: join afresh
  return resumed.isOk() ? resumed.value : undefined
}
```
<!-- /snippet -->

The token is replaced on every successful join and reconnection, and the
old one stops working, so keep saving the current one.

Put together on page load, with `sessionStorage` (one per tab, kept
across a reload):

<!-- snippet: docs/examples/src/client.ts#resumable -->
[`docs/examples/src/client.ts`](../examples/src/client.ts)

```ts
/** On page load, in a game where a reload keeps the seat. */
export async function start(
  client: IBungohanClient, // created without leaveOnPageExit()
  name: string,
  storage: Storage = sessionStorage, // per tab; survives a reload
) {
  const room = (await resume(client, storage)) ?? (await enter(client, name))
  if (typeof room !== "string") remember(room, storage)
  return room
}
```
<!-- /snippet -->

**Don't call `leaveOnPageExit()` in a game like this.** It would give the
seat up as the page unloads, and the reload would find nothing to resume.
The price is that a tab closed for good also leaves its seat held until
the reconnection timeout, as if the connection had dropped. Keep
[`reconnectionTimeout`](rooms.md#reconnection) as short as the game can
afford.

## The React hooks

| Export | What it does |
|---|---|
| `<BungohanProvider client>` | provides one client to the tree |
| `useBungohan()` | returns that client (throws outside a provider) |
| `useRoom(type, options, mode, join)` | joins on mount, leaves on unmount |
| `useRoomState(room, selector?, isEqual?)` | reads state, re-rendering when it changes |
| `useRoomMessage(room, type, callback)` | subscribes to one contract message |

The [tutorial](../tutorial.md#6-the-same-client-in-react) walks through
all of them. The points worth knowing:

- **`useRoom`** returns `{ room, status, error?, leaveCode? }`, with
  `status` going `connecting` → `connected`, or `error`, or `left` when
  the server ended the room. `mode` is `"joinOrCreate"` (default),
  `"create"`, `"join"` or `"joinById"` (the first argument is then a room
  id). It rejoins only when `roomType` or `mode` change: `options` and
  `join` are read when the join starts.
- **`useRoomState(room)`** without a selector re-renders on every state
  frame. With a selector, it re-renders only when the selected value
  changes, compared with `shallowEqual` (arrays and objects one level
  deep), or with the function you pass third. Select plain values:

<!-- snippet: docs/examples/src/react.tsx#selectors -->
[`docs/examples/src/react.tsx`](../examples/src/react.tsx)

```tsx
export function Hud({ room }: { room: Arena }) {
  // Select plain values; this re-renders only when one of them changes.
  const players = useRoomState(room, (state) => state.players.size)
  const gems = useRoomState(room, (state) => state.gems.size)
  // Arrays of primitives are compared element by element (shallowEqual).
  const names = useRoomState(room, (state) =>
    [...state.players.values()].map((p) => p.name.get()),
  )
  const [last, setLast] = useState<string>()
  useRoomMessage(room, "gemCollected", ({ sessionId }) => setLast(sessionId))

  return (
    <p>
      {players} players ({names?.join(", ")}), {gems} gems, last pickup:{" "}
      {last ?? "none"}
    </p>
  )
}
```
<!-- /snippet -->

- **`useRoomMessage`** always calls the latest callback, and still
  receives messages the room sent during `onJoin`, although React
  subscribes after the join resolves.
- For values that change every frame (positions), don't re-render at
  all: draw from `room.state` in an animation loop.

### React and StrictMode

In development, `<StrictMode>` mounts each component, unmounts it, and
mounts it again. `useRoom` therefore starts **two joins**. The first
resolves after its component was unmounted, so it gives its seat straight
back:

- with `"joinOrCreate"` (the default), both joins land in the same room.
  Other players briefly see a second copy of you join and leave, and
  `onJoin`/`onLeave` run for it.
- with `"create"`, it **creates two rooms**. The first is left at once
  and, being empty, disposes itself, but its `onCreate` ran, and a room
  registered with `autoDispose: false` would stay.

<!-- snippet: docs/examples/src/react.tsx#strict-mode-problem -->
[`docs/examples/src/react.tsx`](../examples/src/react.tsx)

```tsx
/**
 * Under <StrictMode>, React mounts, unmounts and mounts again in
 * development, so this creates TWO rooms: the first join's seat is given
 * back, and the empty room disposes itself. Prefer the pattern below.
 */
export function CreateOnMount({ name }: { name: string }) {
  const created = useRoom(
    "arena",
    { create: { gems: 5 }, join: { name } },
    "create",
    arena,
  )
  return <p>{created.status}</p>
}
```
<!-- /snippet -->

Production builds mount once, so this only affects development. For
`"create"`, call `client.create` from an event handler instead, and pass
the room down:

<!-- snippet: docs/examples/src/react.tsx#strict-mode-fix -->
[`docs/examples/src/react.tsx`](../examples/src/react.tsx)

```tsx
/** Create from an event, not an effect: it runs once, StrictMode or not. */
export function CreateOnClick({ name }: { name: string }) {
  const client = useBungohan()
  const [room, setRoom] = useState<Arena>()
  const [error, setError] = useState<string>()

  const create = async () => {
    const created = await client.create(
      "arena",
      { create: { gems: 5 }, join: { name } },
      arena,
    )
    if (created.isErr()) setError(created.error.message)
    else setRoom(created.value)
  }

  // We own this seat now, so we leave it ourselves.
  useEffect(() => () => void room?.leave(), [room])

  if (room !== undefined) return <Hud room={room} />
  return (
    <button type="button" onClick={create}>
      {error ?? "Create a room"}
    </button>
  )
}
```
<!-- /snippet -->

Both behaviors are pinned by
[`docs/examples/src/react.test.ts`](../examples/src/react.test.ts).

## Next

- [Testing](testing.md)
- [Gotchas](../gotchas.md)
