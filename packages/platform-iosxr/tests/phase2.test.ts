// OSPF and BGP (model 0.4) beyond their fixtures: IOS-XR's inheritance of OSPF settings, later statements acting on
// earlier ones (`no …` forms, a VRF's deletion), what is left out and why, the secrets the model only flags (asked for on
// render, written when answered), RFC 8212 (an eBGP neighbor with no policy exchanges nothing on IOS-XR), the semantic
// warnings, rendering models from other platforms, Layer 2 left out, and the aggregate names suggested for convert.
import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { checkFixture, checkSecrets } from '@dialect/conformance'
import { buildLedger, deserializeModel, fieldPath, ledgerProblems, MODEL_VERSION, type Context, type Device, type ParseResult } from '@dialect/core'
import plugin from '../src'

const context = { modelVersion: MODEL_VERSION }
const parse = (text: string) => plugin.parse!(text, context)
const render = (model: Device, inputs?: Context['inputs']) => plugin.render!(model, { ...context, ...(inputs ? { inputs } : {}) })
const lines = (...l: string[]) => l.join('\n')
const at = (result: ParseResult, n: number) => result.dispositions[`L${n}`]
const roundTrips = (text: string) => checkFixture(plugin, { name: text, source: text, expectedModel: parse(text).model }).flatMap((r) => (r.status === 'failed' ? r.problems : []))
const accounted = (model: Device, inputs?: Context['inputs']) => ledgerProblems(buildLedger({ tree: [], model, dispositions: {}, diagnostics: [] }, render(model, inputs)))
const codes = (result: { diagnostics: readonly { code?: string }[] }) => result.diagnostics.map((d) => d.code)
const loopbacks = (...n: number[]) => n.flatMap((i) => [`interface Loopback${i}`, ` ipv4 address 192.0.2.${i} 255.255.255.255`, '!'])

describe('OSPF', () => {
  const ospf = (result: ParseResult, instance = 'default') => result.model.networkInstances?.[instance]?.ospf

  it('an interface takes its own settings, else its area\'s, else its process\'s', () => {
    const text = lines(...loopbacks(1, 2, 3), 'router ospf 1', ' cost 10', ' hello-interval 5', ' area 0', '  cost 20', '  interface Loopback1', '   cost 30', '  !', '  interface Loopback2', '  !', ' !', ' area 1', '  interface Loopback3', '  !', ' !', '!')
    const result = parse(text)
    expect(ospf(result)?.areas).toEqual({
      '0.0.0.0': { interfaces: { Loopback1: { enabledBy: 'interface', cost: 30, helloInterval: 5 }, Loopback2: { enabledBy: 'interface', cost: 20, helloInterval: 5 } } },
      '0.0.0.1': { interfaces: { Loopback3: { enabledBy: 'interface', cost: 10, helloInterval: 5 } } }
    })
    // The process's cost fills only Loopback3; its hello interval, all three.
    expect(at(result, 11)).toEqual({ kind: 'mapped', fields: ['networkInstances.default.ospf.areas["0.0.0.1"].interfaces.Loopback3.cost'] })
    expect(roundTrips(text)).toEqual([])
  })

  it('passive disable overrides an inherited passive; a setting no interface takes says so', () => {
    const result = parse(lines(...loopbacks(1, 2), 'router ospf 1', ' passive enable', ' network point-to-point', ' area 0', '  interface Loopback1', '   passive disable', '   network broadcast', '  !', '  interface Loopback2', '  !', ' !', '!'))
    expect(ospf(result)?.areas?.['0.0.0.0'].interfaces).toEqual({ Loopback1: { enabledBy: 'interface', networkType: 'broadcast' }, Loopback2: { enabledBy: 'interface', passive: true, networkType: 'point-to-point' } })
    expect(at(result, 12)).toEqual({ kind: 'ignored-by-design', reason: 'not passive, overriding the area\'s or the process\'s passive: written back as the interface\'s own setting is' })
    const unused = parse(lines(...loopbacks(1), 'router ospf 1', ' area 0', '  cost 5', '  interface Loopback1', '   cost 6', '  !', ' !', '!'))
    expect(at(unused, 6)).toEqual({ kind: 'ignored-by-design', reason: 'no interface takes it from here: nothing to convert' })
  })

  it('what the model can\'t hold is left out: an undefined interface, another VRF\'s, a second area, a second process', () => {
    const result = parse(lines('vrf A', '!', ...loopbacks(1, 2), 'interface Loopback3', ' vrf A', '!', 'router ospf 1', ' area 0', '  interface Loopback9', '  !', '  interface Loopback3', '  !', '  interface Loopback1', '  !', ' !', ' area 1', '  interface Loopback1', '  !', ' !', '!', 'router ospf 2', ' router-id 192.0.2.2', '!'))
    expect(ospf(result)).toEqual({ processId: '1', areas: { '0.0.0.0': { interfaces: { Loopback1: { enabledBy: 'interface' } } } } })
    expect(at(result, 14)).toEqual({ kind: 'unsupported', reason: 'OSPF on an interface the configuration doesn\'t define' })
    expect(at(result, 16)).toEqual({ kind: 'unsupported', reason: 'OSPF on an interface in another network instance than the process\'s' })
    expect(at(result, 22)).toEqual({ kind: 'unsupported', reason: 'an interface already in an area on line 18: IOS-XR puts one in one area' })
    expect([at(result, 26), at(result, 27)]).toEqual(Array.from({ length: 2 }, () => ({ kind: 'unsupported', reason: 'a second OSPF process in the same table: the model has one per network instance' })))
  })

  it('"no" forms: a setting, an interface, an area, a process', () => {
    const base = [...loopbacks(1, 2), 'router ospf 1', ' router-id 192.0.2.1', ' area 0', '  interface Loopback1', '   cost 5', '  !', '  interface Loopback2', '  !', ' !', ' area 1', '  stub', ' !', '!']
    const settings = parse(lines(...base, 'router ospf 1', ' no router-id', ' area 0', '  interface Loopback1', '   no cost', '  !', '  no interface Loopback2', ' !', ' no area 1', '!'))
    expect(ospf(settings)).toEqual({ processId: '1', areas: { '0.0.0.0': { interfaces: { Loopback1: { enabledBy: 'interface' } } } } })
    const process = parse(lines(...base, 'no router ospf 1'))
    expect(ospf(process)).toBeUndefined()
    expect(at(process, 7)).toEqual({ kind: 'ignored-by-design', reason: 'removed by line 20' })
  })

  it('a VRF\'s deletion leaves its OSPF out, as uncertain', () => {
    const result = parse(lines('vrf A', '!', 'interface Loopback1', ' vrf A', '!', 'router ospf 1', ' vrf A', '  area 0', '   interface Loopback1', '   !', '  !', ' !', '!', 'no vrf A', 'vrf A', '!'))
    for (const n of [7, 8, 9]) expect(at(result, n), `line ${n}`).toEqual({ kind: 'unsupported', reason: 'in a VRF line 14 deletes: what the device keeps of it isn\'t certain' })
  })

  it('a key is never carried: flagged on parse, asked for on render, written when answered', () => {
    const text = lines(...loopbacks(1), 'router ospf 1', ' area 0', '  interface Loopback1', '   authentication message-digest', '   message-digest-key 1 md5 encrypted CANARY_KEY', '  !', ' !', '!')
    const result = parse(text)
    expect(at(result, 8)).toEqual({ kind: 'ignored-by-design', reason: 'an OSPF key: never carried, the target asks for it' })
    expect(JSON.stringify(result.model)).not.toContain('CANARY_KEY')
    expect(checkSecrets(plugin, text, ['CANARY_KEY'], { allowances: [] }).leaks).toEqual([])
    const entry = fieldPath('networkInstances', 'default', 'ospf', 'areas', '0.0.0.0', 'interfaces', 'Loopback1')
    const asked = render(result.model)
    expect(asked.needsInput).toEqual([{ id: `iosxr.ospf-key:${entry}`, kind: 'secret', message: expect.stringContaining('key ID'), field: `${entry}.authentication` }])
    const answered = render(result.model, { [`iosxr.ospf-key:${entry}`]: '3 NEW-KEY' })
    expect(answered.needsInput).toBeUndefined()
    expect(answered.text).toContain('   authentication message-digest\n   message-digest-key 3 md5 clear NEW-KEY\n')
    const wrong = render(result.model, { [`iosxr.ospf-key:${entry}`]: 'NOT-AN-ID' })
    expect(wrong.diagnostics.find((d) => d.code === 'iosxr.answer-not-taken')?.message).not.toContain('NOT-AN-ID')
  })

  it('a key chain is asked for by name, on an area or an interface, and the round trip leaves it to the answer', () => {
    const text = lines(...loopbacks(1), 'router ospf 1', ' area 0', '  authentication keychain CHAIN-A', '  interface Loopback1', '  !', ' !', '!')
    const result = parse(text)
    expect(result.model.networkInstances?.default.ospf?.areas?.['0.0.0.0'].authentication).toBe('key-chain')
    const asked = render(result.model)
    expect(asked.needsInput?.map((n) => n.kind)).toEqual(['secret'])
    expect(roundTrips(text)).toEqual([])
    const answered = render(result.model, { [asked.needsInput![0].id]: 'CHAIN-B' })
    expect(answered.text).toContain(' area 0.0.0.0\n  authentication keychain CHAIN-B\n')
  })
})

describe('BGP', () => {
  const bgp = (result: ParseResult, instance = 'default') => result.model.networkInstances?.[instance]?.bgp

  it('a neighbor on one line or in a block, a neighbor group it uses, an asdot AS, a bare ebgp-multihop', () => {
    const text = lines('router bgp 1.10', ' neighbor-group G', '  remote-as 65001', ' !', ' neighbor 192.0.2.2', '  use neighbor-group G', '  ebgp-multihop', ' !', ' neighbor 2001:DB8::2 remote-as 65546', '!')
    const result = parse(text)
    expect(bgp(result)).toEqual({ localAs: 65546, groups: { G: { peerAs: 65001 } }, neighbors: { '192.0.2.2': { group: 'G', multihop: {} }, '2001:db8::2': { peerAs: 65546 } }, ebgpDefaultPolicy: { import: 'reject', export: 'reject' } })
    expect(roundTrips(text)).toEqual([])
  })

  it('a route policy names one the text converts (#79); one it doesn\'t define, one not converted and one with parameters are left out, unnamed', () => {
    const peer = (...policy: string[]) => ['router bgp 65000', ' neighbor 192.0.2.2', '  remote-as 65001', '  address-family ipv4 unicast', ...policy, '!']
    const result = parse(lines(...peer('   route-policy CANARY in', '   route-policy P(10) out'), 'route-policy CANARY', '  done', 'end-policy'))
    expect(bgp(result)?.neighbors?.['192.0.2.2'].addressFamilies).toEqual({ 'ipv4-unicast': { importPolicies: ['CANARY'] } })
    expect(result.model.routingPolicy?.policies?.CANARY).toEqual({ terms: { '1': { actions: { flow: 'accept' } } }, fallThrough: 'reject' })
    expect(result.diagnostics.filter((d) => d.code === 'iosxr.route-policy-name-only')).toEqual([])
    expect(at(result, 6)).toEqual({ kind: 'unsupported', reason: 'a route policy with parameters, which the simple form doesn\'t have' })
    const undefinedPolicy = parse(lines(...peer('   route-policy CANARY in')))
    expect(bgp(undefinedPolicy)?.neighbors?.['192.0.2.2'].addressFamilies).toEqual({ 'ipv4-unicast': {} })
    expect(at(undefinedPolicy, 5)).toEqual({ kind: 'unsupported', reason: 'names a route policy the configuration doesn\'t define' })
    const nested = parse(lines(...peer('   route-policy CANARY in'), 'route-policy CANARY', '  if tag eq 1 then', '    if tag eq 2 then', '      drop', '    endif', '  endif', 'end-policy'))
    expect(at(nested, 5)).toEqual({ kind: 'unsupported', reason: 'names a route policy that isn\'t converted' })
    // No message or reason names it (field paths name the config's own structure).
    for (const r of [result, undefinedPolicy, nested]) expect(JSON.stringify([r.diagnostics.map((d) => d.message), Object.values(r.dispositions).map((d) => ('reason' in d ? d.reason : ''))])).not.toContain('CANARY')
  })

  it('"no" forms: a neighbor, a group, a family, a setting, BGP itself', () => {
    const base = ['router bgp 65000', ' neighbor-group G', '  remote-as 65000', ' !', ' neighbor 192.0.2.2', '  use neighbor-group G', '  description d', '  address-family ipv4 unicast', '   route-policy P out', '  !', ' !', '!']
    const settings = parse(lines(...base, 'router bgp 65000', ' neighbor 192.0.2.2', '  no description', '  no address-family ipv4 unicast', ' !', '!'))
    expect(bgp(settings)?.neighbors).toEqual({ '192.0.2.2': { group: 'G' } })
    const peers = parse(lines(...base, 'router bgp 65000', ' no neighbor 192.0.2.2', ' no neighbor-group G', '!'))
    expect(bgp(peers)).toEqual({ localAs: 65000 })
    const all = parse(lines(...base, 'no router bgp 65000'))
    expect(all.model.networkInstances).toBeUndefined()
    expect(at(all, 1)).toEqual({ kind: 'ignored-by-design', reason: 'removed by line 13' })
  })

  it('what doesn\'t resolve is left out: a VRF, an update source, a group; a second AS', () => {
    const result = parse(lines('router bgp 65000', ' neighbor 192.0.2.2', '  update-source Loopback9', '  use neighbor-group NONE', ' !', ' vrf B', '  neighbor 192.0.2.3 remote-as 65001', ' !', '!', 'router bgp 65001', ' bgp router-id 192.0.2.1', '!'))
    expect(bgp(result)).toEqual({ localAs: 65000, neighbors: { '192.0.2.2': {} } })
    expect(at(result, 3)).toEqual({ kind: 'unsupported', reason: 'names an interface the configuration doesn\'t define' })
    expect(at(result, 4)).toEqual({ kind: 'unsupported', reason: 'names a neighbor group the configuration doesn\'t define here' })
    expect([at(result, 6), at(result, 7)]).toEqual(Array.from({ length: 2 }, () => ({ kind: 'unsupported', reason: 'BGP in a VRF the configuration doesn\'t define' })))
    expect(at(result, 10)).toEqual({ kind: 'unsupported', reason: 'a second BGP AS beside line 1\'s: the model has one' })
  })

  it('a VRF\'s deletion leaves its BGP and route distinguisher out, as uncertain', () => {
    const result = parse(lines('vrf A', '!', 'router bgp 65000', ' vrf A', '  rd 65000:1', '  neighbor 192.0.2.2 remote-as 65001', ' !', '!', 'no vrf A', 'vrf A', '!'))
    for (const n of [4, 5, 6]) expect(at(result, n), `line ${n}`).toEqual({ kind: 'unsupported', reason: 'in a VRF line 9 deletes: what the device keeps of it isn\'t certain' })
    expect(result.model.networkInstances?.A).toEqual({ type: 'vrf' })
  })

  it('a password is never carried: flagged on parse, asked for on render, and the round trip leaves it to the answer', () => {
    const text = lines('router bgp 65000', ' neighbor 192.0.2.2', '  remote-as 65000', '  password encrypted CANARY_PASSWORD', '!')
    const result = parse(text)
    expect(bgp(result)?.neighbors?.['192.0.2.2'].authentication).toBe(true)
    expect(checkSecrets(plugin, text, ['CANARY_PASSWORD'], { allowances: [] }).leaks).toEqual([])
    const id = `iosxr.bgp-password:${fieldPath('networkInstances', 'default', 'bgp', 'neighbors', '192.0.2.2')}`
    expect(render(result.model).needsInput).toEqual([{ id, kind: 'secret', message: 'A BGP session with a password needs the password, which isn\'t carried.', field: 'networkInstances.default.bgp.neighbors["192.0.2.2"].authentication' }])
    expect(roundTrips(text)).toEqual([])
    const answered = render(result.model, { [id]: 'NEW-PASSWORD' })
    expect(answered.text).toContain('  password clear NEW-PASSWORD\n')
    expect(parse(answered.text).model).toEqual(result.model)
  })
})

describe('RFC 8212: an eBGP neighbor with no policy exchanges no routes on IOS-XR', () => {
  /** A Junos-sourced model: Junos accepts an eBGP peer's routes with no policy, both ways. */
  const junos: Device = {
    networkInstances: {
      default: {
        bgp: {
          localAs: 65000,
          ebgpDefaultPolicy: { import: 'accept', export: 'accept' },
          neighbors: { '198.51.100.1': { peerAs: 64512, addressFamilies: { 'ipv4-unicast': {} } }, '192.0.2.2': { peerAs: 65000, addressFamilies: { 'ipv4-unicast': {} } } }
        }
      }
    }
  }
  const id = `iosxr.ebgp-policy:${fieldPath('networkInstances', 'default', 'bgp', 'neighbors', '198.51.100.1')}`

  it('a Junos-sourced eBGP neighbor without a policy is a needs-input item, with a warning; never a made-up pass policy', () => {
    const result = render(junos)
    expect(result.needsInput).toEqual([{ id, kind: 'other', message: expect.stringContaining('RFC 8212'), field: 'networkInstances.default.bgp.neighbors["198.51.100.1"]' }])
    expect(codes(result)).toEqual(['iosxr.ebgp-default-policy'])
    expect(result.text).not.toMatch(/route-policy|pass/)
    expect(result.dispositions['networkInstances.default.bgp.ebgpDefaultPolicy.import']).toMatchObject({ kind: 'not-applicable' })
    expect(accounted(junos)).toEqual([])
  })

  it('the answer names a route policy, written each way the neighbor has none', () => {
    const result = render(junos, { [id]: 'EBGP-POLICY' })
    expect(result.needsInput).toBeUndefined()
    expect(result.text).toContain(' neighbor 198.51.100.1\n  remote-as 64512\n  address-family ipv4 unicast\n   route-policy EBGP-POLICY in\n   route-policy EBGP-POLICY out\n')
    const half: Device = { networkInstances: { default: { bgp: { localAs: 65000, neighbors: { '198.51.100.1': { peerAs: 64512, addressFamilies: { 'ipv4-unicast': { importPolicies: ['IN'] } } } } } } } }
    expect(render(half, { [id]: 'OUT' }).text).toContain('   route-policy IN in\n   route-policy OUT out\n')
  })

  it('an IOS-XR source says its default: reject, the ways a neighbor has no policy', () => {
    // The policies they name, defined after them (a policy is converted once the text is read), so line numbers stay.
    const defined = ['IN', 'OUT', 'IN6', 'G-IN', 'G-OUT', 'OWN'].flatMap((n) => [`route-policy ${n}`, '  pass', 'end-policy'])
    const withPolicies = (...l: string[]) => [...l, ...defined].join('\n')
    const result = parse(withPolicies('router bgp 65000', ' neighbor 192.0.2.2', '  remote-as 65001', '  address-family ipv4 unicast', '   route-policy IN in', '!'))
    expect(result.model.networkInstances?.default.bgp?.ebgpDefaultPolicy).toEqual({ export: 'reject' })
    expect(at(result, 1)).toEqual({ kind: 'mapped', fields: ['networkInstances.default.bgp.localAs', 'networkInstances.default.bgp.ebgpDefaultPolicy.export'] })
    // Each family it carries counts on its own: a policy on IPv4 doesn't cover IPv6, the neighbor's or its group's.
    const policy = (...l: string[]) => parse(withPolicies('router bgp 65000', ...l, '!')).model.networkInstances?.default.bgp?.ebgpDefaultPolicy
    const v4 = ['  address-family ipv4 unicast', '   route-policy IN in', '   route-policy OUT out', '  !']
    expect(policy(' neighbor 192.0.2.2', '  remote-as 65001', ...v4, '  address-family ipv6 unicast', '  !', ' !')).toEqual({ import: 'reject', export: 'reject' })
    expect(policy(' neighbor-group G', '  remote-as 65001', ...v4, ' !', ' neighbor 192.0.2.2', '  use neighbor-group G', '  address-family ipv6 unicast', '  !', ' !')).toEqual({ import: 'reject', export: 'reject' })
    expect(policy(' neighbor 192.0.2.2', '  remote-as 65001', ...v4, '  address-family ipv6 unicast', '   route-policy IN6 in', '  !', ' !')).toEqual({ export: 'reject' })
    expect(policy(' neighbor 192.0.2.2', '  remote-as 65001', ...v4, ' !')).toBeUndefined()
    // The neighbor's own family settings win over its group's: the group's IPv6 policies cover what the neighbor leaves.
    expect(policy(' neighbor-group G', '  remote-as 65001', '  address-family ipv6 unicast', '   route-policy G-IN in', '   route-policy G-OUT out', '  !', ' !', ' neighbor 192.0.2.2', '  use neighbor-group G', ...v4, '  address-family ipv6 unicast', '   route-policy OWN in', '  !', ' !')).toBeUndefined()
    // With no family at all, as before: nothing carries a policy, both ways.
    expect(policy(' neighbor 192.0.2.2', '  remote-as 65001', ' !')).toEqual({ import: 'reject', export: 'reject' })
    // An iBGP neighbor says nothing of it.
    expect(parse(withPolicies('router bgp 65000', ' neighbor 192.0.2.2', '  remote-as 65000', '!')).model.networkInstances?.default.bgp?.ebgpDefaultPolicy).toBeUndefined()
  })
})

describe('Layer 2 on IOS-XR', () => {
  it('VLANs, switch ports and routed VLANs are left out on render this phase, every field accounted for', () => {
    const model: Device = { vlans: { '10': { name: 'SERVERS' } }, interfaces: { 'GigabitEthernet0/0/0/0': { switching: { mode: 'access', accessVlan: 10 } }, BVI10: { type: 'irb-or-svi', subinterfaces: { '0': { routedVlan: 10 } } } } }
    const result = render(model)
    expect(result.text).not.toMatch(/vlan|switchport|l2transport/i)
    expect(result.dispositions['vlans["10"].name']).toMatchObject({ kind: 'unsupported' })
    expect(result.dispositions['interfaces.BVI10.subinterfaces["0"].routedVlan']).toMatchObject({ kind: 'unsupported' })
    expect(accounted(model)).toEqual([])
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

  it('every phase 2 and 3 warning comes from a saved source fixture or model', () => {
    const fixtures = new URL('./fixtures/', import.meta.url)
    const sources = ['ospf', 'bgp'].flatMap((area) => readdirSync(new URL(`${area}/`, fixtures)).filter((f) => f.endsWith('.cfg') && !f.endsWith('.rendered.cfg')).map((f) => new URL(`${area}/${f}`, fixtures)))
    const raised = new Set([
      ...sources.flatMap((file) => {
        const parsed = parse(readFileSync(file, 'utf8'))
        return [...codes(parsed), ...codes(render(parsed.model))]
      }),
      ...cases.flatMap((name) => codes(render(deserializeModel(readFileSync(new URL(`${name}.model.json`, models), 'utf8')).device)))
    ])
    for (const code of ['iosxr.route-policy-name-only', 'iosxr.ebgp-default-policy', 'iosxr.bgp-no-address-family', 'iosxr.ospf-enabled-per-interface', 'iosxr.policy-fall-through', 'iosxr.vrf-policy-mode', 'iosxr.filter-implicit-action']) expect(raised, code).toContain(code)
  })
})

describe('aggregate names suggested for convert', () => {
  it('an aggregate, counted from 1 as every plugin describes it, keeps its number; aggregate 0 and other ports get none', () => {
    const aggregate = (n: number) => ({ type: 'aggregate' as const, numbers: [n] })
    expect(plugin.nameInterface?.(aggregate(1))).toBe('Bundle-Ether1')
    expect(plugin.nameInterface?.(aggregate(65535))).toBe('Bundle-Ether65535')
    expect(plugin.nameInterface?.(aggregate(0))).toBeUndefined()
    expect(plugin.nameInterface?.(aggregate(65536))).toBeUndefined()
    expect(plugin.nameInterface?.({ type: 'loopback', numbers: [0] })).toBeUndefined()
    expect(plugin.describeInterface?.('Bundle-Ether10')).toEqual(aggregate(10))
    expect(plugin.describeInterface?.('GigabitEthernet0/0/0/0')).toBeUndefined()
  })
})
