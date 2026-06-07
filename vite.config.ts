/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
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
