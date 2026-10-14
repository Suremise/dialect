// Routing instances beyond the conformance fixtures (tests/fixtures/conformance/routing-instances): a VRF the model
// gives without a route distinguisher or route targets is written with needs-input items, never with made-up values;
// a unit in two instances is an error, in neither; vrf-target import and export override the plain one; instance types
// this plugin doesn't convert are converted not at all; and VRF names that look like Object.prototype's or like a
// secret stay ordinary keys and out of every message.
import { describe, expect, it } from 'vitest'
import { buildLedger, ledgerProblems, MODEL_VERSION, type Device, type ParseResult, type RenderResult } from '@dialect/core'
import { checkFixture } from '@dialect/conformance'
import plugin, { parse, render, routeDistinguisherInputId, routeTargetInputId } from '../src'

const context = { modelVersion: MODEL_VERSION }
const set = (...lines: string[]): string => lines.join('\n') + '\n'
const kinds = (p: ParseResult): string[] => Object.values(p.dispositions).map((d) => d.kind)

/** Every message a parse or a render gives: reasons, diagnostics and needs-input items. */
const told = (p: ParseResult | undefined, r?: RenderResult): string[] => [
  ...Object.values(p?.dispositions ?? {}).flatMap((d) => (d.kind === 'mapped' ? [] : [d.reason ?? ''])),
  ...(p?.diagnostics ?? []).map((d) => d.message),
  ...Object.values(r?.dispositions ?? {}).flatMap((d) => (d.kind === 'rendered' ? [] : [d.reason ?? ''])),
  ...(r?.diagnostics ?? []).map((d) => d.message),
  ...(r?.needsInput ?? []).flatMap((n) => [n.message, ...(n.suggestions ?? [])])
]

describe('a VRF without a route distinguisher or route targets', () => {
  const model: Device = { interfaces: { 'ge-0/0/1': { subinterfaces: { '10': { networkInstance: 'CUST' } } } }, networkInstances: { CUST: { type: 'vrf' } } }

  it('is written with what it has, each missing part asked for, nothing made up', () => {
    const r = render(model, context)
    expect(r.text).toContain('routing-instances {\n    CUST {\n        instance-type vrf;\n        interface ge-0/0/1.10;\n    }\n}\n')
    expect(r.text).not.toMatch(/route-distinguisher|vrf-target/)
    expect(r.needsInput).toEqual([
      { id: routeDistinguisherInputId('CUST'), kind: 'other', message: "This VRF needs a route distinguisher on Junos (ASN:nn or IP:nn), which the source doesn't give.", field: 'networkInstances.CUST' },
      {
        id: routeTargetInputId('CUST'),
        kind: 'other',
        message: "This VRF needs a route target on Junos (target:ASN:nn or target:IP:nn) for the routes it imports or exports, which the source doesn't give.",
        field: 'networkInstances.CUST'
      }
    ])
    expect(ledgerProblems(buildLedger(parse('', context), r, model))).toEqual([])
  })

  it("is written with the user's answers, a 4-byte AS with its L, and an answer in another form is left unused", () => {
    const answered = render(model, { ...context, inputs: { [routeDistinguisherInputId('CUST')]: '4200000000L:7', [routeTargetInputId('CUST')]: 'target:65000:7' } })
    expect(answered.text).toContain('        route-distinguisher 4200000000L:7;\n        vrf-target target:65000:7;\n')
    expect(answered.needsInput).toBeUndefined()
    // A route target answers with or without its target: prefix.
    expect(render(model, { ...context, inputs: { [routeTargetInputId('CUST')]: '192.0.2.1:7' } }).text).toContain('vrf-target target:192.0.2.1:7;')
    const wrong = render(model, { ...context, inputs: { [routeDistinguisherInputId('CUST')]: 'not-an-rd' } })
    expect(wrong.text).not.toContain('route-distinguisher')
    expect(wrong.needsInput?.map((n) => n.id)).toEqual([routeDistinguisherInputId('CUST'), routeTargetInputId('CUST')])
    expect(wrong.diagnostics.map((d) => [d.severity, d.code])).toEqual([['warning', 'junos.input-form']])
  })

  it('with one side of its route targets is asked for the other, which the answer fills', () => {
    const half: Device = { networkInstances: { CUST: { type: 'vrf', routeDistinguisher: '65000:1', routeTargets: { import: ['65000:1'] } } } }
    expect(render(half, context).needsInput?.map((n) => n.id)).toEqual([routeTargetInputId('CUST')])
    const r = render(half, { ...context, inputs: { [routeTargetInputId('CUST')]: 'target:65000:2' } })
    expect(r.text).toContain('        vrf-target {\n            import target:65000:1;\n            export target:65000:2;\n        }\n')
    expect(r.dispositions['networkInstances.CUST.routeTargets.import']).toMatchObject({ kind: 'rendered' })
  })

  it.each([
    ['empty lists', { import: [], export: [] }],
    ['malformed targets', { import: ['not-a-target'], export: ['not-a-target'] }],
    ['several targets each way', { import: ['65000:1', '65000:2'], export: ['65000:3', '65000:4'] }]
  ])('with %s takes the answer for both sides, or is asked for one', (_, routeTargets) => {
    const bare: Device = { networkInstances: { A: { type: 'vrf', routeDistinguisher: '65000:1', routeTargets } } }
    const asked = render(bare, context)
    expect(asked.text).not.toContain('vrf-target')
    expect(asked.needsInput?.map((n) => n.id)).toEqual([routeTargetInputId('A')])
    const answered = render(bare, { ...context, inputs: { [routeTargetInputId('A')]: 'target:65000:9' } })
    expect(answered.text).toContain('        vrf-target target:65000:9;\n')
    expect(answered.needsInput).toBeUndefined()
    // The model's own lists are still accounted for as not written.
    expect(answered.dispositions['networkInstances.A.routeTargets.import']?.kind).not.toBe('rendered')
    expect(ledgerProblems(buildLedger(parse('', context), answered, bare))).toEqual([])
  })

  it('asks nothing of a virtual router, which has no route distinguisher or targets', () => {
    const r = render({ networkInstances: { T: { type: 'virtual-router', routeDistinguisher: '65000:1', routeTargets: { import: ['65000:1'], export: ['65000:1'] } } } }, context)
    expect(r.text).toBe('routing-instances {\n    T {\n        instance-type virtual-router;\n    }\n}\n')
    expect(r.needsInput).toBeUndefined()
    for (const f of ['routeDistinguisher', 'routeTargets.import', 'routeTargets.export']) expect(r.dispositions[`networkInstances.T.${f}`]).toMatchObject({ kind: 'unsupported', reason: 'a virtual router has no route distinguisher or route targets' })
  })
})

describe('a unit in a routing instance', () => {
  it('in two instances is an error, by its lines, and in neither', () => {
    const p = parse(set('set interfaces ge-0/0/0 unit 0 family inet address 192.0.2.1/30', 'set routing-instances A instance-type vrf', 'set routing-instances A interface ge-0/0/0.0', 'set routing-instances B instance-type vrf', 'set routing-instances B interface ge-0/0/0.0'), context)
    expect(p.diagnostics).toEqual([
      { severity: 'error', category: 'semantic', code: 'junos.unit-in-two-instances', message: 'A unit is in two routing instances (lines 3, 5): Junos accepts it in one only.', span: { startLine: 5, startColumn: 1, endLine: 5, endColumn: 1 }, statement: 'L5' }
    ])
    expect(p.model.interfaces?.['ge-0/0/0'].subinterfaces?.['0'].networkInstance).toBeUndefined()
    expect(kinds(p)).toEqual(['mapped', 'mapped', 'unsupported', 'mapped', 'unsupported'])
  })

  it('named twice in one instance (here once by a group) is in it once', () => {
    const p = parse(set('set groups G routing-instances A interface ge-0/0/0.0', 'set apply-groups G', 'set routing-instances A instance-type vrf', 'set routing-instances A interface ge-0/0/0.0'), context)
    expect(p.diagnostics).toEqual([])
    expect(p.model.interfaces).toEqual({ 'ge-0/0/0': { type: 'ethernet', subinterfaces: { '0': { networkInstance: 'A' } } } })
    expect(Object.values(p.dispositions).filter((d) => d.kind === 'ignored-by-design').map((d) => d.reason)).toContain('already in the routing instance')
  })

  it("is a unit: irb and lo0 units are, an interface without its unit isn't", () => {
    const p = parse(set('set routing-instances A interface irb.100', 'set routing-instances A interface lo0.1', 'set routing-instances A interface ge-0/0/0'), context)
    expect(p.model.interfaces).toEqual({ irb: { type: 'vlan', subinterfaces: { '100': { networkInstance: 'A' } } }, lo0: { type: 'loopback', subinterfaces: { '1': { networkInstance: 'A' } } } })
    expect(kinds(p)).toEqual(['mapped', 'mapped', 'unsupported'])
  })
})

describe('vrf-target', () => {
  it('sets both sides, and an import or export overrides its side', () => {
    const p = parse(set('set routing-instances A instance-type vrf', 'set routing-instances A vrf-target target:65000:1', 'set routing-instances A vrf-target import target:65000:2'), context)
    expect(p.model.networkInstances?.A.routeTargets).toEqual({ import: ['65000:2'], export: ['65000:1'] })
    const both = parse(set('set routing-instances A vrf-target target:65000:1', 'set routing-instances A vrf-target import target:65000:2', 'set routing-instances A vrf-target export target:65000:3'), context)
    expect(both.model.networkInstances?.A.routeTargets).toEqual({ import: ['65000:2'], export: ['65000:3'] })
    expect(Object.values(both.dispositions).map((d) => (d.kind === 'ignored-by-design' ? d.reason : d.kind))).toEqual(['overridden by vrf-target import and export', 'mapped', 'mapped'])
  })

  it.each([
    ['set routing-instances A vrf-target auto', "vrf-target auto (route targets from the AS number) isn't converted yet"],
    ['set routing-instances A vrf-target 65000:1', 'not a route target in a form the model has (target:ASN:nn or target:IP:nn)'],
    ['set routing-instances A route-distinguisher 100L:1', 'not a route distinguisher in a form the model has (ASN:nn, IP:nn or a 4-byte AS with L)'],
    ['set routing-instances A route-distinguisher 65000:99999999999', 'not a route distinguisher in a form the model has (ASN:nn, IP:nn or a 4-byte AS with L)'],
    ['set routing-instances A vrf-import IMPORT-POLICY', 'VRF import and export policies come later, with routing policy']
  ])('leaves %s unsupported', (line, reason) => {
    const p = parse(set(line), context)
    expect(Object.values(p.dispositions)).toEqual([{ kind: 'unsupported', reason }])
    expect(p.model).toEqual({})
  })
})

describe('an instance type from a group', () => {
  const VRF = { type: 'vrf', routeDistinguisher: '65000:1', routeTargets: { import: ['65000:1'], export: ['65000:1'] } }
  const local = ['set routing-instances A instance-type vrf', 'set routing-instances A interface ge-0/0/0.0', 'set routing-instances A route-distinguisher 65000:1', 'set routing-instances A vrf-target target:65000:1']
  const hierarchical = (groupType: string) =>
    `groups {\n    G {\n        routing-instances {\n            A {\n                instance-type ${groupType};\n            }\n        }\n    }\n}\napply-groups G;\nrouting-instances {\n    A {\n        instance-type vrf;\n        interface ge-0/0/0.0;\n        route-distinguisher 65000:1;\n        vrf-target target:65000:1;\n    }\n}\n`

  it.each([
    ['set', set('set groups G routing-instances A instance-type mac-vrf', 'set apply-groups G', ...local)],
    ['hierarchical', hierarchical('mac-vrf')]
  ])("gives way to the instance's own, in %s form: the VRF converts and the group's type is superseded", (_, text) => {
    const p = parse(text, context)
    expect(p.model.networkInstances?.A).toEqual(VRF)
    expect(p.model.interfaces?.['ge-0/0/0'].subinterfaces?.['0'].networkInstance).toBe('A')
    expect(p.diagnostics).toEqual([])
    expect(Object.values(p.dispositions).filter((d) => d.kind === 'unsupported')).toEqual([])
    expect(Object.values(p.dispositions).some((d) => d.kind === 'ignored-by-design' && /^superseded by line \d+$/.test(d.reason ?? ''))).toBe(true)
  })

  it('of two groups is the earlier one\'s, as for any setting: a VRF over a mac-vrf, or the instance not converted', () => {
    const groups = (first: string, second: string) => set(`set groups G1 routing-instances A instance-type ${first}`, `set groups G2 routing-instances A instance-type ${second}`, 'set apply-groups [ G1 G2 ]', 'set routing-instances A route-distinguisher 65000:1', 'set routing-instances A vrf-target target:65000:1')
    expect(parse(groups('vrf', 'mac-vrf'), context).model.networkInstances?.A).toEqual(VRF)
    const other = parse(groups('mac-vrf', 'vrf'), context)
    expect(other.model).toEqual({})
    // The mac-vrf group's type, then everything else of the instance: the other group's vrf, its RD and its vrf-target.
    expect(Object.values(other.dispositions).filter((d) => d.kind === 'unsupported').map((d) => d.kind === 'unsupported' && d.reason)).toEqual([
      'routing instances other than VRFs and virtual routers come later',
      "the routing instance's type isn't converted, so none of it is",
      "the routing instance's type isn't converted, so none of it is",
      "the routing instance's type isn't converted, so none of it is"
    ])
  })

  it("doesn't taint an instance when its own type is one converted, set before or after a group's other type", () => {
    const p = parse(set('set routing-instances A instance-type mac-vrf', 'set routing-instances A instance-type virtual-router'), context)
    expect(p.model.networkInstances?.A).toEqual({ type: 'virtual-router' })
    expect(Object.values(p.dispositions).map((d) => (d.kind === 'ignored-by-design' ? d.reason : d.kind))).toEqual(['superseded by line 2', 'mapped'])
  })
})

describe('an instance of a type this plugin does not convert', () => {
  it('is converted not at all: its route distinguisher, targets and units neither', () => {
    const p = parse(set('set routing-instances L2 instance-type mac-vrf', 'set routing-instances L2 route-distinguisher 65000:1', 'set routing-instances L2 vrf-target target:65000:1', 'set routing-instances L2 interface irb.200', 'set interfaces irb unit 200 family inet address 192.0.2.1/24'), context)
    expect(p.model).toEqual({ interfaces: { irb: { type: 'vlan', subinterfaces: { '200': { ipv4: { addresses: { '192.0.2.1': { prefixLength: 24 } } } } } } } })
    expect(kinds(p)).toEqual(['unsupported', 'unsupported', 'unsupported', 'unsupported', 'mapped'])
  })
})

describe('render from another platform', () => {
  it("writes VRFs in Junos terms, saying what it can't", () => {
    const model: Device = {
      interfaces: {
        GigabitEthernet1: { subinterfaces: { '0': { networkInstance: 'RED' } } },
        GigabitEthernet2: { subinterfaces: { '0': { networkInstance: 'GONE' } } },
        GigabitEthernet3: { subinterfaces: { '0': { networkInstance: 'default' } } }
      },
      networkInstances: { RED: { type: 'vrf', routeDistinguisher: '4200000000:1', routeTargets: { import: ['65000:1', '65000:2'], export: ['65000:1'] } }, default: { routeDistinguisher: '65000:9' } }
    }
    const r = render(model, context)
    expect(r.text).toContain('    RED {\n        instance-type vrf;\n        interface GigabitEthernet1.0;\n        route-distinguisher 4200000000L:1;\n        vrf-target {\n            export target:65000:1;\n        }\n    }\n')
    expect(r.dispositions['networkInstances.RED.routeTargets.import']).toMatchObject({ kind: 'unsupported', reason: 'more than one route target needs a vrf-import or vrf-export policy, which comes later' })
    expect(r.dispositions['interfaces.GigabitEthernet2.subinterfaces["0"].networkInstance']).toMatchObject({ kind: 'unsupported', reason: "names a routing instance the model doesn't have" })
    expect(r.dispositions['interfaces.GigabitEthernet3.subinterfaces["0"].networkInstance']).toMatchObject({ kind: 'not-applicable' })
    expect(r.dispositions['networkInstances.default.routeDistinguisher']).toMatchObject({ kind: 'unsupported', reason: 'the global routing table has no route distinguisher or route targets' })
    // Its import side has none Junos can write, so it is asked for.
    expect(r.needsInput?.map((n) => n.id)).toEqual([routeTargetInputId('RED')])
    expect(ledgerProblems(buildLedger(parse('', context), r, model))).toEqual([])
  })
})

describe('VRF names', () => {
  it('that look like Object.prototype keys are ordinary keys through parse, render and reparse', () => {
    const text = set('set routing-instances __proto__ instance-type vrf', 'set routing-instances __proto__ interface ge-0/0/0.0', 'set routing-instances __proto__ route-distinguisher 65000:1', 'set routing-instances __proto__ vrf-target target:65000:1', 'set routing-instances constructor instance-type virtual-router', 'set routing-instances constructor interface ge-0/0/1.0')
    const before = Object.getOwnPropertyNames(Object.prototype).sort()
    const p = parse(text, context)
    expect(Object.keys(p.model.networkInstances!)).toEqual(['__proto__', 'constructor'])
    expect(p.model.interfaces!['ge-0/0/0'].subinterfaces!['0'].networkInstance).toBe('__proto__')
    expect(checkFixture(plugin, { name: 'safe VRF keys', source: text, expectedModel: p.model }).filter((c) => c.status === 'failed')).toEqual([])
    expect(Object.getOwnPropertyNames(Object.prototype).sort()).toEqual(before)
  })

  it('that share a secret value stay out of every message, needs-input items included', () => {
    const secret = 'PLACEHOLDER-RO'
    const p = parse(set(`set snmp community ${secret} authorization read-only`, `set routing-instances ${secret} instance-type vrf`, `set routing-instances ${secret} interface ge-0/0/0.0`, 'set routing-instances B interface ge-0/0/0.0', `set routing-instances ${secret} vrf-target auto`), context)
    const r = render({ networkInstances: { [secret]: { type: 'vrf' } } }, context)
    expect(r.needsInput).toHaveLength(2)
    for (const text of told(p, r)) expect(text).not.toContain(secret)
  })
})
