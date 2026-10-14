// The conformance kit as Vitest tests: a plugin's test file calls describeConformance() with its plugin and fixture
// folder, and gets one test per fixture and check, and one that its temporary secrets allowances are still needed.
//
//   import plugin from '../src'
//   import { describeConformance } from '@dialect/conformance'
//   describeConformance(plugin, new URL('./fixtures', import.meta.url))
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createRegistry, MODEL_VERSION, type PlatformPlugin } from '@dialect/core'
import { SECRET_ALLOWANCES, type SecretAllowance } from './allowances'
import { checkFixture } from './checks'
import { loadFixtures } from './fixtures'

/** Vitest tests for `plugin`'s fixtures under `fixturesDir` (a path or a file: URL). */
export function describeConformance(plugin: PlatformPlugin, fixturesDir: string | URL, { modelVersion = MODEL_VERSION, allowances = SECRET_ALLOWANCES }: { modelVersion?: string; allowances?: readonly SecretAllowance[] } = {}): void {
  const dir = typeof fixturesDir === 'string' ? fixturesDir : fileURLToPath(fixturesDir)
  describe(`conformance: ${plugin.id}`, () => {
    it('loads in the registry (its modelApi covers the core\'s model version)', () => {
      expect(() => createRegistry([plugin], { modelVersion })).not.toThrow()
    })
    const fixtures = loadFixtures(dir, { modelVersion })
    it('has fixtures', () => {
      expect(fixtures.length).toBeGreaterThan(0)
    })
    const used = new Set<SecretAllowance>()
    for (const fixture of fixtures) {
      describe(fixture.name, () => {
        const results = checkFixture(plugin, fixture, { modelVersion, allowances })
        for (const r of results) for (const a of r.allowed ?? []) used.add(a.allowance)
        for (const r of results) {
          it.skipIf(r.status === 'skipped')(r.check, () => {
            expect(r.problems, r.problems.join('\n')).toEqual([])
          })
        }
      })
    }
    // A leak that is fixed takes its allowance with it (allowances.ts), so an allowance can't hide a new leak later.
    const own = allowances.filter((a) => a.plugin === plugin.id)
    it.skipIf(!own.length)('needs each of its temporary secrets allowances', () => {
      expect(own.filter((a) => !used.has(a)).map((a) => `#${a.card}: ${a.leak}`)).toEqual([])
    })
  })
}
