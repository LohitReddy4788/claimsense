import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      // Phase 17b (optional/stretch): lets the app shell itself install
      // and launch with zero network, a STRONGER claim than the actual
      // requirement (receipt data never leaves the device — already true
      // and verified in Phase 18 without this). registerType: 'prompt'
      // rather than 'autoUpdate' — an auto-silent-reload could interrupt
      // a multi-minute in-flight VLM extraction; the user should choose
      // when to update, same reasoning as why panels stay mounted instead
      // of remounting on tab switch (Phase 5's fix).
      registerType: 'prompt',
      includeAssets: ['favicon.svg', 'icons.svg'],
      manifest: {
        name: 'ClaimSense',
        short_name: 'ClaimSense',
        description: 'Local-first, on-device expense claim processing — receipt data never leaves this device.',
        theme_color: '#171717',
        background_color: '#171717',
        display: 'standalone',
        start_url: '/',
        icons: [
          {
            src: '/favicon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any',
          },
          {
            src: '/favicon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // The bundled VLM weights + ONNX WASM runtime + Tesseract assets
        // are individually well over Workbox's 2MB default cap (the WASM
        // binary alone is ~26MB) — without raising this, precaching would
        // silently skip exactly the files the zero-network claim depends
        // on, and the app would work online but fail after an install +
        // offline reload, the one scenario this phase exists to prove.
        maximumFileSizeToCacheInBytes: 600 * 1024 * 1024,
        globPatterns: ['**/*.{js,css,html,svg,wasm,onnx,json}'],
        // Model/tesseract files are fetched by URL at runtime (not
        // referenced via import.meta.url the way JS/CSS chunks are), so
        // Workbox's build-time glob won't discover them as build assets.
        // Explicitly caching the origin's model/tesseract paths at
        // runtime (cache-first: already-downloaded weights never need to
        // hit the network again) covers exactly the files an offline
        // cold start needs.
        runtimeCaching: [
          {
            urlPattern: /\/models\/.*/,
            handler: 'CacheFirst',
            options: { cacheName: 'claimsense-models' },
          },
          {
            urlPattern: /\/tesseract\/.*/,
            handler: 'CacheFirst',
            options: { cacheName: 'claimsense-tesseract' },
          },
        ],
      },
    }),
  ],
})
