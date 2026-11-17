/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // Forward API calls to Django so the browser sees one origin (cookies + CSRF).
    // changeOrigin must stay false (the string shorthand enables it): Django then sees
    // the browser's Host, which matches the Origin header for its CSRF origin check.
    proxy: {
      '/api': { target: 'http://127.0.0.1:8000', changeOrigin: false },
    },
  },
  test: {
    environment: 'jsdom',
    // Pages render 50+ rows twice (table and mobile list); allow for slow, parallel runs.
    testTimeout: 30000,
    setupFiles: ['./src/test/setup.ts'],
  },
})
