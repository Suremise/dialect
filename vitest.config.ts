import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // The repo-wide tests (tests/) and each workspace package's own (packages/*/tests, apps/*/tests).
    include: ['tests/**/*.test.ts', 'packages/*/tests/**/*.test.ts', 'apps/*/tests/**/*.test.ts'],
    environment: 'node',
    // Hive's limits (its #189, #528): under load (other agents' tests on the same machine) Vitest's 5 s a test made
    // tests fail that pass alone. Not to cover a wait for time: tests wait for conditions (AGENTS.md); the limit bounds
    // slow work (git, npm). A test that needs more says so itself.
    maxWorkers: '50%',
    testTimeout: 20_000,
    hookTimeout: 30_000
  }
})
