// The plugin against the repo's corpus (fixtures/public/iosxr, see fixtures/README.md), referenced by path rather than
// copied. Two parts:
// - chosen files, at least one per phase 1 area, through the conformance kit's checks against an expected model
//   (tests/corpus/<file>.model.json, checked by hand against the source);
// - every IOS-XR file in the corpus, phase 1 or not: it parses without an error, every statement gets a disposition,
//   render → reparse gives the same model, and no secret reaches a message, so nothing the plugin doesn't know is
//   dropped or garbled.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { deserializeModel, MODEL_VERSION } from '@dialect/core'
import { checkFixture } from '@dialect/conformance'
import plugin from '../src'

const corpus = fileURLToPath(new URL('../../../fixtures/public/iosxr/', import.meta.url))
const expected = fileURLToPath(new URL('./corpus/', import.meta.url))

/** Corpus files with an expected model, by phase 1 area. */
export const CASES: readonly (readonly [area: string, path: string])[] = [
  ['system', 'system/batfish__xr-hostname.domain.cfg'],
  ['system', 'system/batfish__banner.cfg'],
  ['system', 'whole/racc__xrv1_20230811_show_running-config.cfg'],
  ['dns', 'whole/netcanon__kitchen_sink.cfg'],
  ['interfaces', 'interfaces/batfish__xr-interface-address.cfg'],
  ['interfaces', 'interfaces/batfish__bundle-ether-subif.cfg'],
  ['interfaces', 'whole/cml__sandbox_core-rtr01.cfg'],
  ['vrfs', 'vrfs/batfish__xr-vrf-route-target.cfg'],
  ['static-routes', 'static-routes/batfish__unit-tests_ios_xr_router_static.cfg'],
  ['static-routes', 'static-routes/batfish__xr-no-route.cfg'],
  ['ntp', 'mgmt/batfish__unit-tests_ios_xr_ntp.cfg'],
  ['logging', 'mgmt/batfish__xr-logging.cfg'],
  ['snmp', 'mgmt/batfish__xr-snmp-server.cfg'],
  ['policy', 'policy/batfish__unit-tests_ios_xr_route_policy.cfg']
]

const read = (path: string) => readFileSync(join(corpus, path), 'utf8')

/**
 * Files whose render → reparse loses only a secret the model flags (a BGP password, an OSPF key chain's name): the render
 * asks for it with a needs-input item, and can't write it unanswered. The kit's rule for these is still being decided
 * (#65's comments: core 0.4.1); until then each file's exact problems are expected here, and its needs-input items, so
 * nothing else slips through.
 */
const FLAGGED_SECRETS: Readonly<Record<string, readonly string[]>> = {
  'bgp/batfish__xr-bgp.cfg': ['round-trip: render → reparse changed the model: networkInstances.default.bgp.groups.ng1.authentication: expected true, got undefined'],
  'whole/racc__xrv1_20230811_show_running-config.cfg': ['round-trip: render → reparse changed the model: networkInstances.default.ospf.areas: expected {"0.0.0.10":{"authentication":"key-chain"}}, got undefined']
}

describe('corpus files with an expected model', () => {
  it('cover every phase 1 area, and route policies', () => {
    expect(new Set(CASES.map(([area]) => area))).toEqual(new Set(['system', 'dns', 'interfaces', 'vrfs', 'static-routes', 'ntp', 'logging', 'snmp', 'policy']))
  })
  for (const [area, path] of CASES) {
    describe(`${area}: ${path}`, () => {
      const name = basename(path, '.cfg')
      const fixture = { name, source: read(path), expectedModel: deserializeModel(readFileSync(join(expected, `${name}.model.json`), 'utf8')).device }
      for (const r of checkFixture(plugin, fixture)) {
        it.skipIf(r.status === 'skipped')(r.check, () => {
          const flagged = (FLAGGED_SECRETS[path] ?? []).filter((p) => p.startsWith(`${r.check}: `)).map((p) => p.slice(r.check.length + 2))
          expect(r.problems, r.problems.join('\n')).toEqual(flagged)
        })
      }
    })
  }
})

const files = (dir: string): string[] => readdirSync(dir).flatMap((e) => (statSync(join(dir, e)).isDirectory() ? files(join(dir, e)) : [join(dir, e)]))

describe('every IOS-XR file in the corpus', () => {
  const all = files(corpus).map((f) => relative(corpus, f).split(sep).join('/')).sort()
  it('is there', () => {
    expect(all.length).toBeGreaterThan(60)
  })
  for (const path of all) {
    it(path, () => {
      const results = checkFixture(plugin, { name: path, source: read(path), expectedModel: plugin.parse!(read(path), { modelVersion: MODEL_VERSION }).model })
      const failed = results.filter((r) => r.status === 'failed').flatMap((r) => r.problems.map((p) => `${r.check}: ${p}`))
      expect(failed).toEqual(FLAGGED_SECRETS[path] ?? [])
      if (Object.hasOwn(FLAGGED_SECRETS, path)) {
        const model = plugin.parse!(read(path), { modelVersion: MODEL_VERSION }).model
        expect(plugin.render!(model, { modelVersion: MODEL_VERSION }).needsInput?.length).toBeGreaterThan(0)
      }
    })
  }
})
