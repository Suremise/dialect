// The phase 2 areas (model 0.4.0) beyond their fixtures: VLANs and switch ports, SVIs, OSPF and BGP. Later statements
// acting on earlier ones (`no …` forms, `vrf member`, `no feature`, a VRF's deletion), what is left out and why, the
// secrets the model only flags (asked for on render, written when answered), the semantic warnings, rendering models
// from other platforms, and the aggregate names suggested for convert.
import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { checkFixture, checkSecrets } from '@dialect/conformance'
import { buildLedger, deserializeModel, fieldPath, ledgerProblems, MODEL_VERSION, statementsOf, type Context, type Device, type ParseResult } from '@dialect/core'
import plugin from '../src'
import type { NxNode } from '../src/tree'

const context = { modelVersion: MODEL_VERSION }
const parse = (text: string) => plugin.parse!(text, context)
const render = (model: Device, inputs?: Context['inputs']) => plugin.render!(model, { ...context, ...(inputs ? { inputs } : {}) })
const lines = (...l: string[]) => l.join('\n')
/** Each statement's disposition, by its line number. */
const at = (result: ParseResult, n: number) => result.dispositions[`L${n}`]
/** The kit's checks on `text` against its own parse: no error, a complete ledger, a stable round trip. */
const roundTrips = (text: string) => checkFixture(plugin, { name: text, source: text, expectedModel: parse(text).model }).flatMap((r) => (r.status === 'failed' ? r.problems : []))
/** A render's ledger problems for `model`: every populated field accounted for. */
const accounted = (model: Device, inputs?: Context['inputs']) => ledgerProblems(buildLedger({ tree: [], model, dispositions: {}, diagnostics: [] }, render(model, inputs)))
const codes = (result: { diagnostics: readonly { code?: string }[] }) => result.diagnostics.map((d) => d.code)

describe('VLANs', () => {
  it('a VLAN list defines each VLAN of it; a name goes on one VLAN only', () => {
    const result = parse(lines('vlan 4,6-8', '  name several', 'vlan 10', '  name SERVERS', '  name APPS'))
    expect(result.model.vlans).toEqual({ '4': {}, '6': {}, '7': {}, '8': {}, '10': { name: 'APPS' } })
    expect(at(result, 2)).toEqual({ kind: 'unsupported', reason: 'one name for several VLANs' })
    expect(at(result, 4)).toEqual({ kind: 'ignored-by-design', reason: 'superseded by line 5' })
  })

  it('"no vlan" removes those VLANs; a statement about others too keeps them', () => {
    const text = lines('vlan 4-6', 'vlan 10', '  name SERVERS', 'no vlan 5,10')
    const result = parse(text)
    expect(result.model.vlans).toEqual({ '4': {}, '6': {} })
    expect(at(result, 1)).toEqual({ kind: 'mapped', fields: ['vlans["4"]', 'vlans["6"]'] })
    expect([at(result, 2), at(result, 3)]).toEqual([{ kind: 'ignored-by-design', reason: 'removed by line 4' }, { kind: 'ignored-by-design', reason: 'removed by line 4' }])
    expect(at(result, 4)).toMatchObject({ kind: 'ignored-by-design' })
    expect(roundTrips(text)).toEqual([])
    expect(at(parse('no vlan 1'), 1)).toEqual({ kind: 'unsupported', reason: 'VLAN 1 is built in: NX-OS can\'t remove it' })
  })

  it('VLAN 1 is built in: a port or an SVI that uses it brings it into the model', () => {
    for (const text of [lines('interface Ethernet1/1', '  switchport access vlan 1'), lines('feature interface-vlan', 'interface Vlan1', '  ip address 192.0.2.1/24')]) {
      const result = parse(text)
      expect(result.model.vlans, text).toEqual({ '1': {} })
      expect(roundTrips(text), text).toEqual([])
    }
  })

  it('a port\'s VLAN the text doesn\'t define is left out with its statement; a range carries whichever exist', () => {
    const result = parse(lines('vlan 10', 'interface Ethernet1/1', '  switchport mode trunk', '  switchport trunk native vlan 20', '  switchport trunk allowed vlan 10,30', 'interface Ethernet1/2', '  switchport mode trunk', '  switchport trunk allowed vlan 10,20-30'))
    expect(result.model.interfaces?.['Ethernet1/1'].switching).toEqual({ mode: 'trunk' })
    expect(at(result, 4)).toEqual({ kind: 'unsupported', reason: 'names a VLAN the configuration doesn\'t define' })
    expect(at(result, 5)).toEqual({ kind: 'unsupported', reason: 'the allowed VLANs name one the configuration doesn\'t define' })
    expect(result.model.interfaces?.['Ethernet1/2'].switching).toEqual({ mode: 'trunk', allowedVlans: ['10', '20-30'] })
  })

  it('a VLAN name NX-OS can\'t take, or a description, is unsupported on render', () => {
    const result = render({ vlans: { '10': { name: 'two words', description: 'servers' }, '20': {} } })
    expect(result.text).toBe('vlan 10\n\nvlan 20\n')
    expect(result.dispositions['vlans["10"].name']).toMatchObject({ kind: 'unsupported' })
    expect(result.dispositions['vlans["10"].description']).toMatchObject({ kind: 'unsupported' })
  })
})

describe('switch ports', () => {
  const allowed = (...statements: string[]) => parse(lines('vlan 1-4094', 'interface Ethernet1/1', '  switchport mode trunk', ...statements.map((s) => `  switchport trunk allowed vlan ${s}`))).model.interfaces?.['Ethernet1/1'].switching?.allowedVlans

  it('allowed VLANs: a list, all, none, and add, remove and except as NX-OS applies them', () => {
    expect(allowed('10,5,20-30')).toEqual(['10', '5', '20-30'])
    expect(allowed('all')).toEqual(['1-4094'])
    expect(allowed('none')).toEqual([])
    expect(allowed('none', 'add 10,12-13')).toEqual(['10', '12-13'])
    expect(allowed('1-20', 'remove 10', 'add 30')).toEqual(['1-9', '11-20', '30'])
    // With no list before it, `remove` takes from every VLAN, NX-OS's default.
    expect(allowed('remove 1')).toEqual(['2-4094'])
    expect(allowed('10', 'except 1-4093')).toEqual(['4094'])
    // A malformed list is refused by the device: the list before it stays.
    expect(allowed('10', '4095')).toEqual(['10'])
  })

  it('a list supersedes the statements before it; add and remove edit them and stay mapped', () => {
    const result = parse(lines('vlan 1-30', 'interface Ethernet1/1', '  switchport trunk allowed vlan 1-3', '  switchport trunk allowed vlan add 4', '  switchport trunk allowed vlan 10', '  switchport trunk allowed vlan add 20', '  switchport trunk allowed vlan remove 10'))
    expect([3, 4].map((n) => at(result, n))).toEqual([{ kind: 'ignored-by-design', reason: 'superseded by line 5' }, { kind: 'ignored-by-design', reason: 'superseded by line 5' }])
    expect([5, 6, 7].map((n) => at(result, n)?.kind)).toEqual(['mapped', 'mapped', 'mapped'])
    expect(result.model.interfaces?.['Ethernet1/1'].switching?.allowedVlans).toEqual(['20'])
  })

  it('"no" forms go back to NX-OS\'s defaults, which the model leaves out', () => {
    const text = lines('vlan 10,20', 'interface Ethernet1/1', '  switchport mode trunk', '  switchport access vlan 10', '  switchport trunk native vlan 20', '  switchport trunk allowed vlan 10', '  no switchport mode', '  no switchport access vlan', '  no switchport trunk native vlan', '  no switchport trunk allowed vlan')
    const result = parse(text)
    expect(result.model.interfaces?.['Ethernet1/1']).toEqual({ type: 'ethernet' })
    for (const n of [3, 4, 5, 6]) expect(at(result, n), `line ${n}`).toEqual({ kind: 'ignored-by-design', reason: `removed by line ${n + 4}` })
    expect(roundTrips(text)).toEqual([])
  })

  it('"no switchport" clears the port\'s switch port settings, as NX-OS does', () => {
    const result = parse(lines('vlan 10', 'interface Ethernet1/1', '  switchport access vlan 10', '  no switchport', '  ip address 192.0.2.1/24'))
    expect(result.model.interfaces?.['Ethernet1/1'].switching).toBeUndefined()
    expect(at(result, 3)).toEqual({ kind: 'ignored-by-design', reason: 'cleared by line 4, which makes the port routed' })
  })

  it('what NX-OS refuses is unsupported: another mode, a setting on a loopback or a routed port', () => {
    const result = parse(lines('vlan 10', 'interface Ethernet1/1', '  switchport mode dot1q-tunnel', 'interface loopback0', '  switchport access vlan 10', 'interface Ethernet1/2', '  switchport access vlan 10', '  ip address 192.0.2.1/24'))
    expect(at(result, 3)).toEqual({ kind: 'unsupported', reason: 'a switch port mode other than access or trunk' })
    expect(at(result, 5)).toEqual({ kind: 'unsupported', reason: 'a switch port setting on an interface that can\'t be a switch port' })
    expect(at(result, 7)).toEqual({ kind: 'unsupported', reason: 'a switch port setting on a routed port, which NX-OS refuses' })
    expect(result.model.interfaces?.['Ethernet1/2'].switching).toBeUndefined()
  })

  it('a render leaves out switch port settings on a routed port or an interface NX-OS can\'t switch', () => {
    const model: Device = {
      vlans: { '10': {} },
      interfaces: { 'Ethernet1/1': { switching: { accessVlan: 10 }, subinterfaces: { '0': { ipv4: { addresses: { '192.0.2.1': { prefixLength: 24 } } } } } }, loopback0: { switching: { mode: 'access' } } }
    }
    const result = render(model)
    expect(result.text).not.toContain('switchport access')
    expect(result.dispositions['interfaces["Ethernet1/1"].switching.accessVlan']).toEqual({ kind: 'unsupported', reason: 'a routed port (it has IP configuration) isn\'t a switch port on NX-OS' })
    expect(result.dispositions['interfaces.loopback0.switching.mode']).toEqual({ kind: 'unsupported', reason: 'only an Ethernet or port-channel interface is a switch port on NX-OS' })
    expect(accounted(model)).toEqual([])
  })
})

describe('SVIs', () => {
  it('interface VlanN routes for VLAN N when the VLAN is defined; without it, it is an interface of type vlan', () => {
    expect(parse(lines('vlan 10', 'interface Vlan10', '  ip address 192.0.2.1/24')).model.interfaces?.Vlan10).toEqual({ type: 'irb-or-svi', subinterfaces: { '0': { routedVlan: 10, ipv4: { addresses: { '192.0.2.1': { prefixLength: 24 } } } } } })
    for (const text of [lines('interface Vlan10', '  ip address 192.0.2.1/24'), lines('vlan 10', 'interface Vlan10', '  ip address 192.0.2.1/24', 'no vlan 10')]) {
      const result = parse(text)
      expect(result.model.interfaces?.Vlan10, text).toEqual({ type: 'vlan', subinterfaces: { '0': { ipv4: { addresses: { '192.0.2.1': { prefixLength: 24 } } } } } })
      expect(at(result, text.startsWith('vlan') ? 2 : 1)).toEqual({ kind: 'mapped', fields: ['interfaces.Vlan10.type'] })
      expect(roundTrips(text)).toEqual([])
    }
  })

  it('a render writes an SVI only as Vlan and its VLAN ID, with interface-vlan, and says why otherwise', () => {
    const svi = { routedVlan: 100, ipv4: { addresses: { '192.0.2.1': { prefixLength: 24 } } } }
    // Junos's irb, with unit 100 routing for VLAN 100: the interface map names it Vlan100, or it isn't written.
    const named = render({ vlans: { '100': {} }, interfaces: { Vlan100: { type: 'irb-or-svi', subinterfaces: { '100': svi } } } })
    expect(named.text).toBe('feature interface-vlan\n\nvlan 100\n\ninterface Vlan100\n  ip address 192.0.2.1/24\n')
    expect(named.dispositions['interfaces.Vlan100.subinterfaces["100"].routedVlan']).toMatchObject({ kind: 'rendered' })
    const irb: Device = { vlans: { '100': {}, '200': {} }, interfaces: { irb: { type: 'irb-or-svi', subinterfaces: { '100': svi, '200': { routedVlan: 200 } } } } }
    const unnamed = render(irb)
    expect(unnamed.text).not.toContain('interface')
    expect(codes(unnamed)).toEqual(['nxos.svi-name'])
    expect(accounted(irb)).toEqual([])
    // A second routing subinterface on a Vlan interface has nowhere to go.
    const extra: Device = { vlans: { '100': {}, '200': {} }, interfaces: { Vlan100: { type: 'irb-or-svi', subinterfaces: { '0': svi, '200': { routedVlan: 200 } } } } }
    expect(render(extra).dispositions['interfaces.Vlan100.subinterfaces["200"].routedVlan']).toEqual({ kind: 'unsupported', reason: 'NX-OS\'s Vlan interface has no subinterfaces: it routes for the VLAN its name gives' })
    expect(accounted(extra)).toEqual([])
  })
})

describe('OSPF', () => {
  const ospf = (result: ParseResult, instance = 'default') => result.model.networkInstances?.[instance]?.ospf

  it('an interface\'s OSPF goes in the network instance it is in, under its process', () => {
    const text = lines('vrf context A', 'interface Ethernet1/1', '  no switchport', '  vrf member A', '  ip address 192.0.2.1/24', '  ip router ospf 7 area 0.0.0.3', '  ip ospf cost 5', 'router ospf 7', '  vrf A', '    router-id 192.0.2.1')
    const result = parse(text)
    expect(ospf(result, 'A')).toEqual({ processId: '7', routerId: '192.0.2.1', areas: { '0.0.0.3': { interfaces: { 'Ethernet1/1': { enabledBy: 'interface', cost: 5 } } } } })
    expect(ospf(result)).toEqual({ processId: '7' })
    expect(roundTrips(text)).toEqual([])
  })

  it('"vrf member" deletes the interface\'s OSPF settings with its addresses, as NX-OS does', () => {
    const result = parse(lines('vrf context A', 'interface Ethernet1/1', '  ip router ospf 1 area 0', '  ip ospf cost 5', '  vrf member A', '  ip address 192.0.2.1/24'))
    expect(result.model.networkInstances?.default).toBeUndefined()
    for (const n of [3, 4]) expect(at(result, n)).toEqual({ kind: 'ignored-by-design', reason: 'removed by line 5, which moves the interface to another VRF' })
  })

  it('a VRF\'s deletion leaves its OSPF out, as uncertain as its interfaces (#47)', () => {
    const result = parse(lines('vrf context A', 'interface loopback1', '  vrf member A', '  ip router ospf 1 area 0', 'router ospf 1', '  vrf A', '    router-id 192.0.2.1', 'no vrf context A', 'vrf context A'))
    for (const n of [4, 6, 7]) expect(at(result, n), `line ${n}`).toEqual({ kind: 'unsupported', reason: 'in a VRF line 8 deletes: what the device keeps of it isn\'t certain' })
    expect(result.model.networkInstances?.A).toEqual({ type: 'vrf' })
  })

  it('the model has one process per network instance: the one its interfaces enable, else the first with settings', () => {
    const result = parse(lines('router ospf A', '  router-id 192.0.2.1', 'router ospf B', '  router-id 192.0.2.2', 'router ospf C', 'interface loopback0', '  ip router ospf B area 0'))
    expect(ospf(result)).toEqual({ processId: 'B', routerId: '192.0.2.2', areas: { '0.0.0.0': { interfaces: { loopback0: { enabledBy: 'interface' } } } } })
    expect([at(result, 1), at(result, 2)]).toEqual(Array.from({ length: 2 }, () => ({ kind: 'unsupported', reason: 'a second OSPF process in the same table: the model has one per network instance' })))
    expect(at(result, 5)).toEqual({ kind: 'ignored-by-design', reason: 'a second OSPF process, with nothing of its own in this table: nothing to convert' })
  })

  it('passive-interface default makes every interface of the process passive but those that say otherwise', () => {
    const result = parse(readFileSync(new URL('./fixtures/ospf/passive-default.cfg', import.meta.url), 'utf8'))
    const byText = new Map(statementsOf(result.tree).map((n) => [(n as NxNode).text, result.dispositions[n.id]]))
    expect(byText.get('passive-interface default')).toEqual({ kind: 'mapped', fields: ['networkInstances.default.ospf.areas["0.0.0.0"].interfaces["Ethernet1/1"].passive'] })
    expect(byText.get('no ip ospf passive-interface')).toEqual({ kind: 'ignored-by-design', reason: 'not passive, overriding passive-interface default: written back as the interface\'s own setting is' })
    expect(byText.get('network 192.0.2.0/24 area 0')).toMatchObject({ kind: 'unsupported' })
  })

  it('"no" forms: an interface\'s enablement and settings, a process, the feature', () => {
    const base = ['interface loopback0', '  ip router ospf 1 area 0', '  ip ospf cost 5', 'router ospf 1', '  router-id 192.0.2.1', '  area 0.0.0.1 stub']
    const settings = parse(lines(...base, 'interface loopback0', '  no ip ospf cost', 'router ospf 1', '  no area 0.0.0.1 stub', '  no router-id'))
    expect(ospf(settings)).toEqual({ processId: '1', areas: { '0.0.0.0': { interfaces: { loopback0: { enabledBy: 'interface' } } } } })
    const enable = parse(lines(...base, 'interface loopback0', '  no ip router ospf 1 area 0'))
    expect(at(enable, 3)).toEqual({ kind: 'unsupported', reason: 'an OSPF setting on an interface with no ip router ospf that converts' })
    const process = parse(lines(...base, 'no router ospf 1'))
    expect(ospf(process)).toBeUndefined()
    expect(at(process, 2)).toEqual({ kind: 'unsupported', reason: 'enables an OSPF process line 7 removes: what the device keeps of it isn\'t certain' })
    expect([4, 5, 6].map((n) => at(process, n))).toEqual(Array.from({ length: 3 }, () => ({ kind: 'ignored-by-design', reason: 'removed by line 7' })))
    const feature = parse(lines('feature ospf', ...base, 'no feature ospf'))
    expect(ospf(feature)).toBeUndefined()
    for (const n of [3, 4, 5, 6, 7]) expect(at(feature, n), `line ${n}`).toEqual({ kind: 'unsupported', reason: 'OSPF\'s, which line 8 turns off: left out' })
  })

  it('a key is never carried: flagged on parse, asked for on render, written when answered', () => {
    const text = lines('interface Ethernet1/1', '  no switchport', '  ip address 192.0.2.1/30', '  ip ospf authentication message-digest', '  ip ospf message-digest-key 1 md5 3 CANARY_KEY', '  ip router ospf 1 area 0')
    const result = parse(text)
    expect(at(result, 5)).toEqual({ kind: 'ignored-by-design', reason: 'an OSPF key: never carried, the target asks for it' })
    expect(JSON.stringify(result.model)).not.toContain('CANARY_KEY')
    expect(checkSecrets(plugin, text, ['CANARY_KEY'], { allowances: [] }).leaks).toEqual([])
    const entry = ['networkInstances', 'default', 'ospf', 'areas', '0.0.0.0', 'interfaces', 'Ethernet1/1']
    const asked = render(result.model)
    expect(asked.needsInput).toEqual([{ id: `nxos.ospf-key:${fieldPath(...entry)}`, kind: 'secret', message: expect.stringContaining('key ID'), field: `${fieldPath(...entry)}.authentication` }])
    expect(asked.text).toContain('  ip ospf authentication message-digest\n')
    const answered = render(result.model, { [`nxos.ospf-key:${fieldPath(...entry)}`]: '7 NEW-KEY' })
    expect(answered.needsInput).toBeUndefined()
    expect(answered.text).toContain('  ip ospf authentication message-digest\n  ip ospf message-digest-key 7 md5 0 NEW-KEY\n')
    // An answer NX-OS can't take isn't used, and isn't repeated.
    const wrong = render(result.model, { [`nxos.ospf-key:${fieldPath(...entry)}`]: 'NOT-AN-ID' })
    expect(wrong.needsInput).toHaveLength(1)
    expect(wrong.diagnostics.find((d) => d.code === 'nxos.answer-not-taken')?.message).not.toContain('NOT-AN-ID')
  })

  it('an area\'s authentication asks for each of its interfaces\' keys; a key chain is asked for by name', () => {
    const model: Device = {
      interfaces: { loopback0: {}, loopback1: {} },
      networkInstances: { default: { ospf: { processId: '1', areas: { '0.0.0.0': { authentication: 'simple', interfaces: { loopback0: {}, loopback1: { authentication: 'key-chain' } } } } } } }
    }
    const asked = render(model)
    expect(asked.text).toContain('router ospf 1\n  area 0.0.0.0 authentication\n')
    expect(asked.needsInput?.map((n) => n.kind)).toEqual(['secret', 'secret'])
    expect(accounted(model)).toEqual([])
    const ids = asked.needsInput!.map((n) => n.id)
    const answered = render(model, { [ids[0]]: 'KEY1', [ids[1]]: 'CHAIN' })
    expect(answered.text).toContain('interface loopback0\n  ip router ospf 1 area 0.0.0.0\n  ip ospf authentication-key 0 KEY1\n')
    expect(answered.text).toContain('interface loopback1\n  ip router ospf 1 area 0.0.0.0\n  ip ospf authentication key-chain CHAIN\n')
  })

  it('a render from another platform: network enablement warns, a process with no tag is 1, OSPF in another VRF than its interface is left out', () => {
    const model: Device = {
      networkInstances: { default: { ospf: { areas: { '0.0.0.0': { interfaces: { 'GigabitEthernet0/0/1': { enabledBy: 'network', passive: false } } } } } }, A: { type: 'vrf', ospf: { processId: '2', areas: { '0.0.0.0': { interfaces: { loopback1: {} } } } } } },
      interfaces: { 'GigabitEthernet0/0/1': {}, loopback1: {} }
    }
    const result = render(model)
    expect(result.text).toContain('interface GigabitEthernet0/0/1\n  ip router ospf 1 area 0.0.0.0\n')
    expect(codes(result)).toEqual(['nxos.ospf-process-tag', 'nxos.ospf-enabled-per-interface'])
    expect(result.dispositions['networkInstances.A.ospf.areas["0.0.0.0"].interfaces.loopback1']).toEqual({ kind: 'unsupported', reason: 'OSPF in another network instance than its interface\'s' })
    expect(accounted(model)).toEqual([])
  })
})

describe('BGP', () => {
  const bgp = (result: ParseResult, instance = 'default') => result.model.networkInstances?.[instance]?.bgp

  it('a neighbor on one line or in a block, a template it inherits, an asdot AS', () => {
    const text = lines('router bgp 1.10', '  template peer T', '    remote-as 65001', '  neighbor 192.0.2.2', '    inherit peer T', '  neighbor 2001:DB8::2 remote-as 4200000000')
    const result = parse(text)
    expect(bgp(result)).toEqual({ localAs: 65546, groups: { T: { peerAs: 65001 } }, neighbors: { '192.0.2.2': { group: 'T' }, '2001:db8::2': { peerAs: 4200000000 } }, ebgpDefaultPolicy: { import: 'accept', export: 'accept' } })
    expect(roundTrips(text)).toEqual([])
  })

  it('a route map is taken by name only, with a warning that doesn\'t name it', () => {
    const result = parse(lines('router bgp 65000', '  neighbor 192.0.2.2', '    remote-as 65001', '    address-family ipv4 unicast', '      route-map CANARY in'))
    expect(bgp(result)?.neighbors?.['192.0.2.2'].addressFamilies).toEqual({ 'ipv4-unicast': { importPolicies: ['CANARY'] } })
    expect(result.diagnostics).toEqual([expect.objectContaining({ severity: 'warning', category: 'semantic', code: 'nxos.route-map-name-only', statement: 'L5' })])
    expect(result.diagnostics[0].message).not.toContain('CANARY')
  })

  it('"no" forms: a neighbor, a template, a setting, a family, BGP itself, the feature', () => {
    const base = ['feature bgp', 'router bgp 65000', '  template peer T', '    remote-as 65001', '  neighbor 192.0.2.2', '    inherit peer T', '    description d', '    address-family ipv4 unicast', '      route-map M out']
    const settings = parse(lines(...base, 'router bgp 65000', '  neighbor 192.0.2.2', '    no description', '    no address-family ipv4 unicast'))
    expect(bgp(settings)?.neighbors).toEqual({ '192.0.2.2': { group: 'T' } })
    expect([7, 8, 9].map((n) => at(settings, n))).toEqual([{ kind: 'ignored-by-design', reason: 'removed by line 12' }, { kind: 'ignored-by-design', reason: 'removed by line 13' }, { kind: 'ignored-by-design', reason: 'removed by line 13' }])
    const neighbor = parse(lines(...base, 'router bgp 65000', '  no neighbor 192.0.2.2', '  no template peer T'))
    expect(bgp(neighbor)).toEqual({ localAs: 65000 })
    const all = parse(lines(...base, 'no router bgp 65000'))
    expect(all.model.networkInstances).toBeUndefined()
    expect(at(all, 2)).toEqual({ kind: 'ignored-by-design', reason: 'removed by line 10' })
    const feature = parse(lines(...base, 'no feature bgp'))
    expect(feature.model.networkInstances).toBeUndefined()
    expect(at(feature, 4)).toEqual({ kind: 'unsupported', reason: 'BGP\'s, which line 10 turns off: left out' })
  })

  it('what doesn\'t resolve is left out: a VRF, an update source, a template; a second AS', () => {
    const result = parse(lines('router bgp 65000', '  neighbor 192.0.2.2', '    update-source loopback9', '    inherit peer NONE', '  vrf B', '    neighbor 192.0.2.3 remote-as 65001', 'router bgp 65001', '  router-id 192.0.2.1'))
    expect(bgp(result)).toEqual({ localAs: 65000, neighbors: { '192.0.2.2': {} } })
    expect(at(result, 3)).toEqual({ kind: 'unsupported', reason: 'names an interface the configuration doesn\'t define' })
    expect(at(result, 4)).toEqual({ kind: 'unsupported', reason: 'names a peer template the configuration doesn\'t define' })
    expect([at(result, 5), at(result, 6)]).toEqual(Array.from({ length: 2 }, () => ({ kind: 'unsupported', reason: 'BGP in a VRF the configuration doesn\'t define' })))
    expect(at(result, 7)).toEqual({ kind: 'unsupported', reason: 'a second BGP AS beside line 1\'s: NX-OS runs one BGP process' })
    expect(result.model.networkInstances?.B).toBeUndefined()
  })

  it('a VRF\'s deletion leaves its BGP out, as uncertain as its interfaces (#47)', () => {
    const result = parse(lines('vrf context A', 'router bgp 65000', '  vrf A', '    neighbor 192.0.2.2 remote-as 65001', 'no vrf context A', 'vrf context A'))
    expect([at(result, 3), at(result, 4)]).toEqual(Array.from({ length: 2 }, () => ({ kind: 'unsupported', reason: 'in a VRF line 5 deletes: what the device keeps of it isn\'t certain' })))
    expect(result.model.networkInstances).toEqual({ default: { bgp: { localAs: 65000 } }, A: { type: 'vrf' } })
  })

  it('a password is never carried: flagged on parse, asked for on render, written when answered', () => {
    const text = lines('router bgp 65000', '  neighbor 192.0.2.2', '    remote-as 65001', '    password 3 CANARY_PASSWORD', '    address-family ipv4 unicast', '      route-map M in')
    const result = parse(text)
    expect(bgp(result)?.neighbors?.['192.0.2.2'].authentication).toBe(true)
    expect(JSON.stringify(result.model)).not.toContain('CANARY_PASSWORD')
    expect(checkSecrets(plugin, text, ['CANARY_PASSWORD'], { allowances: [] }).leaks).toEqual([])
    const id = `nxos.bgp-password:${fieldPath('networkInstances', 'default', 'bgp', 'neighbors', '192.0.2.2')}`
    const asked = render(result.model)
    expect(asked.needsInput).toEqual([{ id, kind: 'secret', message: 'A BGP session with a password needs the password, which isn\'t carried.', field: 'networkInstances.default.bgp.neighbors["192.0.2.2"].authentication' }])
    expect(asked.text).not.toContain('password')
    const answered = render(result.model, { [id]: 'NEW-PASSWORD' })
    expect(answered.text).toContain('    password 0 NEW-PASSWORD\n')
    // With the answer, it round-trips.
    expect(parse(answered.text).model).toEqual(result.model)
  })

  it('semantic warnings: an eBGP neighbor the source would drop without a policy (RFC 8212), a neighbor with no family, policies by name', () => {
    const parsed = parse(readFileSync(new URL('./fixtures/bgp/neighbors.cfg', import.meta.url), 'utf8'))
    // NX-OS accepts an eBGP peer's routes with no route map: said for the ways a neighbor has none (2001:db8::1 has none).
    expect(parsed.model.networkInstances?.default.bgp?.ebgpDefaultPolicy).toEqual({ import: 'accept', export: 'accept' })
    const result = render(parsed.model)
    // From an NX-OS source, nothing differs: only the route maps written by name.
    expect(result.diagnostics.map((d) => [d.code, d.field])).toEqual([['nxos.route-map-name-only', 'networkInstances.default.bgp.neighbors["198.51.100.1"]']])
    expect(result.dispositions['networkInstances.default.bgp.ebgpDefaultPolicy.import']).toMatchObject({ kind: 'not-applicable' })
    // From IOS-XR, which drops them (reject), an eBGP neighbor with no route map that way warns; its message names no peer.
    const xr: Device = { networkInstances: { default: { bgp: { localAs: 65000, ebgpDefaultPolicy: { import: 'reject' }, neighbors: { '198.51.100.9': { peerAs: 64512, addressFamilies: { 'ipv4-unicast': { exportPolicies: ['OUT'] } } } } } } } }
    const warned = render(xr).diagnostics.find((d) => d.code === 'nxos.ebgp-default-policy')
    expect(warned).toMatchObject({ severity: 'warning', category: 'semantic', field: 'networkInstances.default.bgp.neighbors["198.51.100.9"]' })
    expect(warned?.message).not.toContain('198.51.100.9')
    // Only the ways the source rejects: an export policy missing where only import is rejected says nothing.
    expect(codes(render({ networkInstances: { default: { bgp: { localAs: 65000, ebgpDefaultPolicy: { import: 'reject' }, neighbors: { '198.51.100.9': { peerAs: 64512, addressFamilies: { 'ipv4-unicast': { importPolicies: ['IN'] } } } } } } } }))).toEqual(['nxos.route-map-name-only'])
    const none = render({ networkInstances: { default: { bgp: { localAs: 65000, neighbors: { '192.0.2.2': { peerAs: 65000 } } } } } })
    expect(codes(none)).toEqual(['nxos.bgp-no-address-family'])
  })

  it('a render from Junos: an internal group, policies for the whole peer, what NX-OS can\'t say', () => {
    const model: Device = {
      interfaces: { lo0: { subinterfaces: { '0': {} } } },
      networkInstances: {
        default: {
          bgp: {
            localAs: 65000,
            groups: { IBGP: { type: 'internal', localAddress: '192.0.2.1', importPolicies: ['IN'], exportPolicies: ['OUT1', 'OUT2'], addressFamilies: { 'ipv4-unicast': {} } } },
            neighbors: { '192.0.2.2': { group: 'IBGP', multihop: {} }, '198.51.100.1': { peerAs: 64512, exportPolicies: ['EXPORT'] } }
          }
        },
        A: { type: 'vrf', bgp: { localAs: 65001, groups: { G: { peerAs: 64600 } } } }
      }
    }
    const result = render(model)
    expect(result.text).toContain(['router bgp 65000', '  address-family ipv4 unicast', '  template peer IBGP', '    remote-as 65000', '    address-family ipv4 unicast', '      route-map IN in', '  neighbor 192.0.2.2', '    inherit peer IBGP', '  neighbor 198.51.100.1', '    remote-as 64512', '  vrf A', ''].join('\n'))
    const unsupported = Object.entries(result.dispositions).filter(([, d]) => d.kind === 'unsupported').map(([path]) => path).sort()
    expect(unsupported).toEqual([
      'networkInstances.A.bgp.groups.G.peerAs',
      'networkInstances.A.bgp.localAs',
      'networkInstances.default.bgp.groups.IBGP.exportPolicies',
      'networkInstances.default.bgp.groups.IBGP.localAddress',
      'networkInstances.default.bgp.neighbors["192.0.2.2"].multihop',
      'networkInstances.default.bgp.neighbors["198.51.100.1"].exportPolicies'
    ])
    expect(accounted(model)).toEqual([])
  })
})

describe('routed ports', () => {
  it('OSPF on a port makes it routed, as an address does: no switchport maps and is written back', () => {
    for (const port of ['Ethernet1/1', 'port-channel1']) {
      const text = lines('feature ospf', `interface ${port}`, '  no switchport', '  ip router ospf 1 area 0', 'router ospf 1')
      const result = parse(text)
      expect(at(result, 3), port).toEqual({ kind: 'ignored-by-design', reason: 'a routed port, as its IP configuration says: written back with it' })
      expect(render(result.model).text).toContain(`interface ${port}\n  no switchport\n  ip router ospf 1 area 0.0.0.0\n`)
      expect(roundTrips(text), port).toEqual([])
    }
  })

  it('a switch port with OSPF on it is reported, on parse and render', () => {
    const result = parse(lines('vlan 10', 'interface Ethernet1/1', '  switchport', '  switchport access vlan 10', '  ip router ospf 1 area 0'))
    expect(at(result, 3)).toEqual({ kind: 'unsupported', reason: 'a switch port with IP configuration, which NX-OS refuses' })
    expect(at(result, 4)).toEqual({ kind: 'unsupported', reason: 'a switch port setting on a routed port, which NX-OS refuses' })
    const model: Device = { vlans: { '10': {} }, interfaces: { 'Ethernet1/1': { switching: { accessVlan: 10 } } }, networkInstances: { default: { ospf: { processId: '1', areas: { '0.0.0.0': { interfaces: { 'Ethernet1/1': {} } } } } } } }
    const rendered = render(model)
    expect(rendered.text).toContain('interface Ethernet1/1\n  no switchport\n  ip router ospf 1 area 0.0.0.0\n')
    expect(rendered.dispositions['interfaces["Ethernet1/1"].switching.accessVlan']).toEqual({ kind: 'unsupported', reason: 'a routed port (it has IP configuration) isn\'t a switch port on NX-OS' })
  })
})

describe('the semantic warnings, each raised by a saved fixture', () => {
  const models = new URL('./models/', import.meta.url)
  const cases = readdirSync(models).filter((f) => f.endsWith('.model.json')).map((f) => f.replace(/\.model\.json$/, ''))

  for (const name of cases) {
    it(`models/${name}: another platform's model renders as expected, every field accounted for`, () => {
      const model = deserializeModel(readFileSync(new URL(`${name}.model.json`, models), 'utf8')).device
      const result = render(model)
      expect(result.text).toBe(readFileSync(new URL(`${name}.rendered.cfg`, models), 'utf8'))
      expect(codes(result)).toEqual(JSON.parse(readFileSync(new URL(`${name}.warnings.json`, models), 'utf8')))
      expect(accounted(model)).toEqual([])
    })
  }

  it('every phase 2 warning comes from a saved source fixture or model', () => {
    const fixtures = new URL('./fixtures/', import.meta.url)
    const sources = ['vlans', 'ospf', 'bgp'].flatMap((area) => readdirSync(new URL(`${area}/`, fixtures)).filter((f) => f.endsWith('.cfg') && !f.endsWith('.rendered.cfg')).map((f) => new URL(`${area}/${f}`, fixtures)))
    const raised = new Set([
      ...sources.flatMap((file) => {
        const parsed = parse(readFileSync(file, 'utf8'))
        return [...codes(parsed), ...codes(render(parsed.model))]
      }),
      ...cases.flatMap((name) => codes(render(deserializeModel(readFileSync(new URL(`${name}.model.json`, models), 'utf8')).device)))
    ])
    for (const code of ['nxos.route-map-name-only', 'nxos.ebgp-default-policy', 'nxos.bgp-no-address-family', 'nxos.ospf-enabled-per-interface', 'nxos.svi-name']) expect(raised, code).toContain(code)
  })
})

describe('the feature lines phase 2 needs', () => {
  it('a render writes feature ospf and feature bgp before what needs them', () => {
    const text = render({ interfaces: { loopback0: {} }, networkInstances: { default: { ospf: { processId: '1', areas: { '0.0.0.0': { interfaces: { loopback0: {} } } } }, bgp: { localAs: 65000 } } } }).text
    expect(text.split('\n').filter((l) => l.startsWith('feature '))).toEqual(['feature bgp', 'feature ospf'])
    expect(text.indexOf('feature ospf')).toBeLessThan(text.indexOf('ip router ospf'))
  })
})

describe('aggregate names suggested for convert', () => {
  it('Junos aeN is port-channel(N+1); IOS-XE Port-channelN and IOS-XR Bundle-EtherN keep N; an unknown source gets none', () => {
    const aggregate = (n: number) => ({ type: 'aggregate' as const, numbers: [n] })
    const name = plugin.nameInterface as (port: Parameters<NonNullable<typeof plugin.nameInterface>>[0], source?: string) => string | undefined
    expect(name(aggregate(0), 'junos')).toBe('port-channel1')
    expect(name(aggregate(4), 'junos')).toBe('port-channel5')
    expect(name(aggregate(5), 'iosxe')).toBe('port-channel5')
    expect(name(aggregate(3), 'iosxr')).toBe('port-channel3')
    expect(name(aggregate(0), 'iosxe')).toBeUndefined()
    expect(name(aggregate(1))).toBeUndefined()
    expect(name({ type: 'ethernet', speed: 1000, numbers: [0, 0, 1] }, 'junos')).toBeUndefined()
    expect(plugin.describeInterface?.('port-channel10')).toEqual(aggregate(10))
    expect(plugin.describeInterface?.('Ethernet1/1')).toBeUndefined()
  })
})
