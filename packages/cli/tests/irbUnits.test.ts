// IRB units through convert (#80): a Junos `irb` with several units is named unit by unit (`irb.100`), each its own
// needs-input item, and each unit becomes its own SVI on IOS-XE and NX-OS (`Vlan100`) once the user takes the target's
// suggestion. The other way, Cisco's `Vlan100` is suggested as Junos's `irb.100`, and SVIs become units of one `irb`.
import { describe, expect, it } from 'vitest'
import { convert, interfaceInputs, MODEL_VERSION, modelProblems, type PlatformPlugin } from '@dialect/core'
import iosxe from '@dialect/platform-iosxe'
import iosxr from '@dialect/platform-iosxr'
import junos from '@dialect/platform-junos'
import nxos from '@dialect/platform-nxos'

const JUNOS = [
  'set interfaces ge-0/0/0 unit 0 family inet address 192.0.2.1/24',
  ...[100, 200, 300].flatMap((n) => [`set interfaces irb unit ${n} family inet address 10.${n / 100}.0.1/24`, `set vlans v${n} vlan-id ${n}`, `set vlans v${n} l3-interface irb.${n}`])
].join('\n')
const UNITS = ['irb.100', 'irb.200', 'irb.300']

describe('IRB units to SVIs', () => {
  it.each([
    ['iosxe', iosxe],
    ['nxos', nxos]
  ] as const)('Junos → %s: one row per unit, each suggested as its own Vlan, and each converted once the suggestion is taken', (_name, target) => {
    const before = convert(junos, target, JUNOS, { modelVersion: MODEL_VERSION })
    expect(before.parse.diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    expect(before.interfaces.map((i) => i.source)).toEqual(['ge-0/0/0', ...UNITS])
    expect(before.interfaces.filter((i) => UNITS.includes(i.source)).map((i) => i.suggestion)).toEqual(['Vlan100', 'Vlan200', 'Vlan300'])
    // Each unit is its own needs-input item, pointing at its unit; none is answered by the suggestion alone.
    const unit = before.unanswered.find((n) => n.id === 'interface:irb.200')
    expect(unit).toMatchObject({ kind: 'interface-name', field: 'interfaces.irb.subinterfaces["200"]', suggestions: ['Vlan200'] })

    const taken = Object.fromEntries(before.interfaces.map((i) => [i.source, i.suggestion ?? 'Ethernet1/1']))
    const after = convert(junos, target, JUNOS, { modelVersion: MODEL_VERSION, inputs: interfaceInputs(taken) })
    expect(after.unanswered.filter((n) => n.kind === 'interface-name')).toEqual([])
    expect(after.ledger.diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    const interfaces = after.model.interfaces ?? {}
    expect(Object.keys(interfaces).filter((n) => n.startsWith('Vlan'))).toEqual(['Vlan100', 'Vlan200', 'Vlan300'])
    for (const n of [100, 200, 300]) {
      expect(interfaces[`Vlan${n}`]).toMatchObject({ type: 'irb-or-svi', subinterfaces: { '0': { routedVlan: n, ipv4: { addresses: { [`10.${n / 100}.0.1`]: { prefixLength: 24 } } } } } })
      expect(after.render?.text).toMatch(new RegExp(`^interface Vlan${n}$`, 'm'))
      expect(after.render?.text).toContain(`10.${n / 100}.0.1`)
    }
    expect(modelProblems(after.model, { policyReferences: false })).toEqual([])
    // Every field of every unit was written: no issue says one wasn't.
    expect(after.issues.filter((i) => i.kind === 'not-rendered')).toEqual([])
  })

  it('leaves a unit with no answer a needs-input item, in its source interface, while the others convert', () => {
    const r = convert(junos, iosxe, JUNOS, { modelVersion: MODEL_VERSION, inputs: interfaceInputs({ 'ge-0/0/0': 'GigabitEthernet0/0/0', 'irb.100': 'Vlan100', 'irb.300': 'Vlan300' }) })
    expect(r.unanswered.filter((n) => n.kind === 'interface-name').map((n) => n.id)).toEqual(['interface:irb.200'])
    expect(Object.keys(r.model.interfaces ?? {})).toEqual(['GigabitEthernet0/0/0', 'Vlan100', 'irb', 'Vlan300'])
    expect(Object.keys(r.model.interfaces?.irb.subinterfaces ?? {})).toEqual(['200'])
  })

  it('refuses two units given one SVI, keeping both', () => {
    const r = convert(junos, iosxe, JUNOS, { modelVersion: MODEL_VERSION, inputs: interfaceInputs({ 'irb.100': 'Vlan100', 'irb.200': 'Vlan100' }) })
    expect(r.ledger.diagnostics.map((d) => d.code)).toContain('convert.interface-name-taken')
    expect(r.unanswered.map((n) => n.id)).toEqual(expect.arrayContaining(['interface:irb.100', 'interface:irb.200']))
    expect(Object.keys(r.model.interfaces?.irb.subinterfaces ?? {})).toEqual(['100', '200', '300'])
  })

  it('suggests nothing for IOS-XR, whose BVIs aren\'t written yet', () => {
    const r = convert(junos, iosxr, JUNOS, { modelVersion: MODEL_VERSION })
    expect(r.interfaces.filter((i) => UNITS.includes(i.source)).map((i) => i.suggestion)).toEqual([undefined, undefined, undefined])
  })
})

describe('SVIs to IRB units', () => {
  const sources: readonly (readonly [string, PlatformPlugin, string])[] = [
    ['iosxe', iosxe, ['vlan 100', 'vlan 200', 'interface Vlan100', ' description users', ' ip address 10.1.0.1 255.255.255.0', 'interface Vlan200', ' ip address 10.2.0.1 255.255.255.0', ''].join('\n')],
    ['nxos', nxos, ['feature interface-vlan', 'vlan 100', 'vlan 200', 'interface Vlan100', '  description users', '  ip address 10.1.0.1/24', 'interface Vlan200', '  ip address 10.2.0.1/24', ''].join('\n')]
  ]

  it.each(sources)('%s → Junos: each Vlan suggested as its IRB unit, and the SVIs become units of one irb', (_name, source, text) => {
    const before = convert(source, junos, text, { modelVersion: MODEL_VERSION })
    expect(before.parse.diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    expect(before.interfaces.map((i) => [i.source, i.suggestion])).toEqual([
      ['Vlan100', 'irb.100'],
      ['Vlan200', 'irb.200']
    ])
    const after = convert(source, junos, text, { modelVersion: MODEL_VERSION, inputs: interfaceInputs({ Vlan100: 'irb.100', Vlan200: 'irb.200' }) })
    expect(after.ledger.diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    expect(Object.keys(after.model.interfaces ?? {})).toEqual(['irb'])
    // The SVI's description goes to its unit, where Junos says it for each VLAN.
    expect(after.model.interfaces?.irb).toMatchObject({ type: 'irb-or-svi', subinterfaces: { '100': { routedVlan: 100, description: 'users' }, '200': { routedVlan: 200 } } })
    expect(after.model.interfaces?.irb.description).toBeUndefined()
    expect(modelProblems(after.model, { policyReferences: false })).toEqual([])
    expect(after.render?.text).toMatch(/unit 100 \{[^}]*description users;/)
    expect(after.issues.filter((i) => i.kind === 'not-rendered')).toEqual([])
  })
})
