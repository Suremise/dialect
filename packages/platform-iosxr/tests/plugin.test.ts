// The IOS-XR plugin's behaviour beyond the fixtures: nothing dropped silently, route policies and sets kept whole,
// "no" forms, VRF membership and route targets, routes, SNMP communities left out whole, no secrets in what it says,
// configuration names that are Object.prototype's own, detect, and rendering a model from another platform.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { checkSecrets } from '@dialect/conformance'
import { buildLedger, createRegistry, fieldPath, ledgerProblems, MODEL_VERSION, modelProblems, populatedLeaves, statementsOf, type Device } from '@dialect/core'
import iosxe from '@dialect/platform-iosxe'
import nxos from '@dialect/platform-nxos'
import plugin from '../src'
import { checkFixture } from '@dialect/conformance'
import type { XrNode } from '../src/tree'

const context = { modelVersion: MODEL_VERSION }
const parse = (text: string) => plugin.parse!(text, context)
const render = (model: Device) => plugin.render!(model, context)
/** The kit's checks on `text` against its own parse (or `expectedModel`): what failed. */
const roundTrips = (text: string, expectedModel = parse(text).model) => checkFixture(plugin, { name: text, source: text, expectedModel }).flatMap((r) => (r.status === 'failed' ? r.problems : []))

const root = fileURLToPath(new URL('../../../fixtures/public/', import.meta.url))
const every = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? every(join(dir, e.name)) : [join(dir, e.name)]))
const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url))

describe('nothing is dropped silently', () => {
  it('unknown statements, and everything inside them, are unsupported with their text kept', () => {
    const result = parse('router ospf 1\n area 0\n  interface GigabitEthernet0/0/0/0\nhostname r1')
    expect(result.dispositions.L1).toEqual({ kind: 'unsupported' })
    expect(result.dispositions.L2).toEqual({ kind: 'unsupported' })
    expect(result.dispositions.L3).toEqual({ kind: 'unsupported' })
    expect(result.model).toEqual({ system: { hostname: 'r1' } })
    expect(buildLedger(result).complete).toBe(true)
  })

  it('a statement with an option the model can\'t hold is unsupported as a whole, not half-converted', () => {
    const result = parse('ntp\n server 192.0.2.1 key 1 prefer\n server 192.0.2.2 burst\nrouter static\n address-family ipv4 unicast\n  10.0.0.0/8 192.0.2.1 bfd fast-detect\ninterface GigabitEthernet0/0/0/0\n ipv4 address 192.0.2.5 255.255.255.0 route-tag 5')
    expect(result.model).toEqual({ interfaces: { 'GigabitEthernet0/0/0/0': { type: 'ethernet' } } })
    expect(result.dispositions.L2).toEqual({ kind: 'unsupported', reason: 'a server with an authentication key, which doesn\'t carry over' })
    expect(result.dispositions.L3).toEqual({ kind: 'unsupported', reason: 'word 3 isn\'t converted yet' })
    expect(result.dispositions.L6).toEqual({ kind: 'unsupported', reason: 'a route watched by BFD' })
    expect(result.dispositions.L8).toEqual({ kind: 'unsupported', reason: 'an address with a route tag, which the model can\'t hold' })
  })

  it('a later setting supersedes an earlier one, as on the device: hostname, a primary address, a route\'s next hop', () => {
    const result = parse('hostname a\nhostname b\ninterface Loopback0\n ipv4 address 192.0.2.1 255.255.255.255\n ipv4 address 192.0.2.2 255.255.255.255\nrouter static\n address-family ipv4 unicast\n  10.0.0.0/8 192.0.2.9 tag 1\n  10.0.0.0/8 192.0.2.9 tag 2')
    expect(result.model.system?.hostname).toBe('b')
    expect(result.model.interfaces?.Loopback0.subinterfaces?.['0'].ipv4?.addresses).toEqual({ '192.0.2.2': { prefixLength: 32 } })
    expect(result.model.networkInstances?.default.staticRoutes?.['10.0.0.0/8']).toEqual({ nextHops: { '0': { address: '192.0.2.9', tag: 2 } } })
    expect([result.dispositions.L1, result.dispositions.L4, result.dispositions.L8]).toEqual([
      { kind: 'ignored-by-design', reason: 'superseded by line 2' },
      { kind: 'ignored-by-design', reason: 'replaced by line 5' },
      { kind: 'ignored-by-design', reason: 'superseded by line 9' }
    ])
  })
})

describe('route policies and sets', () => {
  const text = readFileSync(join(fixtures, 'policy/route-policy.cfg'), 'utf8')

  it('an unindented policy body, with nested if … endif, stays one unsupported statement, and so does every set', () => {
    const result = parse(text)
    const statements = statementsOf(result.tree) as XrNode[]
    expect(statements.map((n) => n.kind)).toEqual(['statement', 'set', 'set', 'policy'])
    expect(statements.map((n) => result.dispositions[n.id].kind)).toEqual(['mapped', 'unsupported', 'unsupported', 'unsupported'])
    expect(result.dispositions.L11).toEqual({ kind: 'unsupported', reason: 'a route policy, 11 lines, kept whole: route policies come later' })
    expect(result.model).toEqual({ system: { hostname: 'pe1' } })
  })

  it('a reason never names the policy or set: a name can be anything', () => {
    for (const d of Object.values(parse(text).dispositions)) expect(JSON.stringify(d)).not.toMatch(/CUSTOMER|BLACKHOLE/)
  })

  it('an unterminated policy is a syntax error, and takes the rest of the text', () => {
    const result = parse('route-policy OPEN\n pass\nhostname r1')
    expect(result.diagnostics).toMatchObject([{ severity: 'error', category: 'syntax', code: 'iosxr.unterminated-policy' }])
    expect(result.model).toEqual({})
  })
})

describe('"no …" forms clear what they remove', () => {
  const cases: readonly (readonly [what: string, text: string, model: Device])[] = [
    ['no hostname', 'hostname r1\nno hostname', {}],
    ['no domain name', 'domain name example.net\nno domain name', {}],
    ['no domain list', 'domain list a.example\ndomain list b.example\nno domain list a.example', { system: { dns: { search: ['b.example'] } } }],
    ['no domain name-server', 'domain name-server 192.0.2.53\nno domain name-server 192.0.2.53', {}],
    ['no domain vrf … name-server', 'domain vrf MGMT name-server 192.0.2.53\nno domain vrf MGMT name-server 192.0.2.53', {}],
    ['no description', 'interface Loopback0\n description x\n no description', { interfaces: { Loopback0: { type: 'loopback' } } }],
    ['no mtu', 'interface Bundle-Ether1\n mtu 9000\n no mtu', { interfaces: { 'Bundle-Ether1': { type: 'aggregate' } } }],
    ['no encapsulation dot1q', 'interface Bundle-Ether1.10\n encapsulation dot1q 10\n no encapsulation dot1q', { interfaces: { 'Bundle-Ether1': { type: 'aggregate', subinterfaces: { '10': {} } } } }],
    ['no ipv4 address', 'interface Loopback0\n ipv4 address 192.0.2.1 255.255.255.255\n no ipv4 address', { interfaces: { Loopback0: { type: 'loopback' } } }],
    ['no ipv4 address A M', 'interface Loopback0\n ipv4 address 192.0.2.1 255.255.255.255\n ipv4 address 192.0.2.2 255.255.255.255 secondary\n no ipv4 address 192.0.2.2 255.255.255.255 secondary', { interfaces: { Loopback0: { type: 'loopback', subinterfaces: { '0': { ipv4: { addresses: { '192.0.2.1': { prefixLength: 32 } } } } } } } }],
    ['no ipv6 address A/L', 'interface Loopback0\n ipv6 address 2001:db8::1/128\n ipv6 address 2001:db8::2/128\n no ipv6 address 2001:db8::1/128', { interfaces: { Loopback0: { type: 'loopback', subinterfaces: { '0': { ipv6: { addresses: { '2001:db8::2': { prefixLength: 128 } } } } } } } }],
    ['no vrf (interface)', 'vrf A\ninterface Loopback0\n vrf A\n no vrf', { networkInstances: { A: { type: 'vrf' } }, interfaces: { Loopback0: { type: 'loopback' } } }],
    ['no server (ntp)', 'ntp\n server 192.0.2.123\n no server 192.0.2.123', {}],
    ['no source (ntp)', 'ntp\n source Loopback0\n no source', {}],
    ['no ntp server (one line)', 'ntp server 192.0.2.123\nno ntp server 192.0.2.123', {}],
    ['no logging A', 'logging 192.0.2.50 vrf default severity info\nno logging 192.0.2.50', {}],
    ['no logging source-interface', 'logging source-interface Loopback0\nno logging source-interface', {}],
    ['no snmp-server community', 'snmp-server community PLACEHOLDER RO\nno snmp-server community PLACEHOLDER', {}],
    ['no snmp-server contact', 'snmp-server contact noc\nno snmp-server contact', {}],
    ['no vrf (top)', 'vrf A\n address-family ipv4 unicast\n  import route-target 65000:1\nrouter static\n vrf A\n  address-family ipv4 unicast\n   0.0.0.0/0 192.0.2.1\nno vrf A', {}],
    ['no P (route)', 'router static\n address-family ipv4 unicast\n  10.0.0.0/8 192.0.2.1\n  10.0.0.0/8 192.0.2.2\n  no 10.0.0.0/8 192.0.2.1', { networkInstances: { default: { staticRoutes: { '10.0.0.0/8': { nextHops: { '0': { address: '192.0.2.2' } } } } } } }]
  ]
  for (const [what, text, model] of cases) {
    it(what, () => {
      const result = parse(text)
      expect(result.model).toEqual(model)
      expect(buildLedger(result).complete).toBe(true)
      expect(roundTrips(text)).toEqual([])
    })
  }

  it('the statement a "no" removed says by which line', () => {
    const result = parse('hostname r1\nno hostname')
    expect(result.dispositions.L1).toEqual({ kind: 'ignored-by-design', reason: 'removed by line 2' })
    expect(result.dispositions.L2).toEqual({ kind: 'ignored-by-design', reason: 'removes the hostname on line 1: nothing to convert' })
  })

  it('"no P hop" removes a route line that wasn\'t converted too, matching by prefix and next hop whatever else it says', () => {
    const result = parse('router static\n address-family ipv4 unicast\n  10.0.0.0/24 10.0.0.2 track 2\n  10.0.0.0/24 10.0.0.3\n  no 10.0.0.0/24 10.0.0.2\n  no 10.0.0.0/24 10.0.0.3 description other track 9')
    expect(result.model).toEqual({})
    expect(result.dispositions.L3).toEqual({ kind: 'ignored-by-design', reason: 'removed by line 5' })
    expect(result.dispositions.L4).toEqual({ kind: 'ignored-by-design', reason: 'removed by line 6' })
  })
})

describe('VRF membership', () => {
  const lines = (...l: string[]) => l.join('\n')

  it('"vrf V" puts the interface in the VRF, and clears the addresses before it, as on the device', () => {
    const text = lines('vrf A', '!', 'interface GigabitEthernet0/0/0/0', ' ipv4 address 192.0.2.1 255.255.255.0', ' vrf A', ' ipv4 address 198.51.100.1 255.255.255.0')
    const result = parse(text)
    expect(result.model.interfaces?.['GigabitEthernet0/0/0/0'].subinterfaces).toEqual({ '0': { networkInstance: 'A', ipv4: { addresses: { '198.51.100.1': { prefixLength: 24 } } } } })
    expect(result.dispositions.L4).toEqual({ kind: 'ignored-by-design', reason: 'removed by line 5, which moves the interface to another VRF' })
    expect(roundTrips(text)).toEqual([])
    expect(render(result.model).text).toContain('interface GigabitEthernet0/0/0/0\n vrf A\n ipv4 address 198.51.100.1 255.255.255.0\n!')
  })

  it('a subinterface\'s "vrf" goes on that subinterface', () => {
    const result = parse(lines('vrf A', 'interface Bundle-Ether1.10', ' vrf A', ' encapsulation dot1q 10'))
    expect(result.model.interfaces?.['Bundle-Ether1'].subinterfaces?.['10']).toEqual({ networkInstance: 'A', vlanId: 10 })
  })

  it('an interface in a VRF the text doesn\'t define (or removes) is left out with its addresses, not put in the global table', () => {
    for (const text of [lines('interface Loopback0', ' vrf B', ' ipv4 address 192.0.2.1 255.255.255.255'), lines('vrf B', 'interface Loopback0', ' vrf B', ' ipv4 address 192.0.2.1 255.255.255.255', 'no vrf B')]) {
      const result = parse(text)
      expect(result.model.interfaces, text).toEqual({ Loopback0: { type: 'loopback' } })
      expect(result.dispositions.L3 ?? result.dispositions.L2).toBeDefined()
      expect(modelProblems(result.model)).toEqual([])
      expect(roundTrips(text)).toEqual([])
    }
    const result = parse(lines('interface Loopback0', ' vrf B', ' ipv4 address 192.0.2.1 255.255.255.255'))
    expect(result.dispositions.L2).toEqual({ kind: 'unsupported', reason: 'names a VRF the configuration doesn\'t define' })
    expect(result.dispositions.L3).toEqual({ kind: 'unsupported', reason: 'an address in the VRF of line 2, which the configuration doesn\'t define' })
  })

  it('the VRF may be defined after the interface that names it', () => {
    const text = lines('interface Loopback0', ' vrf A', ' ipv4 address 192.0.2.1 255.255.255.255', '!', 'vrf A')
    expect(parse(text).model.interfaces?.Loopback0.subinterfaces?.['0'].networkInstance).toBe('A')
    expect(roundTrips(text)).toEqual([])
  })

  it('"no vrf" returns the interface to the global table, clearing its addresses', () => {
    const result = parse(lines('vrf A', 'interface Loopback0', ' vrf A', ' ipv4 address 192.0.2.1 255.255.255.255', ' no vrf', ' ipv4 address 192.0.2.2 255.255.255.255'))
    expect(result.model.interfaces?.Loopback0.subinterfaces).toEqual({ '0': { ipv4: { addresses: { '192.0.2.2': { prefixLength: 32 } } } } })
    expect(result.dispositions.L3).toEqual({ kind: 'ignored-by-design', reason: 'undone by line 5' })
    expect(result.dispositions.L5).toEqual({ kind: 'ignored-by-design', reason: 'returns the interface to the default VRF, clearing the addresses on line 4: nothing to convert' })
  })

  it('a render leaves out a membership in a VRF the model doesn\'t have, with the addresses that would land in another table', () => {
    const model: Device = { interfaces: { Loopback0: { subinterfaces: { '0': { networkInstance: 'GONE', ipv4: { addresses: { '192.0.2.1': { prefixLength: 32 } } } } } } } }
    const result = render(model)
    expect(result.text).toBe('interface Loopback0\n!\n')
    expect(result.dispositions[fieldPath('interfaces', 'Loopback0', 'subinterfaces', '0', 'networkInstance')]).toEqual({ kind: 'unsupported', reason: 'a VRF the model doesn\'t have' })
    expect(result.dispositions[fieldPath('interfaces', 'Loopback0', 'subinterfaces', '0', 'ipv4', 'addresses', '192.0.2.1', 'prefixLength')]).toMatchObject({ kind: 'unsupported' })
  })
})

describe('VRF route targets and route distinguishers', () => {
  const vrf = (...family: string[]) => ['vrf A', ...family].join('\n')

  it('map from the one-line and the block form, as sets in each direction', () => {
    for (const text of [vrf(' address-family ipv4 unicast', '  import route-target 65000:1', '  export route-target 65000:2'), vrf(' address-family ipv4 unicast', '  import route-target', '   65000:1', '  !', '  export route-target', '   65000:2')]) {
      expect(parse(text).model.networkInstances?.A, text).toEqual({ type: 'vrf', routeTargets: { import: ['65000:1'], export: ['65000:2'] } })
      expect(roundTrips(text)).toEqual([])
    }
  })

  it('map when every unicast family agrees, in any order, and render under both', () => {
    const text = vrf(' address-family ipv4 unicast', '  import route-target', '   65000:1', '   192.0.2.1:7', ' address-family ipv6 unicast', '  import route-target', '   192.0.2.1:7', '   65000:1')
    const result = parse(text)
    expect(result.model.networkInstances?.A.routeTargets).toEqual({ import: ['65000:1', '192.0.2.1:7'] })
    expect(render(result.model).text).toBe('vrf A\n address-family ipv4 unicast\n  import route-target\n   65000:1\n   192.0.2.1:7\n  !\n !\n address-family ipv6 unicast\n  import route-target\n   65000:1\n   192.0.2.1:7\n  !\n !\n!\n')
    expect(roundTrips(text)).toEqual([])
  })

  it('differing between families, or with one not converted (stitching, asdot), are all left out', () => {
    const cases = [
      vrf(' address-family ipv4 unicast', '  export route-target 65000:1', ' address-family ipv6 unicast', '  export route-target 65000:2'),
      vrf(' address-family ipv4 unicast', '  export route-target 65000:1', ' address-family ipv6 unicast'),
      vrf(' address-family ipv4 unicast', '  export route-target 65000:1', '  import route-target 65000:3 stitching'),
      vrf(' address-family ipv4 unicast', '  export route-target', '   65000:1', '   1.10:12')
    ]
    for (const text of cases) {
      const result = parse(text)
      expect(result.model.networkInstances?.A, text).toEqual({ type: 'vrf' })
      // Every value is unsupported, none mapped: a block form's container groups them and maps nothing itself.
      expect(Object.values(result.dispositions).filter((d) => d.kind === 'mapped' && d.fields.some((f) => f.includes('routeTargets'))), text).toEqual([])
      expect(Object.values(result.dispositions).some((d) => d.kind === 'unsupported'), text).toBe(true)
      expect(buildLedger(result).complete).toBe(true)
    }
  })

  it('in another address family (multicast, flowspec) are that family\'s, and unsupported', () => {
    const result = parse(vrf(' address-family ipv4 multicast', '  export route-target 65000:1'))
    expect(result.model.networkInstances?.A).toEqual({ type: 'vrf' })
    expect([result.dispositions.L2, result.dispositions.L3]).toEqual([{ kind: 'unsupported' }, { kind: 'unsupported' }])
  })

  it('a VRF\'s import and export route policies are unsupported, and leave its route targets alone', () => {
    const result = parse(vrf(' address-family ipv4 unicast', '  import route-policy P', '  import route-target 65000:1'))
    expect(result.model.networkInstances?.A.routeTargets).toEqual({ import: ['65000:1'] })
    expect(result.dispositions.L3).toEqual({ kind: 'unsupported', reason: 'a VRF\'s import or export policy: route policies come later' })
  })

  it('a route distinguisher is BGP\'s on IOS-XR: unsupported in router bgp, and unsupported on render', () => {
    const result = parse('vrf A\nrouter bgp 65000\n vrf A\n  rd 65000:1')
    expect(result.model).toEqual({ networkInstances: { A: { type: 'vrf' } } })
    expect(result.dispositions.L4).toEqual({ kind: 'unsupported' })
    const rendered = render({ networkInstances: { A: { type: 'vrf', routeDistinguisher: '65000:1' }, default: { routeDistinguisher: '65000:2' } } })
    expect(rendered.text).toBe('vrf A\n!\n')
    expect(rendered.dispositions['networkInstances.A.routeDistinguisher']).toEqual({ kind: 'unsupported', reason: 'IOS-XR sets a VRF\'s route distinguisher under router bgp, whose AS the model doesn\'t hold' })
    expect(rendered.dispositions['networkInstances.default.routeDistinguisher']).toMatchObject({ kind: 'unsupported' })
  })

  it('a VRF with only routes isn\'t written as a definition: its routes say it, under router static', () => {
    const text = 'router static\n vrf A\n  address-family ipv4 unicast\n   0.0.0.0/0 192.0.2.1'
    expect(render(parse(text).model).text).toBe('router static\n vrf A\n  address-family ipv4 unicast\n   0.0.0.0/0 192.0.2.1\n  !\n !\n!\n')
    expect(roundTrips(text)).toEqual([])
  })
})

describe('static routes', () => {
  const route = (...r: string[]) => ['router static', ' address-family ipv4 unicast', ...r.map((x) => `  ${x}`)].join('\n')

  it('a malformed address or a stray word isn\'t taken as an interface: the route is unsupported', () => {
    for (const r of ['10.0.0.0/8 192.0.2', '10.0.0.0/8 stray', '10.0.0.0/8 192.0.2.1 stray', '10.0.0.0/8 vrf B 192.0.2.1', '2001:db8::/32 2001:db8::1']) {
      const result = parse(route(r))
      expect(result.model, r).toEqual({})
      expect(result.dispositions.L3, r).toMatchObject({ kind: 'unsupported' })
    }
  })

  it('a second description for a route is unsupported: the model describes the route, IOS-XR each next hop', () => {
    const result = parse(route('10.0.0.0/8 192.0.2.1 description one', '10.0.0.0/8 192.0.2.2 description two'))
    expect(result.model.networkInstances?.default.staticRoutes?.['10.0.0.0/8']).toEqual({ description: 'one', nextHops: { '0': { address: '192.0.2.1' } } })
    expect(result.dispositions.L4).toEqual({ kind: 'unsupported', reason: 'a second description for the route described on line 3' })
  })

  it('a distance, a tag and a quoted description round-trip', () => {
    const text = route('10.0.0.0/8 GigabitEthernet0/0/0/0 192.0.2.1 200 tag 7 description "two words"')
    expect(parse(text).model.networkInstances?.default.staticRoutes?.['10.0.0.0/8']).toEqual({ description: 'two words', nextHops: { '0': { interface: 'GigabitEthernet0/0/0/0', address: '192.0.2.1', preference: 200, tag: 7 } } })
    expect(roundTrips(text)).toEqual([])
  })

  it('stay in their VRF: removing a route or a VRF touches no other VRF, nor the global table', () => {
    const text = [
      'vrf A',
      'vrf B',
      'router static',
      ' address-family ipv4 unicast',
      '  0.0.0.0/0 192.0.2.1',
      ' vrf A',
      '  address-family ipv4 unicast',
      '   0.0.0.0/0 192.0.2.1',
      '   no 0.0.0.0/0 192.0.2.1',
      ' vrf B',
      '  address-family ipv4 unicast',
      '   0.0.0.0/0 192.0.2.1',
      'no vrf A'
    ].join('\n')
    const hop = { staticRoutes: { '0.0.0.0/0': { nextHops: { '0': { address: '192.0.2.1' } } } } }
    expect(parse(text).model.networkInstances).toEqual({ B: { type: 'vrf', ...hop }, default: hop })
    expect(roundTrips(text)).toEqual([])
  })

  it('a prefix of the other family than its address family is unsupported', () => {
    expect(parse(route('2001:db8::/32 Null0')).dispositions.L3).toMatchObject({ kind: 'unsupported' })
  })
})

describe('SNMP communities', () => {
  it('one limited by an access list in any form, or with owner access, is left out whole, whatever comes first', () => {
    for (const extra of ['IPv4 ACL', 'IPv6 ACL6', 'IPv4 ACL IPv6 ACL6', 'ACL', 'SystemOwner', 'SDROwner IPv4 ACL']) {
      for (const text of [`snmp-server community PLACEHOLDER RO\nsnmp-server community PLACEHOLDER RO ${extra}`, `snmp-server community PLACEHOLDER RO ${extra}\nsnmp-server community PLACEHOLDER RO`]) {
        const result = parse(text)
        expect(result.model, text).toEqual({})
        expect(Object.values(result.dispositions).every((d) => d.kind === 'unsupported'), text).toBe(true)
      }
    }
  })

  it('removing part of one leaves it out whole; another community is unaffected', () => {
    const result = parse('snmp-server community PLACEHOLDER RO\nsnmp-server community OTHER RW\nno snmp-server community PLACEHOLDER RO IPv4 ACL')
    expect(result.model.system?.snmp?.communities).toEqual({ OTHER: { access: 'read-write' } })
  })

  it('an encrypted one is unsupported: it doesn\'t carry over', () => {
    expect(parse('snmp-server community encrypted 0123ABCD RO').dispositions.L1).toEqual({ kind: 'unsupported', reason: 'an encrypted community, which doesn\'t carry over' })
  })

  it('one written "clear" maps as the community itself', () => {
    expect(parse('snmp-server community clear PLACEHOLDER RW').model.system?.snmp?.communities).toEqual({ PLACEHOLDER: { access: 'read-write' } })
  })
})

describe('no secret where it is repeated', () => {
  it('a community value reused as a VRF, a description, a route description and an option is in no message', () => {
    const secret = 'CANARY_SECRET'
    const text = [
      `snmp-server community ${secret} RO`,
      `snmp-server community ${secret} RO IPv4 ${secret}`,
      `interface Loopback0`,
      ` vrf ${secret}`,
      ` ipv4 address 192.0.2.1 255.255.255.255`,
      ` ipv4 address 192.0.2.2 255.255.255.255 ${secret}`,
      ` ${secret} on`,
      `router static`,
      ` address-family ipv4 unicast`,
      `  10.0.0.0/8 192.0.2.9 description ${secret}`,
      `  10.0.0.0/8 192.0.2.8 description other`,
      `  10.1.0.0/16 192.0.2.9 ${secret}`,
      `ntp`,
      ` server 192.0.2.123 ${secret}`,
      `logging 192.0.2.50 vrf ${secret} severity ${secret}`,
      `domain name-server ${secret}`,
      `domain vrf ${secret} list example.net`,
      `vrf ${secret}`,
      ` address-family ipv4 unicast`,
      `  import route-target ${secret}`,
      `route-policy ${secret}`,
      ` pass`,
      `end-policy`,
      `no vrf ${secret}`
    ].join('\n')
    const { leaks } = checkSecrets(plugin, text, [secret], { allowances: [] })
    expect(leaks).toEqual([])
    const result = parse(text)
    const said = [...Object.values(result.dispositions).map((d) => ('reason' in d ? (d.reason ?? '') : '')), ...result.diagnostics.map((d) => d.message)]
    for (const s of said) expect(s).not.toContain(secret)
  })

  it('in render dispositions and diagnostics, for a community left out', () => {
    const result = render({ system: { snmp: { communities: { 'SECRET-COMMUNITY': { access: 'read-only', clients: ['192.0.2.0/24'] } } } } })
    expect(result.text).not.toContain('SECRET-COMMUNITY')
    const said = [...Object.values(result.dispositions).map((d) => ('reason' in d ? d.reason : '')), ...result.diagnostics.map((d) => d.message)]
    expect(said.length).toBeGreaterThan(0)
    for (const s of said) expect(s).not.toContain('SECRET-COMMUNITY')
  })
})

describe('configuration names that are Object.prototype\'s own (__proto__, constructor, toString)', () => {
  const KEYS = ['__proto__', 'constructor', 'toString']

  it('stay own keys of the model, round-trip, and never touch Object.prototype', () => {
    const prototypeNames = Object.getOwnPropertyNames(Object.prototype).sort()
    // Twice: a polluted prototype would show on the second parse.
    for (let run = 0; run < 2; run++) {
      for (const key of KEYS) {
        const text = [
          `snmp-server community ${key} RW`,
          `vrf ${key}`,
          ' address-family ipv4 unicast',
          '  import route-target 65000:1',
          `interface Loopback0`,
          ` vrf ${key}`,
          ' ipv4 address 192.0.2.1 255.255.255.255',
          'router static',
          ` vrf ${key}`,
          '  address-family ipv4 unicast',
          '   0.0.0.0/0 192.0.2.1',
          ' address-family ipv4 unicast',
          `  192.0.2.0/24 192.0.2.9 description ${key}`,
          'ntp',
          ' server constructor',
          `domain list ${key}`,
          `domain vrf ${key} name-server 192.0.2.53`
        ].join('\n')
        const result = parse(text)
        const communities = result.model.system?.snmp?.communities ?? {}
        expect(Object.hasOwn(communities, key), key).toBe(true)
        expect(Object.getPrototypeOf(communities)).toBe(Object.prototype)
        expect(communities[key]).toEqual({ access: 'read-write' })
        expect(Object.hasOwn(result.model.networkInstances ?? {}, key)).toBe(true)
        expect(result.model.interfaces?.Loopback0.subinterfaces?.['0'].networkInstance).toBe(key)
        expect(Object.keys(result.model.system?.ntp?.servers ?? {})).toEqual(['constructor'])
        expect(result.model.system?.dns).toEqual({ search: [key], servers: { '192.0.2.53': { networkInstance: key } } })
        expect(modelProblems(result.model)).toEqual([])
        // Through the kit's checks, against the same model as JSON would carry it.
        expect(roundTrips(text, JSON.parse(JSON.stringify(result.model)) as Device)).toEqual([])
        expect(render(result.model).text).toContain(`snmp-server community ${key} RW`)
        // A "no" form for such a name removes it, and only it.
        const removed = parse(`${text}\nno snmp-server community ${key}\nno domain list ${key}`)
        expect(removed.model.system?.snmp).toBeUndefined()
        expect(removed.model.system?.dns?.search).toBeUndefined()
      }
    }
    expect(Object.getOwnPropertyNames(Object.prototype).sort()).toEqual(prototypeNames)
    expect(({} as Record<string, unknown>).access).toBeUndefined()
  })
})

describe('DNS', () => {
  it('a server already named in another VRF is unsupported: the model keys servers by address alone', () => {
    const result = parse('domain vrf A name-server 192.0.2.53\ndomain name-server 192.0.2.53')
    expect(result.model.system?.dns).toEqual({ servers: { '192.0.2.53': { networkInstance: 'A' } } })
    expect(result.dispositions.L2).toEqual({ kind: 'unsupported', reason: 'a server of line 1 in another VRF: the model keys name servers by address alone' })
  })

  it('"vrf default" is the global table: same model as no VRF, and round-trips', () => {
    for (const text of ['domain vrf default name-server 192.0.2.53', 'ntp\n server vrf default 192.0.2.123', 'logging 192.0.2.50 vrf default']) {
      expect(JSON.stringify(parse(text).model), text).not.toContain('networkInstance')
      expect(roundTrips(text), text).toEqual([])
    }
  })

  it('"no domain … name-server" removes a server only in the VRF it names: no VRF and default alike', () => {
    const servers = (text: string) => parse(text).model.system?.dns?.servers
    expect(servers('domain vrf A name-server 192.0.2.53\nno domain vrf B name-server 192.0.2.53')).toEqual({ '192.0.2.53': { networkInstance: 'A' } })
    expect(servers('domain vrf A name-server 192.0.2.53\nno domain name-server 192.0.2.53')).toEqual({ '192.0.2.53': { networkInstance: 'A' } })
    expect(servers('domain name-server 192.0.2.53\nno domain vrf default name-server 192.0.2.53')).toBeUndefined()
  })

  it('a malformed server is unsupported, and so is a VRF\'s own domain or search list', () => {
    expect(parse('domain name-server dns.example.net').dispositions.L1).toEqual({ kind: 'unsupported', reason: 'word 3 isn\'t an address' })
    for (const text of ['domain vrf A list example.net', 'domain vrf A name example.net']) expect(parse(text).dispositions.L1, text).toEqual({ kind: 'unsupported', reason: 'a VRF\'s own DNS settings: the model has one DNS configuration' })
  })
})

describe('logging', () => {
  it('reads IOS-XR\'s severity words, every spelling, and writes its own', () => {
    const words: [string, string][] = [['emergencies', 'emergency'], ['alerts', 'alert'], ['critical', 'critical'], ['errors', 'error'], ['error', 'error'], ['warnings', 'warning'], ['warning', 'warning'], ['notifications', 'notice'], ['informational', 'informational'], ['info', 'informational'], ['debugging', 'debug']]
    for (const [word, severity] of words) {
      const text = `logging 192.0.2.50 vrf default severity ${word}`
      expect(parse(text).model.system?.logging?.remoteServers?.['192.0.2.50'].severity, word).toBe(severity)
      expect(roundTrips(text), word).toEqual([])
    }
  })

  it('the same host in another VRF is unsupported: the model keys hosts by address alone', () => {
    const result = parse('logging 192.0.2.50 vrf A\nlogging 192.0.2.50 vrf B')
    expect(result.model.system?.logging?.remoteServers).toEqual({ '192.0.2.50': { networkInstance: 'A' } })
    expect(result.dispositions.L2).toEqual({ kind: 'unsupported', reason: 'a syslog host of line 1 in another VRF: the model keys syslog hosts by address alone' })
  })

  it('"port default" says nothing, and other logging settings are unsupported', () => {
    expect(parse('logging 192.0.2.50 vrf default port default').model.system?.logging?.remoteServers).toEqual({ '192.0.2.50': {} })
    for (const text of ['logging trap informational', 'logging buffered 1000000', 'logging hostnameprefix r1', 'logging facility local7']) expect(parse(text).dispositions.L1, text).toEqual({ kind: 'unsupported' })
  })
})

describe('the plugin', () => {
  it('loads in the registry as a source and a target, with the other Cisco plugins', () => {
    const registry = createRegistry([plugin, iosxe, nxos])
    expect(registry.sources().map((p) => p.id)).toContain('iosxr')
    expect(registry.targets().map((p) => p.id)).toContain('iosxr')
  })
})

describe('detect', () => {
  const whole = (platform: string) => readdirSync(join(root, platform, 'whole')).map((f) => [f, readFileSync(join(root, platform, 'whole', f), 'utf8')] as const)

  it('is sure of every whole IOS-XR config', () => {
    for (const [name, text] of whole('iosxr')) expect(plugin.detect!(text), name).toBeGreaterThanOrEqual(0.7)
  })

  it('scores whole IOS / IOS-XE and NX-OS configs low, and every Junos file', () => {
    for (const platform of ['iosxe', 'nxos']) for (const [name, text] of whole(platform)) expect(plugin.detect!(text), `${platform}/${name}`).toBeLessThan(0.4)
    const junos = every(join(root, 'junos'))
    expect(junos.length).toBeGreaterThan(200)
    for (const file of junos) expect(plugin.detect!(readFileSync(file, 'utf8')), file).toBeLessThan(0.4)
  })

  it('separates IOS-XR, IOS-XE and NX-OS across the corpus: wherever any is sure, the right one scores highest', () => {
    const plugins = { iosxr: plugin, iosxe, nxos }
    let sure = 0
    for (const platform of ['iosxr', 'iosxe', 'nxos'] as const) {
      for (const file of every(join(root, platform))) {
        const text = readFileSync(file, 'utf8')
        const scores = Object.entries(plugins).map(([id, p]) => [id, p.detect!(text)] as const)
        if (Math.max(...scores.map(([, s]) => s)) < 0.4) continue
        sure++
        const right = scores.find(([id]) => id === platform)![1]
        for (const [id, s] of scores) if (id !== platform) expect(right, `${file}: ${platform} ${right} vs ${id} ${s}`).toBeGreaterThan(s)
      }
    }
    expect(sure).toBeGreaterThan(180)
  })

  it('scores text that isn\'t a config 0', () => {
    expect(plugin.detect!('')).toBe(0)
    expect(plugin.detect!('Dear team, the meeting is at noon.')).toBe(0)
  })
})

describe('rendering a model from another platform', () => {
  // Junos-shaped: unit 0 with its own description, two addresses and no primary, a reject route, a metric, an SNMP
  // client list, an NTP version out of range, a syslog facility, a VRF with a route distinguisher, a virtual router.
  const model: Device = {
    system: {
      hostname: 'mx1',
      ntp: { servers: { '192.0.2.123': { version: 4, prefer: true }, '192.0.2.124': { version: 9 } } },
      snmp: { communities: { PLACEHOLDER: { access: 'read-only', clients: ['192.0.2.0/24'] }, 'PLACEHOLDER-RW': { access: 'read-write', clients: ['198.51.100.0/24'] }, OPEN: {} } },
      logging: { remoteServers: { '192.0.2.50': { severity: 'error' }, '192.0.2.51': { severity: 'notice', facility: 'local7' } } }
    },
    interfaces: {
      'ge-0/0/0': {
        type: 'ethernet',
        description: 'uplink',
        vlanTagging: true,
        subinterfaces: {
          '0': { description: 'unit 0', ipv4: { addresses: { '192.0.2.1': { prefixLength: 24 }, '198.51.100.1': { prefixLength: 24 } }, mtu: 1500 } },
          '10': { vlanId: 10, networkInstance: 'CUST', ipv6: { addresses: { '2001:db8::1': { prefixLength: 64, primary: true } } } }
        }
      }
    },
    networkInstances: {
      default: { type: 'default', staticRoutes: { '0.0.0.0/0': { nextHops: { '0': { drop: 'reject' } } }, '192.0.2.128/25': { nextHops: { '0': { address: '192.0.2.2', metric: 5 } } } } },
      CUST: { type: 'vrf', routeDistinguisher: '65000:1', routeTargets: { import: ['65000:1'], export: ['65000:1'] }, staticRoutes: { '10.0.0.0/8': { nextHops: { '0': { interface: 'ge-0/0/1.0' } } } } },
      LAB: { type: 'virtual-router' }
    }
  }
  const result = render(model)

  it('accounts for every populated field', () => {
    const ledger = buildLedger({ tree: [], model, dispositions: {}, diagnostics: [] }, result)
    expect(ledgerProblems(ledger)).toEqual([])
    expect(ledger.target?.strayPaths).toEqual([])
  })

  it('says what IOS-XR can\'t write, and warns where it chose', () => {
    const notRendered = Object.entries(result.dispositions).filter(([, d]) => d.kind === 'unsupported').map(([path]) => path)
    expect(notRendered.sort()).toEqual([
      'interfaces["ge-0/0/0"].subinterfaces["0"].description',
      'interfaces["ge-0/0/0"].subinterfaces["0"].ipv4.mtu',
      'networkInstances.CUST.routeDistinguisher',
      'networkInstances.LAB.type',
      'networkInstances.default.staticRoutes["0.0.0.0/0"].nextHops["0"].drop',
      'networkInstances.default.staticRoutes["192.0.2.128/25"].nextHops["0"].metric',
      'system.logging.remoteServers["192.0.2.51"].facility',
      'system.ntp.servers["192.0.2.124"].version',
      'system.snmp.communities.PLACEHOLDER.access',
      'system.snmp.communities.PLACEHOLDER.clients',
      'system.snmp.communities["PLACEHOLDER-RW"].access',
      'system.snmp.communities["PLACEHOLDER-RW"].clients'
    ])
    expect(result.diagnostics.map((d) => d.code)).toEqual(['iosxr.primary-chosen', 'iosxr.snmp-community-restricted', 'iosxr.snmp-community-restricted'])
    expect(result.text).toContain('interface ge-0/0/0\n description uplink\n ipv4 address 192.0.2.1 255.255.255.0\n ipv4 address 198.51.100.1 255.255.255.0 secondary\n!\n')
    expect(result.text).toContain('interface ge-0/0/0.10\n vrf CUST\n ipv6 address 2001:db8::1/64\n encapsulation dot1q 10\n!\n')
    expect(result.text).toContain('logging 192.0.2.50 vrf default severity error\nlogging 192.0.2.51 vrf default severity notifications\n')
    expect(result.text).toContain('ntp\n server 192.0.2.123 version 4 prefer\n server 192.0.2.124\n!\n')
    expect(result.text).toContain(' vrf CUST\n  address-family ipv4 unicast\n   10.0.0.0/8 ge-0/0/1.0\n  !\n !\n')
  })

  it('leaves out a community limited to some clients, RO or RW, rather than open it to every client', () => {
    expect(result.text.split('\n').filter((l) => l.startsWith('snmp-server community'))).toEqual(['snmp-server community OPEN'])
  })

  it('doesn\'t echo a left-out community\'s name, a secret, in its warning', () => {
    for (const w of result.diagnostics.filter((d) => d.code === 'iosxr.snmp-community-restricted')) for (const name of ['PLACEHOLDER', 'PLACEHOLDER-RW']) expect(w.message).not.toContain(name)
  })

  it('leaves a field of a later model version unrendered, for the ledger to report', () => {
    const later = { ...model, system: { ...model.system, timezone: 'UTC' } } as Device
    const ledger = buildLedger({ tree: [], model: later, dispositions: {}, diagnostics: [] }, render(later))
    expect(ledgerProblems(ledger)).toEqual(['unrendered: system.timezone'])
  })

  it('writes every leaf of a fully populated IOS-XR model back', () => {
    for (const file of ['interfaces/addresses.cfg', 'vrfs/membership.cfg', 'static-routes/routes.cfg', 'ntp/servers.cfg', 'logging/servers.cfg', 'dns/name-servers.cfg']) {
      const parsed = parse(readFileSync(join(fixtures, file), 'utf8'))
      const rendered = render(parsed.model)
      const notRendered = populatedLeaves(parsed.model).map((l) => l.path).filter((p) => rendered.dispositions[p]?.kind !== 'rendered')
      expect(notRendered.every((p) => /\.type$|\.vlanTagging$/.test(p)), `${file}: ${notRendered.join('\n')}`).toBe(true)
    }
  })
})

describe('review round 1: edits, scopes and ranges', () => {
  const ntp = (...lines: string[]) => ['ntp', ...lines.map((l) => ` ${l}`)].join('\n')
  const servers = (text: string) => parse(text).model.system?.ntp?.servers

  it('an NTP server edited to add an authentication key is left out, not kept without it; another server is unaffected', () => {
    const result = parse(ntp('server 192.0.2.123', 'server 192.0.2.124 prefer', 'server 192.0.2.123 key 1'))
    expect(result.model.system?.ntp?.servers).toEqual({ '192.0.2.124': { prefer: true } })
    expect(result.dispositions.L2).toEqual({ kind: 'ignored-by-design', reason: 'superseded by line 4' })
    expect(result.dispositions.L4).toEqual({ kind: 'unsupported', reason: 'a server with an authentication key, which doesn\'t carry over' })
    expect(render(result.model).text).not.toContain('192.0.2.123')
    // A later supported statement replaces it, and a `no` removes it.
    expect(servers(ntp('server 192.0.2.123 key 1', 'server 192.0.2.123 prefer'))).toEqual({ '192.0.2.123': { prefer: true } })
    const removed = parse(ntp('server 192.0.2.123 key 1', 'no server 192.0.2.123'))
    expect(removed.dispositions.L2).toEqual({ kind: 'ignored-by-design', reason: 'removed by line 3' })
  })

  it('an NTP server is scoped by its VRF: "no server" only in the VRF it names, a second VRF unsupported, block and one-line forms', () => {
    expect(servers(ntp('server vrf A 192.0.2.123', 'no server vrf B 192.0.2.123'))).toEqual({ '192.0.2.123': { networkInstance: 'A' } })
    expect(servers(ntp('server vrf A 192.0.2.123', 'no server 192.0.2.123'))).toEqual({ '192.0.2.123': { networkInstance: 'A' } })
    expect(servers(ntp('server vrf A 192.0.2.123', 'no server vrf A 192.0.2.123'))).toBeUndefined()
    expect(servers(ntp('server 192.0.2.123', 'no server vrf default 192.0.2.123'))).toBeUndefined()
    expect(servers(ntp('server vrf default 192.0.2.123', 'no server 192.0.2.123'))).toBeUndefined()
    expect(servers('ntp server vrf A 192.0.2.123\nno ntp server vrf B 192.0.2.123')).toEqual({ '192.0.2.123': { networkInstance: 'A' } })
    expect(servers('ntp server vrf A 192.0.2.123\nno ntp server vrf A 192.0.2.123')).toBeUndefined()
    const both = parse(ntp('server vrf A 192.0.2.123', 'server vrf B 192.0.2.123'))
    expect(both.model.system?.ntp?.servers).toEqual({ '192.0.2.123': { networkInstance: 'A' } })
    expect(both.dispositions.L3).toEqual({ kind: 'unsupported', reason: 'an NTP server of line 2 in another VRF: the model keys NTP servers by address alone' })
  })

  it('a syslog host edited with an option that isn\'t converted is left out too, and scoped by its VRF', () => {
    const result = parse('logging 192.0.2.50 vrf A severity info\nlogging 192.0.2.50 vrf A severity info discriminator x')
    expect(result.model).toEqual({})
    expect(result.dispositions.L1).toEqual({ kind: 'ignored-by-design', reason: 'superseded by line 2' })
    expect(parse('logging 192.0.2.50 vrf A\nno logging 192.0.2.50 vrf B').model.system?.logging?.remoteServers).toEqual({ '192.0.2.50': { networkInstance: 'A' } })
  })

  it('an interface address edited to add a route tag is left out, not kept without it', () => {
    const iface = (...l: string[]) => ['interface Loopback0', ...l.map((x) => ` ${x}`)].join('\n')
    const primary = parse(iface('ipv4 address 192.0.2.1 255.255.255.255', 'ipv4 address 192.0.2.2 255.255.255.255 secondary', 'ipv4 address 192.0.2.1 255.255.255.255 route-tag 5'))
    expect(primary.model.interfaces?.Loopback0.subinterfaces).toBeUndefined()
    expect(primary.dispositions.L2).toEqual({ kind: 'ignored-by-design', reason: 'replaced by line 4' })
    expect(primary.dispositions.L3).toEqual({ kind: 'unsupported', reason: 'a secondary address beside a primary address that isn\'t converted' })
    const v6 = parse(iface('ipv6 address 2001:db8::1/64', 'ipv6 address 2001:db8::2/64', 'ipv6 address 2001:db8::1/64 route-tag 5'))
    expect(v6.model.interfaces?.Loopback0.subinterfaces?.['0'].ipv6?.addresses).toEqual({ '2001:db8::2': { prefixLength: 64 } })
  })

  describe('removing a static-routing scope clears its routes, converted or not, and no others', () => {
    const base = ['vrf A', 'router static', ' address-family ipv4 unicast', '  10.0.0.0/8 192.0.2.1', '  10.1.0.0/16 192.0.2.1 track 1', ' address-family ipv6 unicast', '  2001:db8::/32 2001:db8::1', ' vrf A', '  address-family ipv4 unicast', '   10.0.0.0/8 192.0.2.1', ' vrf B', '  address-family ipv4 unicast', '   10.0.0.0/8 192.0.2.1']
    const v4 = { '10.0.0.0/8': { nextHops: { '0': { address: '192.0.2.1' } } } }
    const v6 = { '2001:db8::/32': { nextHops: { '0': { address: '2001:db8::1' } } } }
    const cases: readonly (readonly [what: string, extra: string[], instances: Device['networkInstances'], tracked: 'removed' | 'kept'])[] = [
      ['no address-family ipv4 unicast', [' no address-family ipv4 unicast'], { A: { type: 'vrf', staticRoutes: v4 }, B: { staticRoutes: v4 }, default: { staticRoutes: v6 } }, 'removed'],
      ['no vrf A inside router static', [' no vrf A'], { A: { type: 'vrf' }, B: { staticRoutes: v4 }, default: { staticRoutes: { ...v4, ...v6 } } }, 'kept'],
      ['no address-family inside a vrf of router static', [' vrf B', '  no address-family ipv4 unicast'], { A: { type: 'vrf', staticRoutes: v4 }, default: { staticRoutes: { ...v4, ...v6 } } }, 'kept'],
      ['no router static', ['no router static'], { A: { type: 'vrf' } }, 'removed']
    ]
    for (const [what, extra, instances, tracked] of cases) {
      it(what, () => {
        const text = [...base, ...extra].join('\n')
        const result = parse(text)
        expect(result.model.networkInstances).toEqual(instances)
        expect(result.dispositions.L5).toEqual(tracked === 'kept' ? { kind: 'unsupported', reason: 'a route tracked by an object' } : { kind: 'ignored-by-design', reason: `removed by line ${base.length + extra.length}` })
        expect(buildLedger(result).complete).toBe(true)
        expect(roundTrips(text)).toEqual([])
      })
    }
  })

  it('a VLAN ID, an MTU or a route tag outside IOS-XR\'s range is unsupported, at both bounds, never mapped as a rounded number', () => {
    const vlan = (id: string) => parse(`interface Bundle-Ether1.10\n encapsulation dot1q ${id}`)
    for (const ok of ['1', '4094']) expect(vlan(ok).model.interfaces?.['Bundle-Ether1'].subinterfaces?.['10'].vlanId, ok).toBe(Number(ok))
    for (const bad of ['0', '4095', '9999999999999999999999']) {
      const result = vlan(bad)
      expect(result.model.interfaces?.['Bundle-Ether1'].subinterfaces?.['10'], bad).toEqual({})
      expect(result.dispositions.L2, bad).toEqual({ kind: 'unsupported', reason: 'a VLAN ID outside 1 to 4094' })
    }
    const mtu = (n: string) => parse(`interface Bundle-Ether1\n mtu ${n}`)
    for (const ok of ['64', '65535']) expect(mtu(ok).model.interfaces?.['Bundle-Ether1'].mtu, ok).toBe(Number(ok))
    for (const bad of ['63', '65536', '9999999999999999999999']) expect(mtu(bad).dispositions.L2, bad).toEqual({ kind: 'unsupported', reason: 'an MTU outside 64 to 65535' })
    const tag = (n: string) => parse(`router static\n address-family ipv4 unicast\n  10.0.0.0/8 192.0.2.1 tag ${n}`)
    expect(tag('4294967295').model.networkInstances?.default.staticRoutes?.['10.0.0.0/8'].nextHops?.['0'].tag).toBe(4294967295)
    for (const bad of ['0', '4294967296', '9999999999999999999999']) expect(tag(bad).model, bad).toEqual({})
  })

  it('a render leaves out a VLAN ID, MTU, route tag or port IOS-XR wouldn\'t take, from any model', () => {
    const result = render({
      system: { logging: { remoteServers: { '192.0.2.50': { port: 70000 } } } },
      interfaces: { 'Bundle-Ether1': { mtu: 1e22, subinterfaces: { '10': { vlanId: 4095 }, '11': { vlanId: 1e22 }, '12': { vlanId: 1.5 } } } },
      networkInstances: { default: { staticRoutes: { '10.0.0.0/8': { nextHops: { '0': { address: '192.0.2.1', tag: 0 } } } } } }
    })
    expect(result.text).not.toMatch(/dot1q|mtu|tag|port|e\+/)
    const unsupportedPaths = Object.entries(result.dispositions).filter(([, d]) => d.kind === 'unsupported').map(([p]) => p).sort()
    expect(unsupportedPaths).toEqual([
      'interfaces["Bundle-Ether1"].mtu',
      'interfaces["Bundle-Ether1"].subinterfaces["10"].vlanId',
      'interfaces["Bundle-Ether1"].subinterfaces["11"].vlanId',
      'interfaces["Bundle-Ether1"].subinterfaces["12"].vlanId',
      'networkInstances.default.staticRoutes["10.0.0.0/8"].nextHops["0"].tag',
      'system.logging.remoteServers["192.0.2.50"].port'
    ])
  })

  it('a banner\'s reason never names its type: a secret can be reused as one', () => {
    for (const secret of ['prompt-timeout', 'slip-ppp', 'motd']) {
      const text = `snmp-server community ${secret} RO\nbanner ${secret} #hello#`
      expect(parse(text).dispositions.L2, secret).toEqual({ kind: 'unsupported', reason: 'a banner, 1 line, kept verbatim' })
      expect(checkSecrets(plugin, text, [secret], { allowances: [] }).leaks, secret).toEqual([])
      expect(checkFixture(plugin, { name: secret, source: text, expectedModel: parse(text).model, secrets: [secret] }, { allowances: [] }).filter((r) => r.status === 'failed')).toEqual([])
    }
  })
})
