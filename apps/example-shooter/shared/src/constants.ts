/** Game constants, shared by the server's systems and the client's renderer. */
export const GAME_CONFIG = {
  // Lobby
  /** How often the lobby rescans the shooter rooms, in ms. */
  LOBBY_REFRESH_MS: 1000,
  ROOM_CODE_LENGTH: 6,
  ROOM_CODE_CHARS: "ABCDEFGHJKLMNPQRSTUVWXYZ23456789", // No I, O, 0, 1
  MAX_ROOM_NAME_LENGTH: 30,
  MAX_PLAYER_NAME_LENGTH: 20,

  // Room
  MIN_PLAYERS: 1, // Minimum to start a game (1 for testing, 2 for production)
  MAX_PLAYERS: 8,
  AUTO_START_DELAY_MS: 5000, // Countdown once the room is full
  RESULTS_DURATION_MS: 10_000, // How long a finished game shows before resetting

  // Arena
  ARENA_WIDTH: 1000,
  ARENA_HEIGHT: 600,

  // Player
  PLAYER_SIZE: 20,
  PLAYER_SPEED: 200, // pixels per second
  PLAYER_ROTATION_SPEED: 5, // radians per second
  PLAYER_MAX_HEALTH: 100,
  PLAYER_FIRE_RATE_MS: 250, // between shots
  PLAYER_KILL_SCORE: 50,
  PLAYER_COLORS: [
    "#8b5cf6", // Purple
    "#10b981", // Emerald
    "#ef4444", // Red
    "#06b6d4", // Cyan
    "#6366f1", // Indigo
    "#f59e0b", // Amber
    "#ec4899", // Pink
    "#84cc16", // Lime
  ] as const,

  // Enemy
  ENEMY_SIZE: 15,
  ENEMY_SPAWN_RATE_MS: 2000,
  ENEMY_MAX_COUNT: 20,
  ENEMY_HEALTH: 50,
  ENEMY_SCORE: 10,
  ENEMY_FIRE_RATE_MS: 2000, // between volleys
  ENEMY_BULLETS_PER_SHOT: 3, // bullets per volley
  ENEMY_BULLET_SPEED: 200, // pixels per second (half the player bullet speed)

  // Bullet
  BULLET_SIZE: 4,
  BULLET_SPEED: 400, // pixels per second
  BULLET_DAMAGE: 25,
  BULLET_LIFETIME_MS: 3000,

  // Loot
  LOOT_SIZE: 10,
  LOOT_VALUE: 10,
  LOOT_COLLECTION_RADIUS: 30,
  LOOT_LIFETIME_MS: 10_000, // before it despawns

  // Game
  GAME_DURATION_S: 60,
  WIN_SCORE: 100,

  // Tick rates (server-wide: see server/src/index.ts)
  SIMULATION_TICK_RATE: 60, // steps per second
  STATE_SYNC_RATE: 30, // state frames per second
} as const

export type GameConfig = typeof GAME_CONFIG

/** The server's default port (the framework's default, spec §6.8.5). */
export const DEFAULT_SERVER_PORT = 6060

/** Owner id of bullets fired by enemies. */
export const ENEMY_OWNER = "enemy"

/** Room type names, as the server defines them and clients join them. */
export const ROOM_TYPE = { LOBBY: "lobby", SHOOTER: "shooter" } as const
