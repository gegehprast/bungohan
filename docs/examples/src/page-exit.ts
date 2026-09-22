import type { IBungohanClient, IRoom } from "@bungohan/client-js"

export function pagehideOnly(client: IBungohanClient): void {
  // #region pagehide-only
  // ✗ pagehide alone: on a reload, Firefox never sends what this sends.
  window.addEventListener("pagehide", () => void client.disconnect())
  // #endregion pagehide-only
}

/** Leaves one room with the page, keeping any others. */
export function leaveWithThePage(room: IRoom): () => void {
  // #region own-handler
  // ✓ Both events, the first one wins, and LEAVE goes out before any await.
  let left = false
  const leave = () => {
    if (left) return
    left = true
    void room.leave() // sent before leave() returns; don't await first
  }
  window.addEventListener("beforeunload", leave)
  window.addEventListener("pagehide", leave)
  // #endregion own-handler
  return () => {
    window.removeEventListener("beforeunload", leave)
    window.removeEventListener("pagehide", leave)
  }
}
