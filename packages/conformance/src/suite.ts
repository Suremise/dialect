// The conformance kit as Vitest tests: a plugin's test file calls describeConformance() with its plugin and fixture
// folder, and gets one test per fixture and check.
//
//   import plugin from '../src'
//   import { describeConformance } from '@dialect/conformance'
//   describeConformance(plugin, new URL('./fixtures', import.meta.url))
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createRegistry, MODEL_VERSION, type PlatformPlugin } from '@dialect/core'
import { checkFixture } from './checks'
import { loadFixtures } from './fixtures'

/** Vitest tests for `plugin`'s fixtures under `fixturesDir` (a path or a file: URL). */
export function describeConformance(plugin: PlatformPlugin, fixturesDir: string | URL, { modelVersion = MODEL_VERSION }: { modelVersion?: string } = {}): void {
  const dir = typeof fixturesDir === 'string' ? fixturesDir : fileURLToPath(fixturesDir)
  describe(`conformance: ${plugin.id}`, () => {
    it('loads in the registry (its modelApi covers the core\'s model version)', () => {
      expect(() => createRegistry([plugin], { modelVersion })).not.toThrow()
    })
    const fixtures = loadFixtures(dir, { modelVersion })
    it('has fixtures', () => {
      expect(fixtures.length).toBeGreaterThan(0)
    })
    for (const fixture of fixtures) {
      describe(fixture.name, () => {
        const results = checkFixture(plugin, fixture, { modelVersion })
        for (const r of results) {
          it.skipIf(r.status === 'skipped')(r.check, () => {
            expect(r.problems, r.problems.join('\n')).toEqual([])
          })
        }
      })
    }
  })
}
