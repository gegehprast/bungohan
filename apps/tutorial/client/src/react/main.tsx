// #region provider
import { createBungohanClient } from "@bungohan/client-js"
import { BungohanProvider } from "@bungohan/client-js/react"
import { createRoot } from "react-dom/client"
import { playerName, SERVER_URL } from "../url"
import { App } from "./App"

// One client for the whole app, created outside React so a re-render
// never opens a second connection.
const client = createBungohanClient({ url: SERVER_URL })
window.addEventListener("pagehide", () => void client.disconnect())

const root = document.getElementById("root")
if (root === null) throw new Error("react.html has no #root element")

createRoot(root).render(
  <BungohanProvider client={client}>
    <App name={playerName()} />
  </BungohanProvider>,
)
// #endregion provider
