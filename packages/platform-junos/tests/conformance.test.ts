// The conformance kit over the plugin's own fixtures (tests/fixtures/conformance/<area>): each one parsed, rendered,
// re-parsed, put through the coverage ledger and checked for secrets. The set-form fixtures have no expected render:
// the plugin renders hierarchical Junos, which the hierarchical fixtures' renders show. Display set's text is config,
// so the secrets check leaves it alone. And the kit's probes (#33), with the Junos adapters (probes.ts): set form there,
// and the hierarchical form below, run the same way (runProbes() is what describeConformance() runs for its probes).
import { describe, expect, it } from 'vitest'
import { describeConformance, runProbes } from '@dialect/conformance'
import plugin from '../src'
import { hierarchicalProbes, probes } from './probes'

const configTools = ['display-set']

describeConformance(plugin, new URL('./fixtures/conformance', import.meta.url), { configTools, probes })

describe('conformance: junos > probes, hierarchical form', () => {
  const results = runProbes(plugin, hierarchicalProbes, { configTools })
  it('runs every probe case, none not applicable', () => {
    expect(results.filter((r) => r.status === 'not-applicable')).toEqual([])
    expect(results).toHaveLength(39)
  })
  for (const r of results)
    it(`${r.probe}: ${r.case}`, () => {
      expect(r.problems, r.problems.join('\n')).toEqual([])
    })
})
