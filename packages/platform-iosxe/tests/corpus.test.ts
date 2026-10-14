// The plugin against the repo's corpus (fixtures/public/iosxe, see fixtures/README.md), referenced by path rather than
// copied. Two parts:
// - chosen files, at least one per area (phase 1's, and phase 2's VLANs, OSPF and BGP), through the conformance kit's
//   four checks against an expected model (tests/corpus/<file>.model.json, checked by hand against the source);
// - every IOS / IOS-XE file in the corpus, phase 1 or not: it parses without an error, every statement gets a
//   disposition, and render → reparse gives the same model, so nothing the plugin doesn't know is dropped or garbled.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { deserializeModel, MODEL_VERSION } from '@dialect/core'
import { checkFixture } from '@dialect/conformance'
import plugin from '../src'

const corpus = fileURLToPath(new URL('../../../fixtures/public/iosxe/', import.meta.url))
const expected = fileURLToPath(new URL('./corpus/', import.meta.url))

/**
 * Corpus files with an expected model, by area: the phase 1 areas, and phase 2's VLANs (switch ports and VLAN interfaces
 * too), OSPF and BGP.
 */
const CASES: readonly (readonly [area: string, path: string])[] = [
  ['system', 'system/cml__ccnaprep-s1e7_cat8000v.cfg'],
  ['system', 'system/batfish__unit-tests_cisco_domain.cfg'],
  ['system', 'system/batfish__ios_banner.cfg'],
  ['interfaces', 'interfaces/batfish__ios-encapsulation-vlan.cfg'],
  ['interfaces', 'interfaces/batfish__ios-portchannel-subinterface.cfg'],
  ['interfaces', 'whole/netcanon__show_run_simple.cfg'],
  ['static-routes', 'static-routes/batfish__unit-tests_cisco_ip_route.cfg'],
  ['static-routes', 'static-routes/batfish__ios-ip-route-vrf.cfg'],
  ['vrfs', 'vrfs/batfish__ios-vrf-definition.cfg'],
  ['vrfs', 'whole/netcanon__kitchen_sink.cfg'],
  ['ntp', 'mgmt/batfish__ios-ntp.cfg'],
  ['ntp', 'mgmt/cml__ccnaprep-s2e7_rtr01.cfg'],
  ['logging', 'mgmt/batfish__ios-logging.cfg'],
  ['snmp', 'mgmt/batfish__unit-tests_cisco_snmp.cfg'],
  ['vlans', 'vlans/batfish__ios_switchport_mode.cfg'],
  ['vlans', 'vlans/batfish__unit-tests_switchport_range.cfg'],
  ['vlans', 'vlans/batfish__ios-access-vlan.cfg'],
  ['vlans', 'vlans/batfish__ios-native-vlan.cfg'],
  ['vlans', 'vlans/cml__sandbox_edge-sw01.cfg'],
  ['vlans', 'interfaces/batfish__ios_svi.cfg'],
  ['ospf', 'ospf/batfish__ios-ospf-stub-settings.cfg'],
  ['ospf', 'whole/batfish__as2core1.cfg'],
  ['bgp', 'bgp/batfish__unit-tests_ios-xe-bgp-vrf.cfg'],
  ['bgp', 'whole/batfish__as2core1.cfg']
]

const read = (path: string) => readFileSync(join(corpus, path), 'utf8')

describe('corpus files with an expected model', () => {
  it('cover every area the plugin converts', () => {
    expect(new Set(CASES.map(([area]) => area))).toEqual(new Set(['system', 'interfaces', 'vrfs', 'static-routes', 'ntp', 'logging', 'snmp', 'vlans', 'ospf', 'bgp']))
  })
  for (const [area, path] of CASES) {
    describe(`${area}: ${path}`, () => {
      const name = basename(path, '.cfg')
      const fixture = { name, source: read(path), expectedModel: deserializeModel(readFileSync(join(expected, `${name}.model.json`), 'utf8')).device }
      for (const r of checkFixture(plugin, fixture)) {
        it.skipIf(r.status === 'skipped')(r.check, () => {
          expect(r.problems, r.problems.join('\n')).toEqual([])
        })
      }
    })
  }
})

const files = (dir: string): string[] => readdirSync(dir).flatMap((e) => (statSync(join(dir, e)).isDirectory() ? files(join(dir, e)) : [join(dir, e)]))

describe('every IOS / IOS-XE file in the corpus', () => {
  const all = files(corpus).map((f) => relative(corpus, f).split(sep).join('/')).sort()
  it('is there', () => {
    expect(all.length).toBeGreaterThan(100)
  })
  for (const path of all) {
    it(path, () => {
      const results = checkFixture(plugin, { name: path, source: read(path), expectedModel: plugin.parse!(read(path), { modelVersion: MODEL_VERSION }).model })
      const failed = results.filter((r) => r.status === 'failed').flatMap((r) => r.problems.map((p) => `${r.check}: ${p}`))
      expect(failed).toEqual([])
    })
  }
})
