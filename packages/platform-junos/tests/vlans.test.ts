// VLANs, switch ports and IRB beyond the conformance fixtures (tests/fixtures/conformance/vlans): what Junos refuses
// (two VLANs with one ID, two VLANs routed on one IRB unit) is an error and converts neither; what can't be told
// (a vlan-id-list, a non-ELS port-mode, an access port naming a VLAN that isn't converted) converts not at all; an IRB
// unit that routes for no VLAN is left out with a warning; and a model from another platform renders in Junos terms,
// saying what it can't. Messages say where by line, never by a VLAN's or interface's name.
import { describe, expect, it } from 'vitest'
import { buildLedger, ledgerProblems, modelProblems, MODEL_VERSION, type Device, type ParseResult, type RenderResult } from '@dialect/core'
import { checkFixture } from '@dialect/conformance'
import plugin, { parse, render } from '../src'

const context = { modelVersion: MODEL_VERSION }
const set = (...lines: string[]): string => lines.join('\n') + '\n'
const kinds = (p: ParseResult): string[] => Object.values(p.dispositions).map((d) => d.kind)
const reasons = (p: ParseResult): string[] => Object.values(p.dispositions).map((d) => (d.kind === 'mapped' ? 'mapped' : `${d.kind}: ${d.reason ?? ''}`))
const errors = (p: ParseResult) => p.diagnostics.filter((d) => d.severity === 'error')

/** Every message a parse or a render gives: reasons and diagnostics. */
const told = (p: ParseResult | undefined, r?: RenderResult): string[] => [
  ...Object.values(p?.dispositions ?? {}).flatMap((d) => (d.kind === 'mapped' ? [] : [d.reason ?? ''])),
  ...(p?.diagnostics ?? []).map((d) => d.message),
  ...Object.values(r?.dispositions ?? {}).flatMap((d) => (d.kind === 'rendered' ? [] : [d.reason ?? ''])),
  ...(r?.diagnostics ?? []).map((d) => d.message)
]

describe('a VLAN', () => {
  it('is keyed by its ID and keeps its name, its ports naming it by name or ID alike', () => {
    const p = parse(set('set interfaces ge-0/0/0 unit 0 family ethernet-switching vlan members users', 'set interfaces ge-0/0/1 unit 0 family ethernet-switching vlan members 10', 'set vlans users vlan-id 10', 'set vlans users description "user ports"'), context)
    expect(p.model.vlans).toEqual({ '10': { name: 'users', description: 'user ports' } })
    expect(p.model.interfaces!['ge-0/0/0'].switching).toEqual({ accessVlan: 10 })
    expect(p.model.interfaces!['ge-0/0/1'].switching).toEqual({ accessVlan: 10 })
    expect(kinds(p)).toEqual(['mapped', 'mapped', 'mapped', 'mapped'])
  })

  it('takes its ID as any single setting: the configuration over a group', () => {
    const p = parse(set('set groups G vlans users vlan-id 20', 'set apply-groups G', 'set vlans users vlan-id 10'), context)
    expect(p.model.vlans).toEqual({ '10': { name: 'users' } })
    expect(reasons(p)[0]).toBe('ignored-by-design: superseded by line 3')
  })

  it('with the ID of another is an error, and neither converts (Junos refuses it)', () => {
    const p = parse(set('set vlans users vlan-id 10', 'set vlans voice vlan-id 10', 'set interfaces ge-0/0/0 unit 0 family ethernet-switching vlan members users'), context)
    expect(p.model).toEqual({})
    expect(kinds(p)).toEqual(['unsupported', 'unsupported', 'unsupported'])
    expect(errors(p).map((d) => [d.code, d.message])).toEqual([['junos.vlan-id-twice', 'Two VLANs have the same vlan-id: Junos accepts a VLAN ID once (lines 1, 2).']])
  })

  it('with a vlan-id-list converts not at all: the later of vlan-id and vlan-id-list replaces the other', () => {
    const p = parse(set('set vlans servers vlan-id 30', 'set vlans servers vlan-id-list 31-32', 'set interfaces ge-0/0/0 unit 0 family ethernet-switching vlan members servers'), context)
    expect(p.model).toEqual({})
    expect(kinds(p)).toEqual(['unsupported', 'unsupported', 'unsupported'])
  })

  it('without an ID converts not at all, nor do the ports that name it', () => {
    const p = parse(set('set vlans users description "no ID"', 'set interfaces ge-0/0/0 unit 0 family ethernet-switching vlan members users'), context)
    expect(p.model).toEqual({})
    expect(reasons(p)).toEqual(['unsupported: a VLAN with no vlan-id: the model keys VLANs by their ID', "unsupported: names a VLAN the configuration doesn't give a vlan-id"])
  })

  it.each([['0'], ['4095'], ['ten']])('with vlan-id %s is unsupported, the value in no model', (id) => {
    const p = parse(set(`set vlans V vlan-id ${id}`), context)
    expect(p.model).toEqual({})
    expect(kinds(p)).toEqual(['unsupported'])
  })
})

describe('a switch port', () => {
  it("with no interface-mode is an access port, Junos's default, with its one VLAN", () => {
    const p = parse(set('set vlans users vlan-id 10', 'set interfaces ge-0/0/0 unit 0 family ethernet-switching vlan members users'), context)
    expect(p.model.interfaces!['ge-0/0/0']).toEqual({ type: 'ethernet', switching: { accessVlan: 10 } })
  })

  it('that is a trunk carries its VLANs by ID, a range and all as ranges, each once', () => {
    const p = parse(set('set vlans users vlan-id 10', 'set interfaces xe-0/0/0 unit 0 family ethernet-switching interface-mode trunk', 'set interfaces xe-0/0/0 unit 0 family ethernet-switching vlan members [ users 10 20-30 all ]', 'set interfaces xe-0/0/0 native-vlan-id 10'), context)
    expect(p.model.interfaces!['xe-0/0/0'].switching).toEqual({ mode: 'trunk', allowedVlans: ['10', '20-30', '1-4094'], nativeVlan: 10 })
    expect(modelProblems(p.model)).toEqual([])
  })

  it('that is an access port naming more than one VLAN, or a range, is in none of them', () => {
    for (const members of ['[ users voice ]', '20-30', 'all', '[ users missing ]']) {
      const p = parse(set('set vlans users vlan-id 10', 'set vlans voice vlan-id 20', 'set interfaces ge-0/0/0 unit 0 family ethernet-switching interface-mode access', `set interfaces ge-0/0/0 unit 0 family ethernet-switching vlan members ${members}`), context)
      expect(p.model.interfaces!['ge-0/0/0'].switching, members).toEqual({ mode: 'access' })
    }
  })

  it('whose mode non-ELS port-mode sets converts not at all: a trunk never comes out an access port', () => {
    const p = parse(set('set vlans users vlan-id 10', 'set interfaces ge-0/0/0 unit 0 family ethernet-switching port-mode trunk', 'set interfaces ge-0/0/0 unit 0 family ethernet-switching vlan members users', 'set interfaces ge-0/0/0 native-vlan-id 10'), context)
    expect(p.model).toEqual({ vlans: { '10': { name: 'users' } } })
    expect(kinds(p)).toEqual(['mapped', 'unsupported', 'unsupported', 'unsupported'])
  })

  it('on a unit other than 0, or with a native VLAN under its family (non-ELS), is unsupported', () => {
    const p = parse(set('set vlans users vlan-id 10', 'set interfaces ge-0/0/0 unit 1 family ethernet-switching interface-mode trunk', 'set interfaces ge-0/0/1 unit 0 family ethernet-switching native-vlan-id 10'), context)
    expect(p.model).toEqual({ vlans: { '10': { name: 'users' } } })
    expect(kinds(p)).toEqual(['mapped', 'unsupported', 'unsupported'])
  })

  it('that converts not at all leaves its interface out, unless something else configures it', () => {
    const p = parse(set('set interfaces ge-0/0/0 unit 0 family ethernet-switching vlan members missing', 'set interfaces ge-0/0/1 unit 0 family ethernet-switching vlan members missing', 'set routing-instances A interface ge-0/0/1.0'), context)
    expect(p.model.interfaces).toEqual({ 'ge-0/0/1': { type: 'ethernet', subinterfaces: { '0': { networkInstance: 'A' } } } })
    expect(kinds(p)).toEqual(['unsupported', 'unsupported', 'mapped'])
  })

  it("with a native VLAN the configuration doesn't define keeps the rest", () => {
    const p = parse(set('set interfaces xe-0/0/0 unit 0 family ethernet-switching interface-mode trunk', 'set interfaces xe-0/0/0 native-vlan-id 99'), context)
    expect(p.model.interfaces!['xe-0/0/0'].switching).toEqual({ mode: 'trunk' })
    expect(kinds(p)).toEqual(['mapped', 'unsupported'])
  })
})

describe('an IRB unit', () => {
  it('routes for the VLAN whose l3-interface names it', () => {
    const p = parse(set('set interfaces irb unit 10 family inet address 192.0.2.1/24', 'set vlans users vlan-id 10', 'set vlans users l3-interface irb.10'), context)
    expect(p.model.interfaces!.irb).toEqual({ type: 'irb-or-svi', subinterfaces: { '10': { ipv4: { addresses: { '192.0.2.1': { prefixLength: 24 } } }, routedVlan: 10 } } })
  })

  it('that routes for no VLAN is left out with a warning, its routing instance membership too, not given a guessed VLAN', () => {
    const p = parse(set('set interfaces irb unit 10 family inet address 192.0.2.1/24', 'set interfaces irb unit 20 family inet address 198.51.100.1/24', 'set routing-instances A interface irb.20', 'set vlans users vlan-id 10', 'set vlans users l3-interface irb.10'), context)
    expect(Object.keys(p.model.interfaces!.irb.subinterfaces!)).toEqual(['10'])
    expect(kinds(p)).toEqual(['mapped', 'unsupported', 'unsupported', 'mapped', 'mapped'])
    expect(p.diagnostics.map((d) => [d.severity, d.code, d.message])).toEqual([['warning', 'junos.irb-without-vlan', "An IRB unit routes for no VLAN, so it isn't converted (lines 2, 3)."]])
    expect(modelProblems(p.model)).toEqual([])
  })

  it('of an irb none of whose units routes for a VLAN leaves out the irb interface whole', () => {
    const p = parse(set('set interfaces irb mtu 9000', 'set interfaces irb unit 10 family inet address 192.0.2.1/24'), context)
    expect(p.model).toEqual({})
    expect(kinds(p)).toEqual(['unsupported', 'unsupported'])
  })

  it('named by two VLANs is an error, and routes for neither (Junos refuses it)', () => {
    const p = parse(set('set vlans users vlan-id 10', 'set vlans users l3-interface irb.10', 'set vlans voice vlan-id 20', 'set vlans voice l3-interface irb.10'), context)
    expect(p.model).toEqual({ vlans: { '10': { name: 'users' }, '20': { name: 'voice' } } })
    expect(errors(p).map((d) => [d.code, d.message])).toEqual([['junos.irb-unit-twice', 'Two VLANs have the same l3-interface: Junos routes an IRB unit for one VLAN (lines 2, 4).']])
  })

  it('of a non-ELS vlan interface is unsupported', () => {
    const p = parse(set('set interfaces vlan unit 30 family inet address 192.0.2.1/24', 'set vlans users vlan-id 30', 'set vlans users l3-interface vlan.30'), context)
    expect(p.model.interfaces!.vlan).toEqual({ type: 'vlan', subinterfaces: { '30': { ipv4: { addresses: { '192.0.2.1': { prefixLength: 24 } } } } } })
    expect(kinds(p)).toEqual(['mapped', 'mapped', 'unsupported'])
  })
})

describe('render from another platform', () => {
  it("writes VLANs, switch ports and an IRB in Junos terms, saying what it can't", () => {
    const model: Device = {
      interfaces: {
        GigabitEthernet1: { switching: { mode: 'access', accessVlan: 10, allowedVlans: ['20'], nativeVlan: 20 } },
        GigabitEthernet2: { switching: { mode: 'trunk', accessVlan: 10, allowedVlans: ['10', '20', '30-40'], nativeVlan: 20 }, subinterfaces: { '0': { description: 'uplink' } } },
        Vlan10: { type: 'irb-or-svi', subinterfaces: { '0': { routedVlan: 10 } } },
        irb: { type: 'irb-or-svi', subinterfaces: { '20': { routedVlan: 20 }, '21': { routedVlan: 20 } } }
      },
      vlans: { '10': { name: 'USERS' }, '20': {}, '30': { name: 'USERS' }, '5000': { name: 'BAD' } }
    }
    const r = render(model, context)
    expect(r.text).toContain('    GigabitEthernet1 {\n        unit 0 {\n            family ethernet-switching {\n                interface-mode access;\n                vlan {\n                    members USERS;\n                }\n            }\n        }\n    }\n')
    expect(r.text).toContain('    GigabitEthernet2 {\n        native-vlan-id 20;\n        unit 0 {\n            description uplink;\n            family ethernet-switching {\n                interface-mode trunk;\n                vlan {\n                    members [ USERS vlan20 30-40 ];\n                }\n            }\n        }\n    }\n')
    expect(r.text).toContain('vlans {\n    USERS {\n        vlan-id 10;\n    }\n    vlan20 {\n        vlan-id 20;\n        l3-interface irb.20;\n    }\n    vlan30 {\n        vlan-id 30;\n    }\n}\n')
    const why = (path: string) => r.dispositions[path]
    expect(why('interfaces.GigabitEthernet1.switching.allowedVlans')).toMatchObject({ kind: 'unsupported' })
    expect(why('interfaces.GigabitEthernet1.switching.nativeVlan')).toMatchObject({ kind: 'unsupported', reason: 'Junos takes a native VLAN on a trunk only' })
    expect(why('interfaces.GigabitEthernet2.switching.accessVlan')).toMatchObject({ kind: 'unsupported' })
    expect(why('interfaces.Vlan10.subinterfaces["0"].routedVlan')).toMatchObject({ kind: 'unsupported', reason: 'Junos routes for a VLAN on a unit of irb: name the interface irb in the interface map' })
    expect(why('interfaces.irb.subinterfaces["21"].routedVlan')).toMatchObject({ kind: 'unsupported', reason: 'Junos gives a VLAN one l3-interface: another unit routes for it' })
    expect(why('vlans["30"].name')).toMatchObject({ kind: 'unsupported', reason: 'another VLAN has the same name, which Junos keys VLANs by' })
    expect(why('vlans["5000"].name')).toMatchObject({ kind: 'unsupported', reason: 'not keyed by a VLAN ID from 1 to 4094' })
    expect(ledgerProblems(buildLedger(parse('', context), r, model))).toEqual([])
  })
})

describe('VLAN and port names', () => {
  it('that look like Object.prototype keys are ordinary keys through parse, render and reparse', () => {
    const text = set('set vlans __proto__ vlan-id 10', 'set vlans constructor vlan-id 20', 'set vlans constructor l3-interface irb.20', 'set interfaces irb unit 20 family inet address 192.0.2.1/24', 'set interfaces __proto__ unit 0 family ethernet-switching interface-mode trunk', 'set interfaces __proto__ unit 0 family ethernet-switching vlan members [ __proto__ constructor ]')
    const before = Object.getOwnPropertyNames(Object.prototype).sort()
    const p = parse(text, context)
    expect(p.model.vlans).toEqual({ '10': { name: '__proto__' }, '20': { name: 'constructor' } })
    expect(Object.hasOwn(p.model.interfaces!, '__proto__')).toBe(true)
    expect(p.model.interfaces!['__proto__'].switching).toEqual({ mode: 'trunk', allowedVlans: ['10', '20'] })
    expect(checkFixture(plugin, { name: 'safe VLAN keys', source: text, expectedModel: p.model }).filter((c) => c.status === 'failed')).toEqual([])
    expect(Object.getOwnPropertyNames(Object.prototype).sort()).toEqual(before)
  })

  it('that share a secret value stay out of every message', () => {
    const secret = 'PLACEHOLDER-RO'
    const p = parse(set(`set snmp community ${secret} authorization read-only`, `set vlans ${secret} vlan-id 10`, 'set vlans other vlan-id 10', `set vlans ${secret}2 l3-interface irb.5`, `set interfaces ge-0/0/0 unit 0 family ethernet-switching vlan members ${secret}`, `set interfaces irb unit 7 description ${secret}`), context)
    const r = render({ vlans: { '10': { name: secret }, '11': { name: secret } }, interfaces: { [secret]: { type: 'irb-or-svi', subinterfaces: { '0': { routedVlan: 10 } } } } }, context)
    expect(told(p, r).length).toBeGreaterThan(4)
    for (const text of told(p, r)) expect(text).not.toContain(secret)
  })
})
