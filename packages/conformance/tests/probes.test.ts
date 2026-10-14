// The probes' own tests (src/probes.ts): the careful probe stub passes every probe, a stub with each bug class fails
// the probe for it, a probe or case a plugin can't run is reported not applicable with why, a model 0.4.0 or 0.5.0 case
// an older adapter leaves out isn't run but listed, and describeConformance() runs the probes from an adapter (or shows
// them skipped without one).
import { describe, expect, it } from 'vitest'
import { fieldPath, type Diagnostic, type PlatformPlugin } from '@dialect/core'
import { describeConformance, PROBE_COMMUNITY, probesNotGiven, probesNotGivenByModel, runProbes, type ProbeAdapter, type ProbeName, type ProbeResult } from '../src'
import { PROBE_STUB_ADAPTER, probeStub, type ProbeBug } from './probeStub'

const failed = (results: readonly ProbeResult[]) => results.filter((r) => r.status === 'failed')
const failedProbes = (results: readonly ProbeResult[]) => [...new Set(failed(results).map((r) => r.probe))]

describe('runProbes', () => {
  it('passes the careful stub on every probe and case, with nothing declared not applicable', () => {
    const results = runProbes(probeStub(), PROBE_STUB_ADAPTER)
    expect(failed(results).map((r) => `${r.probe}: ${r.case}: ${r.problems.join('; ')}`)).toEqual([])
    expect(results.filter((r) => r.status === 'not-applicable')).toEqual([])
    expect(results.map((r) => `${r.probe}: ${r.case}`)).toEqual([
      'prototype-keys: __proto__',
      'prototype-keys: constructor',
      'prototype-keys: toString',
      'snmp-access: read-only',
      'snmp-access: read-write',
      'negation: address',
      'negation: description',
      'negation: name-server',
      'negation: static-route',
      'negation: community',
      'negation: bgp-neighbor',
      'negation: ospf-interface',
      'negation: policy-term',
      'negation: prefix-list-entry',
      'negation: filter-term',
      'negation: filter-attachment',
      'negation: aggregate-member',
      'malformed: ipv4-address',
      'malformed: ipv6-address',
      'malformed: mask',
      'malformed: next-hop',
      'malformed: as-number',
      'malformed: vlan-id',
      'malformed: prefix',
      'malformed: prefix-length',
      'malformed: port',
      'malformed: filter-prefix',
      'malformed: wildcard',
      'malformed: min-links',
      'malformed: aggregate-number',
      'vrf-scoping: delete',
      'vrf-scoping: dns',
      'vrf-scoping: static-route',
      'vrf-scoping: ospf',
      'vrf-scoping: bgp',
      'unknown-reference: prefix-list',
      'unknown-reference: community-set',
      'unknown-reference: as-path-set',
      'unknown-reference: policy',
      'unknown-reference: filter',
      'unknown-reference: aggregate',
      'regex: all',
      'implicit-action: all'
    ])
    expect(probesNotGiven(PROBE_STUB_ADAPTER)).toEqual([])
  })

  const cases: readonly (readonly [ProbeBug, ProbeName, string])[] = [
    ['prototype', 'prototype-keys', '__proto__ as interface: not an own key at interfaces'],
    ['snmp-parse', 'snmp-access', 'parse: a community limited to some clients came out open to every client'],
    ['snmp-render', 'snmp-access', 'render of a limited community → reparse: a community limited to some clients came out open to every client'],
    ['negation', 'negation', 'parse: interfaces.e1.description is still in the model after it was cleared'],
    ['malformed', 'malformed', 'parse: the malformed value is in the model'],
    ['vrf-scope', 'vrf-scoping', 'a change in VRF A changed networkInstances.default.staticRoutes.10.0.0.0/8.nextHops.0.address, outside it'],
    // Model 0.4.0's cases, each caught by the same bug class.
    ['prototype', 'prototype-keys', '__proto__ as bgp-group: not an own key at networkInstances.default.bgp.groups'],
    ['negation', 'negation', 'parse: networkInstances.default.bgp.neighbors.192.0.2.2 is still in the model after it was cleared'],
    ['negation', 'negation', 'parse: networkInstances.default.ospf.areas.0.0.0.0.interfaces.e1 is still in the model after it was cleared'],
    ['malformed', 'malformed', 'parse: the malformed value is in the model'],
    ['vrf-scope', 'vrf-scoping', 'a change in VRF A changed networkInstances.default.ospf.areas.0.0.0.0.interfaces.e1, outside it'],
    ['vrf-scope', 'vrf-scoping', 'a change in VRF A changed networkInstances.B.bgp.neighbors.192.0.2.2.peerAs, outside it'],
    // Model 0.5.0's: negation of a term and an entry, references to nothing, regexes of another dialect.
    ['negation', 'negation', 'parse: routingPolicy.policies.P.terms.10 is still in the model after it was cleared'],
    ['negation', 'negation', 'parse: routingPolicy.prefixLists.ipv4.L.entries.10 is still in the model after it was cleared'],
    ['reference', 'unknown-reference', 'parse made an invalid model: A policy term names a prefix list the model doesn\'t have. (routingPolicy.policies.P.terms["10"].matches.prefixLists.ipv4)'],
    ['reference', 'unknown-reference', 'parse made an invalid model: A policy term names an AS-path set the model doesn\'t have. (routingPolicy.policies.P.terms["10"].matches.asPathSets)'],
    ['reference', 'unknown-reference', 'parse made an invalid model: A BGP peer names a policy the model doesn\'t have. (networkInstances.default.bgp.neighbors["192.0.2.2"].importPolicies)'],
    ['reference', 'unknown-reference', 'parse: the malformed value is in the model'],
    ['regex', 'regex', 'render of a junos regex: routingPolicy.asPathSets["PROBE-AS-PATH"].entries["1"].regex is rendered with no semantic warning, as if it were written in the plugin\'s own dialect'],
    ['regex', 'regex', 'render of a junos regex: routingPolicy.communitySets["PROBE-COMMUNITY-SET"].entries["1"].regexes is rendered with no semantic warning, as if it were written in the plugin\'s own dialect'],
    // Model 0.5.1's: a filter term and attachment negated, a filter applied that nothing defines, a silent implicit action.
    ['negation', 'negation', 'parse: filters.ipv4.F.terms.10 is still in the model after it was cleared'],
    ['negation', 'negation', 'parse: interfaces.e1.subinterfaces.0.filters.ipv4.input is still in the model after it was cleared'],
    ['reference', 'unknown-reference', 'parse made an invalid model: A subinterface applies a filter the model doesn\'t have in that family. (interfaces.e1.subinterfaces["0"].filters.ipv4.input)'],
    ['implicit', 'implicit-action', 'render of a filter whose implicit action is discard relying on it: no semantic warning on the filter, though some packets reach its implicit action'],
    ['implicit', 'implicit-action', 'render of a filter whose implicit action is discard with a final term deciding every packet: no semantic warning on the filter, though the plugin\'s platform does otherwise with a packet no term decides'],
    // A renderer that warns only when the defaults differ: a filter relying on the plugin's own default goes unsaid.
    ['implicit-reliance', 'implicit-action', 'render of a filter whose implicit action is deny, the plugin\'s own, relying on it: no semantic warning on the filter, though some packets reach its implicit action'],
    // Model 0.5.4's (#107, #110): a membership negated, a minimum links or an aggregate number out of range, a member
    // naming an aggregate it doesn't make.
    ['negation', 'negation', 'parse: interfaces.e1.aggregate is still in the model after it was cleared'],
    ['malformed', 'malformed', 'parse: the malformed value is in the model'],
    ['min-links-zero', 'malformed', 'parse: L2 on the malformed value\'s line is mapped'],
    ['aggregate', 'unknown-reference', 'parse made an invalid model: A member link names an aggregate interface the model doesn\'t have. (interfaces.e1.aggregate)']
  ]
  for (const [bug, probe, problem] of cases) {
    it(`fails a stub with the ${bug} bug on the ${probe} probe: ${problem}`, () => {
      const results = runProbes(probeStub([bug]), PROBE_STUB_ADAPTER)
      expect(failedProbes(results)).toContain(probe)
      expect(failed(results).filter((r) => r.probe === probe).flatMap((r) => r.problems)).toContain(problem)
    })
  }

  it('fails each case of a probe on its own: the mask, a dot past the end', () => {
    const results = runProbes(probeStub(['malformed']), PROBE_STUB_ADAPTER)
    expect(failed(results).filter((r) => r.probe === 'malformed').map((r) => r.case)).toEqual(['ipv4-address', 'ipv6-address', 'mask', 'next-hop', 'as-number', 'vlan-id', 'prefix', 'prefix-length', 'port', 'filter-prefix', 'wildcard', 'min-links', 'aggregate-number'])
    // A non-contiguous wildcard approximated as a prefix: the value is gone, so the statement that mapped it gives it away.
    expect(results.find((r) => r.case === 'wildcard')?.problems).toContain('parse: L2 on the malformed value\'s line is mapped')
    // A prefix length out of range, taken as one: found in the model as a number.
    expect(results.find((r) => r.case === 'prefix-length')?.problems).toContain('parse: the malformed value is in the model')
    // An AS number out of range, taken as a number: found in the model by its decimal form.
    expect(results.find((r) => r.case === 'as-number')?.problems).toContain('parse: the malformed value is in the model')
    // The mask's address is in the model, so the statement mapping it is what gives it away.
    expect(results.find((r) => r.case === 'mask')?.problems).toEqual(['parse: L2 on the malformed value\'s line is mapped', 'parse: the malformed value is flagged nowhere: no error, and no unsupported statement on its line'])
  })

  it('passes a render that leaves a limited community out, saying so on its fields, and fails one that doesn\'t say', () => {
    const leavingOut = (kind: 'unsupported' | 'rendered'): PlatformPlugin => ({
      ...probeStub(),
      render: (model, context) => {
        const communities = Object.entries(model.system?.snmp?.communities ?? {})
        const kept = Object.fromEntries(communities.filter(([, c]) => !c.clients?.length))
        const r = probeStub().render!({ ...model, system: { ...model.system, snmp: { ...model.system?.snmp, communities: kept } } }, context)
        const dispositions = { ...r.dispositions }
        for (const [name, c] of communities) if (c.clients?.length) for (const field of ['access', 'clients']) dispositions[fieldPath('system', 'snmp', 'communities', name, field)] = kind === 'unsupported' ? { kind, reason: 'needs an access list' } : { kind, span: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 } }
        return { ...r, dispositions }
      }
    })
    // The render of the kit's own model, from another platform (the stub's parse keeps the community, so its own
    // round trip fails, as it should).
    const snmp = (plugin: PlatformPlugin) => runProbes(plugin, PROBE_STUB_ADAPTER).filter((r) => r.probe === 'snmp-access').map((r) => ({ ...r, problems: r.problems.filter((p) => p.startsWith('render')) }))
    expect(snmp(leavingOut('unsupported')).flatMap((r) => r.problems)).toEqual([])
    expect(snmp(leavingOut('rendered')).flatMap((r) => r.problems)).toContain('render: system.snmp.communities["PROBE-COMMUNITY"].clients is rendered, but the community isn\'t in the text')
  })

  /** The probe stub with its parse wrapped: `after` changes what it returns. */
  const wrapped = (after: (r: ReturnType<NonNullable<PlatformPlugin['parse']>>, text: string) => ReturnType<NonNullable<PlatformPlugin['parse']>>): PlatformPlugin => ({
    ...probeStub(),
    parse: (text, context) => after(probeStub().parse!(text, context), text)
  })
  const probe = (plugin: PlatformPlugin, name: ProbeName) => runProbes(plugin, PROBE_STUB_ADAPTER).filter((r) => r.probe === name)

  it('fails a parse that changes Object.prototype in any way, and puts it back', () => {
    const original = Object.getOwnPropertyDescriptor(Object.prototype, 'toString')!
    // The test changes Object.prototype on purpose, to show the probe catches it; each change is put back and checked.
    /* oxlint-disable no-extend-native */
    const mutations: [string, () => void, string][] = [
      // Same type, another function: a typeof comparison would miss it.
      ['replaces a method', () => Object.defineProperty(Object.prototype, 'toString', { ...original, value: function toString() { return 'x' } }), 'Object.prototype.toString was changed'],
      ['flips a flag', () => Object.defineProperty(Object.prototype, 'toString', { ...original, enumerable: true }), 'Object.prototype.toString was changed'],
      ['adds a hidden property', () => Object.defineProperty(Object.prototype, 'probeAdded', { value: 1, enumerable: false, configurable: true }), 'Object.prototype has a new property probeAdded'],
      ['adds an accessor', () => Object.defineProperty(Object.prototype, 'probeAccessor', { get: () => 1, configurable: true }), 'Object.prototype has a new property probeAccessor']
    ]
    /* oxlint-enable no-extend-native */
    for (const [what, mutate, problem] of mutations) {
      const before = Reflect.ownKeys(Object.prototype).map((k) => [k, Object.getOwnPropertyDescriptor(Object.prototype, k)])
      // Only on the prototype probe's sources: nothing would put it back after the other probes.
      const mutating = wrapped((r, text) => {
        if (/__proto__|constructor|toString/.test(text)) mutate()
        return r
      })
      const results = probe(mutating, 'prototype-keys')
      expect(results.every((r) => r.status === 'failed'), what).toBe(true)
      expect(results[0].problems, what).toContain(problem)
      // Put back after each case, so the rest of the run (and of the test file) sees it as it was.
      expect(Reflect.ownKeys(Object.prototype).map((k) => [k, Object.getOwnPropertyDescriptor(Object.prototype, k)]), what).toEqual(before)
      expect(Object.prototype.toString).toBe(original.value)
    }
  })

  it('fails a render that brings the kit\'s limited community back with other clients or access; passes it exact or left out saying so', () => {
    /** The stub, rendering the kit's own community changed by `edit` (the parse is the stub's). */
    const rendering = (edit: (c: { access?: string; clients?: readonly string[] }) => object): PlatformPlugin => ({
      ...probeStub(),
      render: (model, context) => {
        const communities = Object.fromEntries(Object.entries(model.system?.snmp?.communities ?? {}).map(([name, c]) => [name, name === PROBE_COMMUNITY ? edit(c) : c]))
        return probeStub().render!({ ...model, system: { ...model.system, snmp: { ...model.system?.snmp, communities } } }, context)
      }
    })
    const kitProblems = (plugin: PlatformPlugin) => probe(plugin, 'snmp-access').flatMap((r) => r.problems)
    expect(kitProblems(rendering((c) => ({ ...c, clients: ['0.0.0.0/0'] })))).toContain('render of a limited community → reparse: its clients are ["0.0.0.0/0"], not ["192.0.2.0/24"]')
    expect(kitProblems(rendering((c) => ({ ...c, clients: ['192.0.0.0/16'] })))).toContain('render of a limited community → reparse: its clients are ["192.0.0.0/16"], not ["192.0.2.0/24"]')
    expect(kitProblems(rendering((c) => ({ ...c, access: 'read-write' })))).toContain('render of a limited community → reparse: its access is read-write, not read-only')
    // The careful stub writes it exactly.
    expect(kitProblems(probeStub())).toEqual([])
  })

  it('fails a malformed statement dropped without a word, or ignored by design; passes it unsupported', () => {
    const malformed = (plugin: PlatformPlugin) => probe(plugin, 'malformed').find((r) => r.case === 'ipv4-address')!.problems
    // Gone from the tree, the model and the ledger: nothing says it was there.
    const dropped = wrapped((r, text) => {
      const line = text.split('\n').findIndex((l) => l.includes('999.1.1.1')) + 1
      const tree = r.tree.filter((n) => n.span?.startLine !== line)
      return { ...r, tree, dispositions: Object.fromEntries(Object.entries(r.dispositions).filter(([id]) => tree.some((n) => n.id === id))) }
    })
    expect(malformed(dropped)).toContain('parse: the malformed value is flagged nowhere: no error, and no unsupported statement on its line')
    const asComment = wrapped((r) => ({ ...r, dispositions: Object.fromEntries(Object.entries(r.dispositions).map(([id, d]) => [id, d.kind === 'unsupported' ? { kind: 'ignored-by-design' as const, reason: 'a comment' } : d])) }))
    expect(malformed(asComment)).toContain('parse: L2 on the malformed value\'s line is ignored by design, not flagged')
    expect(malformed(probeStub())).toEqual([])
  })

  it('fails a change in one VRF that moves another VRF\'s or the global table\'s entry into it; passes the VRF\'s own entries', () => {
    const base = 'vrf A\nvrf B\nvrf A route 10.0.0.0/8 192.0.2.1\nname-server 192.0.2.53 vrf B\nname-server 192.0.2.54\ninterface e1\ninterface e1 address 192.0.2.9/24'
    const adapter = (changed: string, from = base): ProbeAdapter => ({ ...PROBE_STUB_ADAPTER, vrfScoping: { ...PROBE_STUB_ADAPTER.vrfScoping, 'static-route': { base: from, changed, vrf: 'A' } } })
    const scoping = (plugin: PlatformPlugin, changed: string, from = base) => runProbes(plugin, adapter(changed, from)).find((r) => r.probe === 'vrf-scoping' && r.case === 'static-route')!.problems
    const changed = base.replace('vrf A route 10.0.0.0/8 192.0.2.1', 'vrf A route 10.0.0.0/8 192.0.2.2')
    /** A parse that, when A's route changes, also moves every name server and interface into A. */
    const migrating = wrapped((r, text) => {
      if (!text.includes('192.0.2.2')) return r
      const m = JSON.parse(JSON.stringify(r.model)) as { system?: { dns?: { servers?: Record<string, { networkInstance?: string }> } }; interfaces?: Record<string, { subinterfaces?: Record<string, { networkInstance?: string }> }> }
      for (const s of Object.values(m.system?.dns?.servers ?? {})) s.networkInstance = 'A'
      for (const i of Object.values(m.interfaces ?? {})) for (const sub of Object.values(i.subinterfaces ?? {})) sub.networkInstance = 'A'
      return { ...r, model: m as typeof r.model }
    })
    const problems = scoping(migrating, changed)
    expect(problems).toContain('a change in VRF A changed system.dns.servers.192.0.2.53.networkInstance, outside it')
    expect(problems).toContain('a change in VRF A changed system.dns.servers.192.0.2.54.networkInstance, outside it')
    expect(problems).toContain('a change in VRF A changed interfaces.e1.subinterfaces.0.networkInstance, outside it')
    // The careful stub: A's route edited, an entry of A's removed, a new one of A's added, all in scope.
    expect(scoping(probeStub(), changed)).toEqual([])
    expect(scoping(probeStub(), `${base}\nname-server 192.0.2.55 vrf A`)).toEqual([])
    const withServer = `${base}\nname-server 192.0.2.56 vrf A`
    expect(scoping(probeStub(), `${withServer}\nno name-server 192.0.2.56 vrf A`, withServer)).toEqual([])
  })

  it('leaves Object.prototype as it was, also for a careless stub', () => {
    const names = Object.getOwnPropertyNames(Object.prototype).sort()
    runProbes(probeStub(['prototype']), PROBE_STUB_ADAPTER)
    expect(Object.getOwnPropertyNames(Object.prototype).sort()).toEqual(names)
    expect(({} as Record<string, unknown>).description).toBeUndefined()
  })

  it('runs the secrets check on probe sources: communities, and the prototype keys used as one', () => {
    // A stub that quotes each statement in its reasons leaks the community.
    const leaky: PlatformPlugin = {
      ...probeStub(),
      parse: (text, context) => {
        const r = probeStub().parse!(text, context)
        return { ...r, diagnostics: text.split('\n').filter(Boolean).map((line) => ({ severity: 'info' as const, message: `read: ${line}` })) }
      }
    }
    const results = runProbes(leaky, PROBE_STUB_ADAPTER)
    expect(results.find((r) => r.probe === 'snmp-access' && r.case === 'read-only')?.problems.some((p) => p.startsWith('secrets:') && p.includes('PLACEHOLDER-RO'))).toBe(true)
    expect(results.find((r) => r.probe === 'prototype-keys' && r.case === 'constructor')?.problems.some((p) => p.startsWith('secrets:'))).toBe(true)
    // The community the negation case cleared is a secret in the negated source too.
    expect(results.find((r) => r.probe === 'negation' && r.case === 'community')?.problems.some((p) => p.startsWith('secrets:') && p.includes('PLACEHOLDER'))).toBe(true)
  })

  it('reports a probe or case a plugin can\'t run as not applicable, with why', () => {
    const adapter: ProbeAdapter = {
      ...PROBE_STUB_ADAPTER,
      prototypeKeys: { source: (PROBE_STUB_ADAPTER.prototypeKeys as { source: (key: string) => string }).source, uses: { interface: true, vrf: true, community: true, dns: { notApplicable: 'no DNS yet' } } },
      snmpAccess: { notApplicable: 'no SNMP yet' },
      negation: { ...PROBE_STUB_ADAPTER.negation, 'name-server': { notApplicable: 'no DNS yet' } }
    }
    const results = runProbes(probeStub(), adapter)
    const na = results.filter((r) => r.status === 'not-applicable').map((r) => `${r.probe}: ${r.case}: ${r.problems.join('')}`)
    expect(na).toEqual(['prototype-keys: as a DNS name: no DNS yet', 'snmp-access: all: no SNMP yet', 'negation: name-server: no DNS yet'])
    expect(failed(results)).toEqual([])
  })

  /** The stub's adapter as one written for model 0.5.1 is: no LAG cases. */
  const adapter051 = (): ProbeAdapter => {
    const { 'aggregate-member': _m, ...negation } = PROBE_STUB_ADAPTER.negation
    const { 'min-links': _l, 'aggregate-number': _n, ...malformed } = PROBE_STUB_ADAPTER.malformed
    const { aggregate: _g, ...unknownReference } = PROBE_STUB_ADAPTER.unknownReference!
    return { ...PROBE_STUB_ADAPTER, negation, malformed, unknownReference }
  }
  /** As one written for model 0.5.0 is: no filter cases either. */
  const adapter05 = (): ProbeAdapter => {
    const { 'filter-term': _t, 'filter-attachment': _a, ...negation } = adapter051().negation
    const { port: _p, 'filter-prefix': _f, wildcard: _w, ...malformed } = adapter051().malformed
    const { filter: _r, ...unknownReference } = adapter051().unknownReference!
    const { implicitAction: _i, ...adapter } = adapter051()
    return { ...adapter, negation, malformed, unknownReference }
  }
  /** As one written for model 0.4 is: no routing policy cases either. */
  const adapter04 = (): ProbeAdapter => {
    const { 'policy-term': _t, 'prefix-list-entry': _e, ...negation } = adapter05().negation
    const { prefix: _p, 'prefix-length': _l, ...malformed } = adapter05().malformed
    const { unknownReference: _r, regex: _x, ...adapter } = adapter05()
    return { ...adapter, negation, malformed }
  }
  const NOT_GIVEN_05 = ['negation: policy-term', 'negation: prefix-list-entry', 'malformed: prefix', 'malformed: prefix-length', 'unknown-reference: prefix-list', 'unknown-reference: community-set', 'unknown-reference: as-path-set', 'unknown-reference: policy', 'regex']
  const NOT_GIVEN_051 = ['negation: filter-term', 'negation: filter-attachment', 'malformed: port', 'malformed: filter-prefix', 'malformed: wildcard', 'unknown-reference: filter', 'implicit-action']
  const NOT_GIVEN_054 = ['negation: aggregate-member', 'malformed: min-links', 'malformed: aggregate-number', 'unknown-reference: aggregate']

  it('runs an adapter written before model 0.4.0 as before, and lists the 0.4.0, 0.5.0, 0.5.1 and 0.5.4 cases it leaves out', () => {
    // As an adapter for 0.3 is: no VLAN or BGP group use, no BGP, OSPF, AS or VLAN cases, and no routing policy.
    const { 'bgp-neighbor': _n, 'ospf-interface': _o, ...negation } = adapter04().negation
    const { 'as-number': _a, 'vlan-id': _v, ...malformed } = adapter04().malformed
    const { ospf: _os, bgp: _b, ...vrfScoping } = PROBE_STUB_ADAPTER.vrfScoping
    const proto = PROBE_STUB_ADAPTER.prototypeKeys as Exclude<ProbeAdapter['prototypeKeys'], { notApplicable: string }>
    const adapter: ProbeAdapter = {
      ...adapter04(),
      prototypeKeys: { source: proto.source, uses: { interface: true, vrf: true, community: true, dns: true } },
      negation,
      malformed,
      vrfScoping
    }
    const results = runProbes(probeStub(), adapter)
    expect(results).toHaveLength(17)
    expect(results.filter((r) => r.status !== 'passed')).toEqual([])
    const notGiven04 = ['prototype-keys: as a VLAN name', 'prototype-keys: as a BGP group', 'negation: bgp-neighbor', 'negation: ospf-interface', 'malformed: as-number', 'malformed: vlan-id', 'vrf-scoping: ospf', 'vrf-scoping: bgp']
    expect(probesNotGiven(adapter).sort()).toEqual([...notGiven04, ...NOT_GIVEN_05, ...NOT_GIVEN_051, ...NOT_GIVEN_054].sort())
    // The suite shows them as one skipped test per model version.
    expect(probesNotGivenByModel(adapter)).toEqual([
      ['0.4.0', ['prototype-keys: as a VLAN name', 'prototype-keys: as a BGP group', 'negation: bgp-neighbor', 'negation: ospf-interface', 'malformed: as-number', 'malformed: vlan-id', 'vrf-scoping: ospf', 'vrf-scoping: bgp']],
      ['0.5.0', NOT_GIVEN_05],
      ['0.5.1', NOT_GIVEN_051],
      ['0.5.4', NOT_GIVEN_054]
    ])
    // Declared not applicable, a 0.4.0 case is reported as such, and isn't "not given".
    const declared: ProbeAdapter = { ...adapter, negation: { ...negation, 'bgp-neighbor': { notApplicable: 'no BGP yet' } } }
    expect(runProbes(probeStub(), declared).filter((r) => r.status === 'not-applicable').map((r) => `${r.probe}: ${r.case}: ${r.problems.join('')}`)).toEqual(['negation: bgp-neighbor: no BGP yet'])
    expect(probesNotGiven(declared)).not.toContain('negation: bgp-neighbor')
  })

  it('runs an adapter written for model 0.4 as before, and lists the 0.5.0, 0.5.1 and 0.5.4 cases it leaves out', () => {
    const results = runProbes(probeStub(), adapter04())
    expect(results).toHaveLength(23)
    expect(results.filter((r) => r.status !== 'passed')).toEqual([])
    expect(probesNotGivenByModel(adapter04())).toEqual([['0.5.0', NOT_GIVEN_05], ['0.5.1', NOT_GIVEN_051], ['0.5.4', NOT_GIVEN_054]])
    // Declared not applicable, they are reported as such, and aren't "not given".
    const declared: ProbeAdapter = { ...adapter04(), unknownReference: { 'prefix-list': { notApplicable: 'no policy yet' }, 'community-set': { notApplicable: 'no policy yet' }, 'as-path-set': { notApplicable: 'no policy yet' }, policy: { notApplicable: 'no policy yet' } }, regex: { notApplicable: 'no policy yet' } }
    expect(runProbes(probeStub(), declared).filter((r) => r.status === 'not-applicable').map((r) => `${r.probe}: ${r.case}`)).toEqual(['unknown-reference: prefix-list', 'unknown-reference: community-set', 'unknown-reference: as-path-set', 'unknown-reference: policy', 'regex: all'])
    expect(probesNotGiven(declared)).toEqual(['negation: policy-term', 'negation: prefix-list-entry', 'negation: filter-term', 'negation: filter-attachment', 'negation: aggregate-member', 'malformed: prefix', 'malformed: prefix-length', 'malformed: port', 'malformed: filter-prefix', 'malformed: wildcard', 'malformed: min-links', 'malformed: aggregate-number', 'unknown-reference: filter', 'unknown-reference: aggregate', 'implicit-action'])
  })

  it('runs an adapter written for model 0.5.0 as before, and lists the 0.5.1 and 0.5.4 cases it leaves out', () => {
    const results = runProbes(probeStub(), adapter05())
    expect(results).toHaveLength(32)
    expect(results.filter((r) => r.status !== 'passed')).toEqual([])
    expect(probesNotGivenByModel(adapter05())).toEqual([['0.5.1', NOT_GIVEN_051], ['0.5.4', NOT_GIVEN_054]])
  })

  it('runs an adapter written for model 0.5.1 as before, and lists the 0.5.4 cases it leaves out (#107)', () => {
    const results = runProbes(probeStub(), adapter051())
    expect(results).toHaveLength(39)
    expect(results.filter((r) => r.status !== 'passed')).toEqual([])
    expect(probesNotGivenByModel(adapter051())).toEqual([['0.5.4', NOT_GIVEN_054]])
    // Declared not applicable, they are reported as such, and aren't "not given".
    const lagless = { notApplicable: 'no LAGs yet' }
    const declared: ProbeAdapter = { ...adapter051(), negation: { ...adapter051().negation, 'aggregate-member': lagless }, malformed: { ...adapter051().malformed, 'min-links': lagless, 'aggregate-number': lagless }, unknownReference: { ...adapter051().unknownReference!, aggregate: lagless } }
    expect(runProbes(probeStub(), declared).filter((r) => r.status === 'not-applicable').map((r) => `${r.probe}: ${r.case}`)).toEqual(['negation: aggregate-member', 'malformed: min-links', 'malformed: aggregate-number', 'unknown-reference: aggregate'])
    expect(probesNotGiven(declared)).toEqual([])
  })

  it('passes a filter rendered with its implicit action said; fails one that says it only as info, on another filter, or for a filter that decides every packet', () => {
    /** The stub, its implicit-action warning changed by `edit`. */
    const saying = (edit: (d: Diagnostic) => Diagnostic): PlatformPlugin => ({
      ...probeStub(),
      render: (model, context) => {
        const r = probeStub().render!(model, context)
        return { ...r, diagnostics: r.diagnostics.map((d) => (d.code === 'probe-stub.implicit-action' ? edit(d) : d)) }
      }
    })
    const implicit = (plugin: PlatformPlugin) => probe(plugin, 'implicit-action').flatMap((r) => r.problems)
    expect(implicit(probeStub())).toEqual([])
    expect(implicit(saying((d) => ({ ...d, field: fieldPath('filters', 'ipv4', 'PROBE-FILTER') })))).toEqual([])
    const missing = 'render of a filter whose implicit action is deny, the plugin\'s own, relying on it: no semantic warning on the filter, though some packets reach its implicit action'
    expect(implicit(saying((d) => ({ ...d, severity: 'info' })))).toContain(missing)
    expect(implicit(saying((d) => ({ ...d, field: fieldPath('filters', 'ipv4', 'PROBE-FILTER-2', 'implicitAction') })))).toContain(missing)
    // Warning on every filter, a catch-all one of the plugin's own default included, is noise that hides the real ones.
    const always: PlatformPlugin = {
      ...probeStub(),
      render: (model, context) => {
        const r = probeStub().render!(model, context)
        const filters = Object.keys(model.filters?.ipv4 ?? {}).map((name): Diagnostic => ({ severity: 'warning', category: 'semantic', message: 'Check the end of this filter.', field: fieldPath('filters', 'ipv4', name, 'implicitAction') }))
        return { ...r, diagnostics: [...r.diagnostics, ...filters] }
      }
    }
    expect(implicit(always)).toEqual(['render of a filter whose implicit action is deny, the plugin\'s own, with a final term deciding every packet: a semantic warning on the filter, though no packet reaches its implicit action and the plugin\'s platform does the same'])
  })

  it('passes a render that translates another dialect\'s regex and says so; fails one that leaves it out as not applicable', () => {
    /** The stub, writing another dialect's regexes with `kind` and, when `warn`, a semantic warning on each set. */
    const translating = (kind: 'rendered' | 'not-applicable', warn: boolean): PlatformPlugin => ({
      ...probeStub(),
      render: (model, context) => {
        const r = probeStub().render!(model, context)
        const dispositions = { ...r.dispositions }
        const diagnostics = [...r.diagnostics]
        for (const [path, d] of Object.entries(r.dispositions))
          if (d.kind === 'unsupported' && /\.regexe?s?$/.test(path)) {
            dispositions[path] = kind === 'rendered' ? { kind, span: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 } } : { kind, reason: 'left out' }
            if (warn) diagnostics.push({ severity: 'warning', category: 'semantic', message: 'A regex was translated from another dialect.', field: path })
          }
        return { ...r, dispositions, diagnostics }
      }
    })
    const regex = (plugin: PlatformPlugin) => probe(plugin, 'regex').flatMap((r) => r.problems).filter((p) => p.startsWith('render of'))
    expect(regex(translating('rendered', true))).toEqual([])
    expect(regex(translating('rendered', false))).toHaveLength(2)
    expect(regex(translating('not-applicable', true))).toContain('render of a junos regex: routingPolicy.asPathSets["PROBE-AS-PATH"].entries["1"].regex is not-applicable, but a regex left out is unsupported')
    expect(regex(probeStub())).toEqual([])
  })

  it('fails a regex the parse rewrites, or keeps without a dialect', () => {
    const rewriting = wrapped((r) => JSON.parse(JSON.stringify(r).replaceAll('_65000_', '^65000$')) as typeof r)
    expect(probe(rewriting, 'regex').flatMap((r) => r.problems)).toContain('parse: the case\'s regex 1 isn\'t in the model as written')
    const undialected = wrapped((r) => JSON.parse(JSON.stringify(r).replaceAll('"regexDialect":"cisco"', '"regexDialect":null')) as typeof r)
    expect(probe(undialected, 'regex').flatMap((r) => r.problems)).toContain('parse: the source\'s regexes are said to be in 0 dialects, not its one')
  })

  it('fails a case that tests nothing: a negation with nothing to clear, a VRF change that changes nothing', () => {
    const results = runProbes(probeStub(), {
      ...PROBE_STUB_ADAPTER,
      negation: { ...PROBE_STUB_ADAPTER.negation, description: { set: 'interface e1', negated: 'interface e1', path: ['interfaces', 'e1', 'description'] } },
      vrfScoping: { ...PROBE_STUB_ADAPTER.vrfScoping, dns: { base: 'vrf A', changed: 'vrf A', vrf: 'A' } }
    })
    expect(results.find((r) => r.case === 'description')?.problems).toContain('the case\'s set source has nothing at interfaces.e1.description')
    expect(results.find((r) => r.probe === 'vrf-scoping' && r.case === 'dns')?.problems).toContain('the case changes nothing in the model')
  })

  it('fails every probe for a plugin with no parse or render', () => {
    const { parse: _parse, ...noParse } = probeStub()
    expect(runProbes(noParse, PROBE_STUB_ADAPTER).map((r) => [r.probe, r.status])).toEqual(['prototype-keys', 'snmp-access', 'negation', 'malformed', 'vrf-scoping', 'unknown-reference', 'regex', 'implicit-action'].map((p) => [p, 'failed']))
  })
})

// The suite: the careful probe stub with its adapter, every probe a test. (conformance.test.ts runs the brace stub,
// which has no adapter: its probes show as one skipped test.)
describeConformance(probeStub(), new URL('./probe-fixtures', import.meta.url), { probes: PROBE_STUB_ADAPTER })
