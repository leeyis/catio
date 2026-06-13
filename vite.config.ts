/// <reference types="vitest/config" />
import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Single source of truth for the app version: read package.json at build time and
// expose it to the client as the __APP_VERSION__ constant (avoids hardcoded version
// strings drifting out of sync with the real package version).
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8')) as { version: string }

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  server: { port: 1420, strictPort: true },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './tests/setup.ts',
    // Exclude sibling git worktrees (e.g. .worktrees/catio-db-backend) — their
    // separate node_modules cause a dual-React collision and pollute our results.
    exclude: ['node_modules/**', 'dist/**', '.worktrees/**'],
  },
})
