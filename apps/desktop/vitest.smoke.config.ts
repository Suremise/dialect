// The desktop smoke test (e2e/), apart from `npm test`: it builds the app with Rust and needs tauri-driver and Edge
// WebDriver (e2e/smoke.test.ts says how to get them). Run it with `npm run test:smoke -w @dialect/desktop`.
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['e2e/**/*.test.ts'],
    environment: 'node',
    // One app, one WebDriver session: the tests run in order.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 600_000
  }
})
