import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'
import type { Plugin } from 'vite'

// Zero-egress, enforced by the browser itself rather than by our own code:
// with connect-src 'self', any fetch/XHR/WebSocket to another host is
// refused before it leaves the page, whatever library makes it. Added in
// the pre-submission audit — until then only the extraction worker's own
// fetch was locked down (extractionWorker.ts), and the main thread relied
// on no code ever trying. 'wasm-unsafe-eval' is what WebAssembly (PGlite,
// Tesseract, ONNX Runtime) needs to compile; it does not allow JS eval.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval' blob:",
  "worker-src 'self' blob:",
  "connect-src 'self' blob: data:",
  "img-src 'self' blob: data:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ')

// Production build only: the dev server's hot-reload needs inline scripts
// and a WebSocket, which this policy would (correctly) block.
function contentSecurityPolicy(): Plugin {
  return {
    name: 'claimsense-csp',
    apply: 'build',
    transformIndexHtml: () => [
      { tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP }, injectTo: 'head-prepend' },
    ],
  }
}

// https://vite.dev/config/
export default defineConfig({
  // PGlite loads its own WebAssembly + data bundle via import.meta.url, which
  // Vite's dependency pre-bundler would break.
  optimizeDeps: { exclude: ['@electric-sql/pglite'] },
  // The <meta> tag covers the page; as a header it also covers every
  // worker script (OCR, PDF, database), which a meta tag can't reach.
  preview: { headers: { 'Content-Security-Policy': CSP } },
  plugins: [
    react(),
    tailwindcss(),
    contentSecurityPolicy(),
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
        // `gz` covers Tesseract's eng.traineddata.gz — without it OCR, the
        // primary extraction path, could not start offline (found live).
        // `mjs` covers the PDF.js worker and the ONNX Runtime engine
        // loader, both served as .mjs (added in the pre-submission audit).
        globPatterns: ['**/*.{js,mjs,css,html,svg,wasm,onnx,json,data,gz}'],
        // ...except the VLM's ONNX weights. Precaching is all-or-nothing:
        // the 365MB decoder exceeds what Cache Storage will accept as a
        // single entry (cache.put fails with "UnknownError", verified
        // live 2026-10-19), and that one failure aborted the whole
        // install, so the app got NO offline support at all. The weights
        // instead go through the CacheFirst /models/ rule below, where a
        // failed cache write only skips that one file. Same-origin either
        // way, so zero-egress is unaffected.
        globIgnores: ['models/**/*.onnx'],
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
