import { GAME_CONFIG } from "@bungohan/example-shooter-shared"

/** A random room code, e.g. "K7QX2M". Skips look-alikes (I, O, 0, 1). */
export function generateRoomCode(): string {
  const chars = GAME_CONFIG.ROOM_CODE_CHARS
  let code = ""
  for (let i = 0; i < GAME_CONFIG.ROOM_CODE_LENGTH; i++) {
    code += chars[Math.floor(Math.random() * chars.length)] ?? ""
  }
  return code
}
