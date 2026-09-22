import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    // C: is nearly full on this machine — build output (which includes the
    // ~500MB bundled model from public/models) goes to D: instead. See
    // PROJECT_LOG.md for how to adjust this on a machine with more C: space.
    outDir: 'D:/claimsense-build-output',
    emptyOutDir: true,
  },
})
