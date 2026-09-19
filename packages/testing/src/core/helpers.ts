import type {
  DefineRoomOptions,
  ErrorContext,
  ServerOptions,
} from "@bungohan/core"
import type { TestClient, TestRoom } from "../driver"
import { createServerHarness, type ServerHarness } from "../harness"
import {
  calls,
  GameRoom,
  GameState,
  gameContract,
  resetFaults,
} from "./fixtures"

export type GameView = TestRoom<GameState, typeof gameContract>

export interface Setup {
  h: ServerHarness
  errors: [Error, ErrorContext][]
  /** Connects and joins "game" (joinOrCreate), unwrapping the result. */
  join(client?: TestClient): Promise<GameView>
}

export async function setup(
  room: DefineRoomOptions = {},
  server: Omit<ServerOptions, "transport" | "clock"> = {},
): Promise<Setup> {
  resetFaults()
  calls.length = 0
  const h = await createServerHarness({
    server,
    define: (s) => s.defineRoomType("game", GameRoom, room),
  })
  const errors: [Error, ErrorContext][] = []
  h.server.onError((error, context) => errors.push([error, context]))
  return {
    h,
    errors,
    async join(client = h.connect()) {
      const joined = await client.joinOrCreate(
        "game",
        {},
        {
          state: GameState,
          contract: gameContract,
        },
      )
      return joined.unwrap()
    },
  }
}

/** The server-side room behind a view. */
export function serverRoom(
  h: ServerHarness,
  view: { roomId: string },
): GameRoom {
  const room = h.server.getMatchMaker().getRoom(view.roomId)
  if (!(room instanceof GameRoom)) throw new Error("no such game room")
  return room
}

/** Frame type byte of every frame a client received. */
export function frameTypes(client: TestClient): number[] {
  return client.frames.map((frame) => frame[0] ?? -1)
}
