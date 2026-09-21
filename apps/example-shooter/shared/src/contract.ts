/**
 * Message contracts (spec §4.1). The server binds them to its rooms and the
 * client passes the same objects at join, so names and payloads are checked
 * at compile time on both sides, and a stale client fails its join with
 * `CONTRACT_MISMATCH` instead of mis-decoding.
 */
import { defineContract, defineMessage, f, type Infer } from "@bungohan/types"

// ============================================================================
// Shooter room
// ============================================================================

/** Client → server, whenever the player's controls change. */
export const Input = defineMessage("input", {
  up: f.bool,
  down: f.bool,
  left: f.bool,
  right: f.bool,
  /** Aim, in radians. */
  rotation: f.fixed(2),
  shooting: f.bool,
})
export type PlayerInput = Infer<typeof Input>

export const Ready = defineMessage("ready", { isReady: f.bool })
export const StartGame = defineMessage("startGame", {})

export const PlayerJoined = defineMessage("playerJoined", {
  playerId: f.string,
  playerName: f.string,
})
export const PlayerLeft = defineMessage("playerLeft", { playerId: f.string })
export const GameStarted = defineMessage("gameStarted", {})

/** One row of the final standings (nested in `gameEnded`). */
export const GameResult = defineMessage("gameResult", {
  playerId: f.string,
  playerName: f.string,
  score: f.int32,
  rank: f.uint8,
  color: f.string,
})
export type GameResult = Infer<typeof GameResult>

export const GameEnded = defineMessage("gameEnded", {
  results: f.array(f.nested(GameResult)),
})

/**
 * Typed options (spec §4.1.2): the settings a shooter room is created with,
 * sent only by the client that creates it…
 */
export const ShooterCreateOptions = defineMessage("shooterCreateOptions", {
  roomName: f.optional(f.string),
  maxPlayers: f.uint8,
  isPrivate: f.bool,
})

/** …and what every player tells the room when joining. */
export const ShooterJoinOptions = defineMessage("shooterJoinOptions", {
  playerName: f.string,
})

export const shooterContract = defineContract({
  client: { input: Input, ready: Ready, startGame: StartGame },
  server: {
    playerJoined: PlayerJoined,
    playerLeft: PlayerLeft,
    gameStarted: GameStarted,
    gameEnded: GameEnded,
  },
  options: { create: ShooterCreateOptions, join: ShooterJoinOptions },
})

// ============================================================================
// Lobby room
// ============================================================================

export const RefreshRooms = defineMessage("refreshRooms", {})
export const JoinByCode = defineMessage("joinByCode", { roomCode: f.string })
export const RoomFound = defineMessage("roomFound", { roomId: f.string })
export const LobbyError = defineMessage("error", { message: f.string })

export const lobbyContract = defineContract({
  client: { refreshRooms: RefreshRooms, joinByCode: JoinByCode },
  server: { roomFound: RoomFound, error: LobbyError },
})
