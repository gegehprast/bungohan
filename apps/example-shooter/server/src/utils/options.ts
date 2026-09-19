/**
 * Join options arrive untyped (they aren't part of the contract) and come
 * from the client, so they're narrowed and clamped here.
 */
import {
  type CreateShooterOptions,
  GAME_CONFIG,
  type GameStatus,
  type JoinShooterOptions,
  type ShooterListing,
} from "@bungohan/example-shooter-shared"
import { clamp } from "./physics"

function text(value: unknown, fallback: string, maxLength: number): string {
  const trimmed = typeof value === "string" ? value.trim() : ""
  return trimmed === "" ? fallback : trimmed.slice(0, maxLength)
}

export function parseJoinOptions(
  options: Record<string, unknown>,
  fallbackName: string,
): JoinShooterOptions {
  return {
    playerName: text(
      options["playerName"],
      fallbackName,
      GAME_CONFIG.MAX_PLAYER_NAME_LENGTH,
    ),
  }
}

export function parseCreateOptions(
  options: Record<string, unknown>,
): CreateShooterOptions {
  const maxPlayers = options["maxPlayers"]
  return {
    ...parseJoinOptions(options, "Host"),
    roomName: text(
      options["roomName"],
      "Game Room",
      GAME_CONFIG.MAX_ROOM_NAME_LENGTH,
    ),
    maxPlayers:
      typeof maxPlayers === "number" && Number.isFinite(maxPlayers)
        ? clamp(Math.floor(maxPlayers), 1, GAME_CONFIG.MAX_PLAYERS)
        : GAME_CONFIG.MAX_PLAYERS,
    isPrivate: options["isPrivate"] === true,
  }
}

const STATUSES: readonly GameStatus[] = ["waiting", "playing", "finished"]

/** A shooter room's `metadata` as the lobby reads it back. */
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
