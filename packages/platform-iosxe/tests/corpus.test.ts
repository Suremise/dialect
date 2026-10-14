// The plugin against the repo's corpus (fixtures/public/iosxe, see fixtures/README.md), referenced by path rather than
// copied. Two parts:
// - chosen files, at least one per phase 1 area, through the conformance kit's four checks against an expected model
//   (tests/corpus/<file>.model.json, checked by hand against the source);
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

/** Corpus files with an expected model, by phase 1 area. */
const CASES: readonly (readonly [area: string, path: string])[] = [
  ['system', 'system/cml__ccnaprep-s1e7_cat8000v.cfg'],
  ['system', 'system/batfish__unit-tests_cisco_domain.cfg'],
  ['system', 'system/batfish__ios_banner.cfg'],
  ['interfaces', 'interfaces/batfish__ios-encapsulation-vlan.cfg'],
  ['interfaces', 'interfaces/batfish__ios-portchannel-subinterface.cfg'],
  ['interfaces', 'whole/netcanon__show_run_simple.cfg'],
  ['static-routes', 'static-routes/batfish__unit-tests_cisco_ip_route.cfg'],
  ['static-routes', 'static-routes/batfish__ios-ip-route-vrf.cfg'],
  ['ntp', 'mgmt/batfish__ios-ntp.cfg'],
  ['ntp', 'mgmt/cml__ccnaprep-s2e7_rtr01.cfg'],
  ['logging', 'mgmt/batfish__ios-logging.cfg'],
  ['snmp', 'mgmt/batfish__unit-tests_cisco_snmp.cfg']
]

const read = (path: string) => readFileSync(join(corpus, path), 'utf8')

describe('corpus files with an expected model', () => {
  it('cover every phase 1 area', () => {
    expect(new Set(CASES.map(([area]) => area))).toEqual(new Set(['system', 'interfaces', 'static-routes', 'ntp', 'logging', 'snmp']))
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
