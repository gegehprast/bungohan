import { createRoot } from "react-dom/client"
// Through `browser`, so Vite's graph covers exactly what the bun audit does.
import { App, CounterState, createBungohanClient } from "./browser"

const root = document.getElementById("root")
if (root !== null) createRoot(root).render(<App />)
console.log(createBungohanClient, CounterState)
