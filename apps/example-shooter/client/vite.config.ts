import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // One React for the app and for @bungohan/client-js/react, a workspace
  // package that resolves react from its own node_modules.
  resolve: { dedupe: ["react", "react-dom"] },
})
