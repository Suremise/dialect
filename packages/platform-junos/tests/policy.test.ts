// Routing policy beyond the conformance fixtures (tests/fixtures/conformance/policy): the per-term ledger of each
// negative fixture (tests/fixtures/conformance/policy-unsupported), line by line; Junos's longest-match reading of route
// filters against the model's any-match; groups in policy-options; and a model from another platform rendered in Junos
// terms, where what Junos would read another way is left out whole and says why. Messages never quote a name or a value.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildLedger, deserializeModel, ledgerProblems, modelProblems, MODEL_VERSION, type Device, type ParseResult, type RenderResult } from '@dialect/core'
import { parse, render } from '../src'
import { longestMatchAgrees } from '../src/prefixes'

const context = { modelVersion: MODEL_VERSION }
const set = (...lines: string[]): string => lines.join('\n') + '\n'
/** The lines of the statements the parse left unsupported. */
const unsupportedLines = (p: ParseResult): number[] =>
  Object.entries(p.dispositions)
    .filter(([, d]) => d.kind === 'unsupported')
    .map(([id]) => Number(id.slice(1)))
    .sort((a, b) => a - b)
const fixture = (name: string) => readFileSync(new URL(`./fixtures/conformance/policy-unsupported/${name}.set`, import.meta.url), 'utf8')
/** Every message a render gives: reasons and diagnostics. */
const told = (r: RenderResult): string[] => [...Object.values(r.dispositions).flatMap((d) => (d.kind === 'rendered' ? [] : [d.reason ?? ''])), ...r.diagnostics.map((d) => d.message)]

describe('the per-term ledger of each negative fixture', () => {
  // Per fixture: the lines left unsupported, and the policies the model still has.
  const cases: readonly [name: string, lines: number[], policies: string[], why: string][] = [
    ['term-action', [3, 4], ['P'], 'the last term has an action the model has no word for: it alone is left out'],
    ['term-unsafe', [1, 2, 3], ['Q'], 'a term that accepts is left out, so the next term would see its routes: none of the policy converts'],
    ['term-safe-skip', [1, 2], ['P'], 'a term that only sets local preference, which no later term matches on, is left out alone'],
    ['to', [1, 2], ['P'], 'a to condition'],
    ['route-filter-nested', [1, 2, 3], ['P'], 'route filters Junos reads by longest match, where the model reads any match'],
    ['route-filter-through', [1, 2], ['P'], 'a route filter of type through'],
    ['prefix-list-and-route-filter', [2, 3, 4], ['P'], 'prefix lists and route filters together'],
    ['prefix-list-filter-upto', [2, 3], ['P'], 'a prefix-list-filter match type the model has no word for'],
    ['prefix-list-apply-path', [1, 2, 3, 4], ['P'], 'a prefix list with apply-path converts not at all, nor a term naming it'],
    ['community-actions', [3, 4], ['P'], 'community actions of two kinds, which Junos applies in order'],
    ['community-regex-add', [2], ['P'], 'adding a community given by a regex, which Junos refuses'],
    ['community-invert', [1, 2, 3, 4], ['P'], 'an invert-match community converts not at all, nor a term naming it'],
    ['community-regex-kind', [1], [], "a regex whose start doesn't say its kind of community"],
    ['as-path-group', [1, 2, 3], ['P'], 'AS-path groups'],
    ['group-term-order', [1, 3], [], "terms from a group beside the policy's own: their order isn't converted"],
    ['insert', [1, 2, 3], [], 'insert reorders the terms'],
    ['bgp-chain', [4, 5], ['A'], 'an import chain naming a policy nothing defines is left out whole; the export chain converts']
  ]
  for (const [name, lines, policies, why] of cases) {
    it(`${name}: ${why}`, () => {
      const p = parse(fixture(name), context)
      expect(unsupportedLines(p)).toEqual(lines)
      expect(Object.keys(p.model.routingPolicy?.policies ?? {})).toEqual(policies)
      expect(modelProblems(p.model)).toEqual([])
    })
  }

  it('bgp-chain: the peer keeps its export policy, and gets Junos default for the import side it no longer has', () => {
    const bgp = parse(fixture('bgp-chain'), context).model.networkInstances?.default.bgp
    expect(bgp?.groups?.G).toEqual({ peerAs: 64500, exportPolicies: ['A'] })
    expect(bgp?.ebgpDefaultPolicy).toEqual({ import: 'accept' })
  })

  it("leaves a neighbor's group's chain out too when the neighbor's own doesn't convert, as the neighbor would take its group's", () => {
    const p = parse(set('set protocols bgp group G import A', 'set protocols bgp group G neighbor 192.0.2.2 import MISSING', 'set policy-options policy-statement A then accept'), context)
    expect(unsupportedLines(p)).toEqual([1, 2])
    expect(p.model.networkInstances?.default.bgp?.groups?.G?.importPolicies).toBeUndefined()
  })
})

describe('route filters: longest match against any match', () => {
  const m = (prefix: string, minLength: number, maxLength: number) => ({ prefix, minLength, maxLength })
  it.each([
    ['nested exact routes under orlonger', [m('10.0.0.0/8', 8, 32), m('10.1.0.0/16', 16, 16)], false],
    ['nested orlonger under orlonger', [m('10.0.0.0/8', 8, 32), m('10.1.0.0/16', 16, 32)], true],
    ['nested exact under exact', [m('10.0.0.0/8', 8, 8), m('10.1.0.0/16', 16, 16)], true],
    ['nested, the more specific taking only the lengths the less specific does', [m('10.0.0.0/8', 8, 24), m('10.1.0.0/16', 16, 24)], true],
    ['nested, the less specific taking a length the more specific leaves out', [m('10.0.0.0/8', 8, 24), m('10.1.0.0/16', 20, 24)], false],
    ['the same prefix twice, taken together', [m('10.0.0.0/8', 8, 32), m('10.1.0.0/16', 16, 16), m('10.1.0.0/16', 17, 32)], true],
    ['apart', [m('10.0.0.0/8', 8, 32), m('192.0.2.0/24', 24, 24)], true],
    ['IPv6 nested, longer under orlonger', [m('2001:db8::/32', 32, 128), m('2001:db8:1::/48', 49, 128)], false],
    ['both families', [m('0.0.0.0/0', 0, 0), m('::/0', 0, 128)], true]
  ] as const)('%s: agrees %s', (_, matches, agrees) => {
    expect(longestMatchAgrees(matches)).toBe(agrees)
  })
})

describe('groups in policy-options (R1–R12 apply as everywhere)', () => {
  it("takes a group's statements under policy-options, the configuration's own single setting winning", () => {
    const p = parse(set('set groups G policy-options policy-statement P term T then local-preference 50', 'set groups G policy-options policy-statement P term T then accept', 'set policy-options apply-groups G', 'set policy-options policy-statement P term T then local-preference 200'), context)
    expect(p.model.routingPolicy?.policies?.P.terms?.['1']).toEqual({ name: 'T', actions: { localPreference: 200, flow: 'accept' } })
    expect(p.dispositions.L1).toMatchObject({ kind: 'ignored-by-design', reason: 'superseded by line 4' })
  })

  it('a wildcard group adds to the policies and terms the configuration has, in their order, and creates none', () => {
    const p = parse(set('set groups G policy-options policy-statement <*> term <*> then tag 7', 'set apply-groups G', 'set policy-options policy-statement P term FIRST then accept', 'set policy-options policy-statement P term SECOND then reject'), context)
    expect(Object.keys(p.model.routingPolicy?.policies ?? {})).toEqual(['P'])
    expect(p.model.routingPolicy?.policies?.P.terms).toEqual({ '1': { name: 'FIRST', actions: { tag: 7, flow: 'accept' } }, '2': { name: 'SECOND', actions: { tag: 7, flow: 'reject' } } })
  })
})

describe('render from another platform’s model', () => {
  /** A route map as an IOS-XE parse gives it: unnamed sequences, prefix lists with ranges, a rejecting fall-through. */
  const routeMap = (extra: Partial<NonNullable<Device['routingPolicy']>> = {}): Device => ({
    routingPolicy: {
      prefixLists: {
        ipv4: {
          EXACT: { entries: { '5': { action: 'permit', prefix: '192.0.2.0/24', minLength: 24, maxLength: 24, form: 'exact' } } },
          RANGE: { entries: { '5': { action: 'permit', prefix: '10.0.0.0/8', minLength: 16, maxLength: 24, form: 'ge-le' } } }
        }
      },
      policies: {
        RM: {
          fallThrough: 'reject',
          terms: {
            '10': { matches: { prefixLists: { ipv4: ['EXACT'] } }, actions: { flow: 'accept', localPreference: 200 } },
            '20': { matches: { routeFilters: { '1': { prefix: '10.0.0.0/8', minLength: 16, maxLength: 24, form: 'ge-le' } } }, actions: { flow: 'accept' } }
          }
        }
      },
      ...extra
    }
  })

  it('writes route-map sequences as terms named by their sequence, the last as the policy’s own from and then, and warns that the fall-through differs', () => {
    const model = routeMap()
    const r = render(model, context)
    expect(r.text).toContain(['    policy-statement RM {', '        term 10 {', '            from {', '                prefix-list EXACT;', '            }', '            then {', '                local-preference 200;', '                accept;', '            }', '        }', '        from {', '            route-filter 10.0.0.0/8 prefix-length-range /16-/24;', '        }', '        then {', '            accept;', '        }', '    }'].join('\n'))
    expect(r.diagnostics.map((d) => d.code)).toEqual(['junos.policy-fall-through'])
    expect(r.diagnostics[0].message).toMatch(/\(line \d+\)\.$/)
    expect(r.dispositions['routingPolicy.policies.RM.terms["20"].matches.routeFilters["1"].form']).toMatchObject({ kind: 'not-applicable' })
    // A Junos prefix list matches exactly and only permits: one with a length range isn't written.
    expect(r.dispositions['routingPolicy.prefixLists.ipv4.RANGE.entries["5"].prefix']).toMatchObject({ kind: 'unsupported' })
    expect(ledgerProblems(buildLedger(parse('', context), r, model))).toEqual([])
  })

  it('leaves the whole policy out when a term that decides names a list Junos can’t write', () => {
    const model = routeMap()
    const terms = model.routingPolicy!.policies!.RM.terms!
    const changed: Device = { routingPolicy: { ...model.routingPolicy, policies: { RM: { fallThrough: 'reject', terms: { ...terms, '10': { matches: { prefixLists: { ipv4: ['RANGE'] } }, actions: { flow: 'accept' } } } } } } }
    const r = render(changed, context)
    expect(r.text).not.toContain('policy-statement')
    expect(r.dispositions['routingPolicy.policies.RM.terms["20"].actions.flow']).toMatchObject({ kind: 'unsupported', reason: expect.stringContaining('the per-term rule') })
    expect(ledgerProblems(buildLedger(parse('', context), r, changed))).toEqual([])
  })

  it('never writes a Cisco regex as a Junos one, literal communities in an action, nor a list for one family Junos has for both', () => {
    const model: Device = {
      routingPolicy: {
        prefixLists: { ipv4: { L: { entries: { '1': { action: 'permit', prefix: '192.0.2.0/24', minLength: 24, maxLength: 24 } } } }, ipv6: { L: { entries: { '1': { action: 'permit', prefix: '2001:db8::/32', minLength: 32, maxLength: 32 } } } } },
        communitySets: { CISCO: { type: 'standard', regexDialect: 'cisco', entries: { '1': { action: 'permit', regexes: ['_65000:.*_'] } } } },
        asPathSets: { CISCO: { regexDialect: 'cisco', entries: { '1': { action: 'permit', regex: '_65000_' } } } },
        policies: {
          A: { fallThrough: 'next-policy', terms: { '1': { name: 'T', matches: { communitySets: ['CISCO'] }, actions: { flow: 'accept' } } } },
          B: { fallThrough: 'next-policy', terms: { '1': { name: 'T', actions: { communityAdd: { values: ['65000:1'] } } } } },
          C: { fallThrough: 'next-policy', terms: { '1': { name: 'T', matches: { prefixLists: { ipv4: ['L'] } }, actions: { flow: 'accept' } } } }
        }
      }
    }
    const r = render(model, context)
    expect(r.dispositions['routingPolicy.communitySets.CISCO.entries["1"].regexes']).toMatchObject({ kind: 'unsupported' })
    expect(r.dispositions['routingPolicy.asPathSets.CISCO.entries["1"].regex']).toMatchObject({ kind: 'unsupported' })
    for (const policy of ['A', 'B', 'C']) expect(r.dispositions[`routingPolicy.policies.${policy}.terms["1"].name`]).toMatchObject({ kind: 'unsupported' })
    expect(r.text).toContain('prefix-list L {\n        192.0.2.0/24;\n        2001:db8::/32;\n    }')
    expect(r.text).not.toContain('_65000')
    expect(ledgerProblems(buildLedger(parse('', context), r, model))).toEqual([])
  })

  it('names no policy, list or community in a message', () => {
    const secret = 'SECRET-NAME'
    const model: Device = {
      routingPolicy: {
        prefixLists: { ipv4: { [secret]: { entries: { '1': { action: 'deny', prefix: '192.0.2.0/24', minLength: 24, maxLength: 24 } } } } },
        communitySets: { [secret]: { regexDialect: 'cisco', type: 'standard', entries: { '1': { action: 'permit', regexes: ['_1:1_'] } } } },
        policies: { [secret]: { fallThrough: 'reject', terms: { '10': { matches: { prefixLists: { ipv4: [secret] } }, actions: { flow: 'accept' } }, '20': { actions: { flow: 'accept' } } } } }
      }
    }
    const r = render(model, context)
    expect(told(r).filter((m) => m.includes(secret))).toEqual([])
  })
})

describe("a VRF's import and export policies (model 0.5.2)", () => {
  // From a Cisco source, where the map filters after the route targets, one fixture per direction: the meaning can't be
  // kept by vrf-import or vrf-export, which replace the route targets on Junos, so the side is left out and said.
  for (const side of ['import', 'export'] as const) {
    it(`leaves a Cisco ${side} map out, with a semantic warning, and keeps the route targets`, () => {
      const model = deserializeModel(readFileSync(new URL(`./fixtures/vrf-policy-mode/${side}.model.json`, import.meta.url), 'utf8')).device
      expect(modelProblems(model)).toEqual([])
      const r = render(model, context)
      const field = `networkInstances.RED.${side}Policies`
      expect(r.dispositions[field]).toMatchObject({ kind: 'unsupported', reason: expect.stringContaining("the meaning can't be kept") })
      expect(r.dispositions['networkInstances.RED.vrfPolicyMode']).toMatchObject({ kind: 'not-applicable' })
      expect(r.diagnostics.filter((d) => d.code === 'junos.vrf-policy-mode')).toHaveLength(1)
      expect(r.text).not.toMatch(/vrf-(import|export)/)
      expect(r.text).toContain('vrf-target target:65000:1;')
      expect(ledgerProblems(buildLedger(parse('', context), r, model))).toEqual([])
    })
  }

  it('writes a Junos source’s back, and asks for no route target a policy replaces', () => {
    const p = parse(set('set policy-options policy-statement IN then accept', 'set policy-options policy-statement OUT then accept', 'set routing-instances V instance-type vrf', 'set routing-instances V route-distinguisher 65000:9', 'set routing-instances V vrf-import IN', 'set routing-instances V vrf-export OUT'), context)
    expect(p.model.networkInstances?.V).toMatchObject({ importPolicies: ['IN'], exportPolicies: ['OUT'], vrfPolicyMode: 'replaces-route-targets' })
    const r = render(p.model, context)
    expect(r.text).toContain('        route-distinguisher 65000:9;\n        vrf-import IN;\n        vrf-export OUT;\n')
    expect(r.needsInput ?? []).toEqual([])
    expect(r.diagnostics).toEqual([])
  })

  it('a side with no policy still asks for its route target', () => {
    const p = parse(set('set policy-options policy-statement IN then accept', 'set routing-instances V instance-type vrf', 'set routing-instances V route-distinguisher 65000:9', 'set routing-instances V vrf-import IN'), context)
    expect(render(p.model, context).needsInput?.map((n) => n.id)).toEqual(['junos.vrf-target:V'])
  })
})
