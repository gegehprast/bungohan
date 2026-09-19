import { createBungohanClient } from "@bungohan/client-js"
import { BungohanProvider } from "@bungohan/client-js/react"
import { DEFAULT_SERVER_PORT } from "@bungohan/example-shooter-shared"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { App } from "./App"
import "./index.css"

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
