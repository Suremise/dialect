// The conformance kit as Vitest tests: a plugin's test file calls describeConformance() with its plugin and fixture
// folder, and gets one test per fixture and check, one per probe case when it gives its probe adapter (probes.ts), and
// one that its temporary secrets allowances are still needed.
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
import { runProbes, type ProbeAdapter } from './probes'
import type { SecretsOptions } from './secrets'

/**
 * Vitest tests for `plugin`'s fixtures under `fixturesDir` (a path or a file: URL). A plugin with a tool whose text is
 * config names it in `configTools` (`describeConformance(junos, dir, { configTools: ['display-set'] })`), and gives its
 * probe adapter as `probes`: without one, the probes show as one skipped test, never as passing.
 */
export function describeConformance(plugin: PlatformPlugin, fixturesDir: string | URL, { modelVersion = MODEL_VERSION, allowances = SECRET_ALLOWANCES, configTools, probes }: SecretsOptions & { modelVersion?: string; probes?: ProbeAdapter } = {}): void {
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
        const results = checkFixture(plugin, fixture, { modelVersion, allowances, ...(configTools ? { configTools } : {}) })
        for (const r of results) for (const a of r.allowed ?? []) used.add(a.allowance)
        for (const r of results) {
          it.skipIf(r.status === 'skipped')(r.check, () => {
            expect(r.problems, r.problems.join('\n')).toEqual([])
          })
        }
      })
    }
    describe('probes', () => {
      if (!probes) {
        it.skip('the plugin gives no probe adapter yet', () => {})
        return
      }
      const results = runProbes(plugin, probes, { modelVersion, allowances, ...(configTools ? { configTools } : {}) })
      for (const r of results) for (const a of r.allowed ?? []) used.add(a.allowance)
      for (const r of results) {
        // Not applicable is a declared skip, with why in its name.
        if (r.status === 'not-applicable') it.skip(`${r.probe}: ${r.case}: not applicable: ${r.problems.join('; ')}`, () => {})
        else
          it(`${r.probe}: ${r.case}`, () => {
            expect(r.problems, r.problems.join('\n')).toEqual([])
          })
      }
    })
    // A leak that is fixed takes its allowance with it (allowances.ts), so an allowance can't hide a new leak later.
    // One for fixtures of another test file is that file's to keep honest.
    const names = new Set(fixtures.map((f) => f.name))
    const own = allowances.filter((a) => a.plugin === plugin.id && (a.fixtures === undefined || a.fixtures.some((f) => names.has(f))))
    it.skipIf(!own.length)('needs each of its temporary secrets allowances', () => {
      expect(own.filter((a) => !used.has(a)).map((a) => `#${a.card}: ${a.leak}`)).toEqual([])
    })
  })
}
