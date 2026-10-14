// The plugin against the repo's corpus (fixtures/public/junos, see fixtures/README.md), referenced by path rather than
// copied. Two parts:
// - chosen files, at least one per area it converts, through the conformance kit's four checks against an expected model
//   (tests/corpus/<file>.model.json, checked by hand against the source);
// - every Junos file in the corpus, phase 1 or not, hierarchical or set form: it parses without an error, every
//   statement gets a disposition, every field of its model is rendered or says why not, and render → reparse gives the
//   same model, so nothing the plugin doesn't know is dropped or garbled.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, extname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { deserializeModel, MODEL_VERSION } from '@dialect/core'
import { checkFixture } from '@dialect/conformance'
import plugin from '../src'

const corpus = fileURLToPath(new URL('../../../fixtures/public/junos/', import.meta.url))
const expected = fileURLToPath(new URL('./corpus/', import.meta.url))

/** Corpus files with an expected model, by area. */
const CASES: readonly (readonly [area: string, path: string])[] = [
  ['system', 'system/batfish__apply-groups-routing-instances.set'],
  ['dns', 'system/batfish__name-server.set'],
  ['interfaces', 'interfaces/batfish__junos-interface-range-unit.set'],
  ['interfaces', 'interfaces/batfish__interface-primary.set'],
  ['static-routes', 'static-routes/batfish__static-routes.set'],
  ['static-routes', 'static-routes/batfish__static-routes-ipv6.set'],
  ['ntp', 'mgmt/batfish__ntp.set'],
  ['syslog', 'mgmt/batfish__juniper-syslog.set'],
  ['snmp', 'mgmt/batfish__unit-tests_junos-snmp-gh-8812.conf'],
  ['snmp', 'whole/netcanon__kitchen_sink.set'],
  ['vlans', 'vlans/batfish__juniper-vlan-access.set'],
  ['vlans', 'vlans/batfish__juniper-vlan-all.set'],
  ['vlans', 'vlans/batfish__interface-vlan.set'],
  ['vlans', 'interfaces/batfish__irb-interfaces.set'],
  ['ospf', 'ospf/batfish__ospf-intervals.set'],
  ['ospf', 'ospf/batfish__ospf-interface-network-type.set'],
  ['bgp', 'bgp/batfish__bgp-description.set'],
  ['bgp', 'bgp/batfish__bgp-type-internal.set'],
  ['routing-policy', 'policy/batfish__juniper-from-prefix-list.set'],
  ['routing-policy', 'policy/batfish__community.set'],
  ['routing-policy', 'policy/batfish__unit-tests_juniper_extended_community.set'],
  ['filters', 'filters/batfish__firewall-filters.set'],
  ['filters', 'filters/aerleon__sample_multitarget.jcl.conf']
]

const read = (path: string) => readFileSync(join(corpus, path), 'utf8')
/** Display set's text is config, which the kit's secrets check leaves alone. */
const OPTIONS = { configTools: ['display-set'] }

describe('corpus files with an expected model', () => {
  it('cover every area the plugin converts', () => {
    expect(new Set(CASES.map(([area]) => area))).toEqual(new Set(['system', 'dns', 'interfaces', 'static-routes', 'ntp', 'syslog', 'snmp', 'vlans', 'ospf', 'bgp', 'routing-policy', 'filters']))
  })
  for (const [area, path] of CASES) {
    describe(`${area}: ${path}`, () => {
      const name = basename(path, extname(path))
      const fixture = { name, source: read(path), expectedModel: deserializeModel(readFileSync(join(expected, `${name}.model.json`), 'utf8')).device }
      for (const r of checkFixture(plugin, fixture, OPTIONS)) {
        it.skipIf(r.status === 'skipped')(r.check, () => {
          expect(r.problems, r.problems.join('\n')).toEqual([])
        })
      }
    })
  }
})

const files = (dir: string): string[] => readdirSync(dir).flatMap((e) => (statSync(join(dir, e)).isDirectory() ? files(join(dir, e)) : [join(dir, e)]))

/**
 * Corpus files that aren't a configuration Junos would load, with why. Each must report a syntax error, with a message
 * that doesn't quote the text.
 */
const NOT_CONFIGS: Readonly<Record<string, string>> = {
  // fixtures/manifest.json: "Contains both hierarchical blocks and set/delete lines". It is a terminal capture: set
  // commands, a `root> show configuration` prompt, then the configuration, with its long lines wrapped, so the quoted
  // password hash is cut off before its closing quote.
  'whole/tsg8139__srx-lab_leaf01.conf': 'a terminal capture whose wrapped lines cut a quoted password hash'
}

describe('every Junos file in the corpus', () => {
  const all = files(corpus).map((f) => relative(corpus, f).split(sep).join('/')).sort()
  it('is there', () => {
    expect(all.length).toBeGreaterThan(200)
  })
  for (const path of Object.keys(NOT_CONFIGS)) {
    it(`${path} is not a configuration (${NOT_CONFIGS[path]}): a syntax error, quoting nothing`, () => {
      const parsed = plugin.parse!(read(path), { modelVersion: MODEL_VERSION })
      const errors = parsed.diagnostics.filter((d) => d.severity === 'error')
      expect(errors.map((d) => d.code)).toEqual(['junos.syntax'])
      expect(errors[0].message).not.toMatch(/\$6\$|"/)
    })
  }
  for (const path of all.filter((p) => !Object.hasOwn(NOT_CONFIGS, p))) {
    it(path, () => {
      const results = checkFixture(plugin, { name: path, source: read(path), expectedModel: plugin.parse!(read(path), { modelVersion: MODEL_VERSION }).model }, OPTIONS)
      const failed = results.filter((r) => r.status === 'failed').flatMap((r) => r.problems.map((p) => `${r.check}: ${p}`))
      expect(failed).toEqual([])
    })
  }
})
