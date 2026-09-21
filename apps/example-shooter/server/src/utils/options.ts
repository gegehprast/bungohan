/**
 * Join and create options are typed by `shooterContract` and decoded
 * against it before a hook runs, so their shape is guaranteed: a
 * `playerName` is a string, `maxPlayers` an integer 0–255. What they
 * *mean* is still game logic, and the values are still the client's, so
 * they're clamped here: a name's length, a blank name, the player count.
 */
import {
  GAME_CONFIG,
  type GameStatus,
  type ShooterListing,
  type ShooterSettings,
} from "@bungohan/example-shooter-shared"
import { clamp } from "./physics"

function text(value: string | undefined, fallback: string, max: number) {
  const trimmed = value?.trim() ?? ""
  return trimmed === "" ? fallback : trimmed.slice(0, max)
}

/** A player name as the game shows it: trimmed, not blank, not too long. */
export function playerName(name: string, fallback: string): string {
  return text(name, fallback, GAME_CONFIG.MAX_PLAYER_NAME_LENGTH)
}

/** A new room's settings, within the game's limits. */
export function roomSettings(
  settings: ShooterSettings,
): Required<ShooterSettings> {
  return {
    roomName: text(
      settings.roomName,
      "Game Room",
      GAME_CONFIG.MAX_ROOM_NAME_LENGTH,
    ),
    maxPlayers: clamp(settings.maxPlayers, 1, GAME_CONFIG.MAX_PLAYERS),
    isPrivate: settings.isPrivate,
  }
}

const STATUSES: readonly GameStatus[] = ["waiting", "playing", "finished"]

/**
 * A shooter room's `metadata` as the lobby reads it back. Metadata is the
 * matchmaker's untyped listing data, not part of any contract, so this one
 * is still narrowed by hand.
 */
export function parseListing(
  metadata: Record<string, unknown>,
): ShooterListing | undefined {
  const { name, code, hostName, status } = metadata
  const known = STATUSES.find((s) => s === status)
  if (
    typeof name !== "string" ||
    typeof code !== "string" ||
    typeof hostName !== "string" ||
    known === undefined
  ) {
    return undefined
  }
  return { name, code, hostName, status: known }
}
