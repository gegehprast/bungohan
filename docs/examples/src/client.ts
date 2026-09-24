import {
  type BungohanClient,
  createBungohanClient,
  type IBungohanClient,
  LeaveCode,
} from "@bungohan/client-js"
import {
  ArenaState,
  arenaContract,
  type Gem,
  type Player,
} from "@bungohan/tutorial-shared"

// #region create
export function connect(url: string, token?: string): BungohanClient {
  return createBungohanClient({
    url, // ws:// or wss://
    token, // sent as ?token=…, read by authenticate and onAuth
    reconnection: { maxAttempts: 5 }, // the rest keeps its defaults
  })
}
// #endregion create

// #region page-exit
export function connectThisPage(url: string): BungohanClient {
  const client = createBungohanClient({ url })
  // Closing, reloading or navigating away from the page gives every seat
  // up at once, instead of the server holding it for a reconnection.
  client.leaveOnPageExit()
  return client
}
// #endregion page-exit

// #region connection-events
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
// #endregion connection-events

const arena = { state: ArenaState, contract: arenaContract }

// #region errors
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
// #endregion errors

export type ArenaView = Exclude<Awaited<ReturnType<typeof enter>>, string>

// #region listen
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
// #endregion listen

// #region room-events
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
// #endregion room-events

// #region reload
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
// #endregion reload

// #region resumable
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
// #endregion resumable
