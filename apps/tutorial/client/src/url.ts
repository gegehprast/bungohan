import { DEFAULT_PORT } from "@bungohan/tutorial-shared"

/** The game server: port 6060 on the host that served the page. */
export const SERVER_URL = `ws://${window.location.hostname}:${DEFAULT_PORT}`

/** `?name=` from the page URL, for trying several tabs. */
export function playerName(): string {
  return new URLSearchParams(window.location.search).get("name") ?? "Player"
}
