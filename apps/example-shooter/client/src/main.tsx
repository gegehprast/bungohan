import { createBungohanClient } from "@bungohan/client-js"
import { BungohanProvider } from "@bungohan/client-js/react"
import {
  Bullet,
  DEFAULT_SERVER_PORT,
  Enemy,
  Loot,
  Player,
  RoomInfo,
} from "@bungohan/example-shooter-shared"
import { SchemaRegistry } from "@bungohan/state"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { App } from "./App"
import "./index.css"

// The client only ever receives these classes (inside the rooms' maps) and
// never constructs one, so they don't auto-register. Unregistered, their
// instances would be dropped from the replica without an error.
SchemaRegistry.register(Player, Enemy, Bullet, Loot, RoomInfo)

const url =
  import.meta.env.VITE_SERVER_URL ??
  `ws://${window.location.hostname}:${DEFAULT_SERVER_PORT}`
const client = createBungohanClient({ url })
// Closing the tab is leaving, not a dropped connection the server should
// hold a seat (and a motionless player) for.
window.addEventListener("pagehide", () => void client.disconnect())

const root = document.getElementById("root")
if (root === null) throw new Error("index.html has no #root element")

createRoot(root).render(
  <StrictMode>
    <BungohanProvider client={client}>
      <App />
    </BungohanProvider>
  </StrictMode>,
)
