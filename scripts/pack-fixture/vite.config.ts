import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [react()],
  // The source maps are the module graph the audit reads.
  build: { minify: false, sourcemap: true },
})
