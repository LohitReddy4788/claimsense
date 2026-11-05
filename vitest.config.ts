import { defineConfig } from 'vitest/config'

// Kept apart from vite.config.ts so tests don't load the PWA/Tailwind
// build plugins. Tests run in Node: the agents are plain TypeScript, and
// the database is the real Postgres engine (PGlite) in memory.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
  },
})
