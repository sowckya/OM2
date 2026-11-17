// Vitest setup (vite.config.ts → test.setupFiles).
// Test files run in parallel jsdom workers; on a busy machine a page's first render can
// take over a second, so allow async waits more time. Assertions are unchanged.
import { configure } from '@testing-library/react'
import { vi } from 'vitest'

const ASYNC_TIMEOUT_MS = 5000

configure({ asyncUtilTimeout: ASYNC_TIMEOUT_MS })

const waitFor = vi.waitFor
vi.waitFor = ((callback, options) =>
  waitFor(callback, typeof options === 'number' ? options : { timeout: ASYNC_TIMEOUT_MS, ...options })) as typeof vi.waitFor
