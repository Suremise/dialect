// The plugin beyond its fixtures: nothing dropped silently, later statements acting on earlier ones (`no …` forms,
// `vrf member`, `ip address dhcp`), VRF membership, route distinguishers and route targets, the `feature` and
// `switchport` lines a render must carry, configuration names that are Object.prototype's own, no secrets in what the
// plugin reports, detect(), and rendering a model that came from another platform.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { checkFixture, checkSecrets, findSecrets } from '@dialect/conformance'
import { buildLedger, createRegistry, fieldPath, ledgerProblems, MODEL_VERSION, populatedLeaves, statementsOf, type Device, type ParseResult } from '@dialect/core'
import iosxe from '@dialect/platform-iosxe'
import plugin from '../src'
import { isIpv6, lengthMask, maskLength } from '../src/addresses'
import type { NxNode } from '../src/tree'

const context = { modelVersion: MODEL_VERSION }
const parse = (text: string) => plugin.parse!(text, context)
const render = (model: Device) => plugin.render!(model, context)
const byText = (result: ParseResult) => new Map(statementsOf(result.tree).map((n) => [(n as NxNode).text, result.dispositions[n.id]]))
/** The kit's four checks on `text` against its own parse: no error, a complete ledger, a stable round trip. */
const roundTrips = (text: string, expectedModel = parse(text).model) => checkFixture(plugin, { name: text, source: text, expectedModel }).flatMap((r) => (r.status === 'failed' ? r.problems : []))

const root = fileURLToPath(new URL('../../../fixtures/public/', import.meta.url))
const every = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? every(join(dir, e.name)) : [join(dir, e.name)]))
const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url))
const fixtureSources = every(fixtures).filter((f) => f.endsWith('.cfg') && !f.endsWith('.rendered.cfg'))

describe('nothing is dropped silently', () => {
  it('unknown statements, and everything inside them, are unsupported with their text kept', () => {
    const text = ['hostname n1', 'router eigrp 1', '  router-id 192.0.2.1', 'interface Ethernet1/1', '  speed 1000', '  hsrp 10', '    ip 192.0.2.254', 'frobnicate now'].join('\n')
    const result = parse(text)
    const d = byText(result)
    for (const t of ['router eigrp 1', 'router-id 192.0.2.1', 'speed 1000', 'hsrp 10', 'ip 192.0.2.254', 'frobnicate now']) expect(d.get(t), t).toMatchObject({ kind: 'unsupported' })
    expect(buildLedger(result).complete).toBe(true)
  })

  it('a banner comes through as one atomic unsupported statement', () => {
    const banner = ['banner motd #', 'Line 1', 'interface Ethernet1/1', '  ip address 192.0.2.1/24', '#']
    const result = parse([...banner, 'hostname n1'].join('\n'))
    const nodes = result.tree as readonly NxNode[]
    expect(nodes[0]).toMatchObject({ kind: 'banner', text: banner.join('\n'), children: [] })
    expect(result.dispositions[nodes[0].id]).toEqual({ kind: 'unsupported', reason: 'a motd banner, 5 lines, kept verbatim' })
    // The interface inside the banner is banner text, not configuration.
    expect(result.model).toEqual({ system: { hostname: 'n1' } })
  })

  it('a statement with an option the model can\'t hold is unsupported as a whole, not half-converted', () => {
    const result = parse(['ntp server 192.0.2.1 key 1', 'logging server 192.0.2.2 5 secure', 'ip route 10.0.0.0/8 192.0.2.1 track 1', 'ip route 10.0.0.0/8 192.0.2.1 vrf B', 'ip name-server 192.0.2.53 source-interface loopback0', 'interface Ethernet1/1', '  ip address 192.0.2.9/24 tag 5'].join('\n'))
    expect(result.model).toEqual({ interfaces: { 'Ethernet1/1': { type: 'ethernet' } } })
    expect(Object.values(result.dispositions).filter((d) => d.kind !== 'mapped').map((d) => d.kind)).toEqual(Array(6).fill('unsupported'))
  })

  it('a later setting supersedes an earlier one, as on the device: hostname, addresses, a route\'s next hop', () => {
    const result = parse(['hostname a', 'switchname b', 'interface Ethernet1/1', '  ip address 192.0.2.1/24', '  ip address 192.0.2.9/24', 'ip route 10.0.0.0/8 192.0.2.1 name one tag 5', 'ip route 10.0.0.0/8 192.0.2.1 250'].join('\n'))
    expect(result.model.system?.hostname).toBe('b')
    expect(result.dispositions.L1).toEqual({ kind: 'ignored-by-design', reason: 'superseded by line 2' })
    expect(Object.keys(result.model.interfaces?.['Ethernet1/1'].subinterfaces?.['0'].ipv4?.addresses ?? {})).toEqual(['192.0.2.9'])
    expect(result.dispositions.L4).toEqual({ kind: 'ignored-by-design', reason: 'replaced by line 5' })
    // The same next hop again is an edit of it, not a second next hop.
    expect(result.model.networkInstances?.default.staticRoutes?.['10.0.0.0/8']).toEqual({ nextHops: { '0': { address: '192.0.2.1', preference: 250 } } })
    expect(result.dispositions.L6).toEqual({ kind: 'ignored-by-design', reason: 'superseded by line 7' })
  })
})

describe('"no …" forms clear what they remove', () => {
  const cases: readonly (readonly [string, string[], Device])[] = [
    ['description', ['interface Ethernet1/1', '  description d', '  no description'], { interfaces: { 'Ethernet1/1': { type: 'ethernet' } } }],
    ['ip address', ['interface Ethernet1/1', '  ip address 192.0.2.1/24', '  ip address 198.51.100.1/24 secondary', '  no ip address'], { interfaces: { 'Ethernet1/1': { type: 'ethernet' } } }],
    ['ipv6 address', ['interface Ethernet1/1', '  ipv6 address 2001:db8::1/64', '  no ipv6 address', '  ip address 192.0.2.1/24'], { interfaces: { 'Ethernet1/1': { type: 'ethernet', subinterfaces: { '0': { ipv4: { addresses: { '192.0.2.1': { prefixLength: 24 } } } } } } } }],
    ['hostname', ['hostname a', 'no hostname'], {}],
    ['domain name', ['ip domain-name example.net', 'no ip domain-name example.net'], {}],
    ['search domain', ['ip domain-list a.example', 'ip domain-list b.example', 'no ip domain-list a.example'], { system: { dns: { search: ['b.example'] } } }],
    ['name server', ['ip name-server 192.0.2.53 192.0.2.54', 'no ip name-server 192.0.2.53'], { system: { dns: { servers: { '192.0.2.54': {} } } } }],
    ['NTP server', ['ntp server 192.0.2.123', 'ntp server 192.0.2.124', 'no ntp server 192.0.2.123'], { system: { ntp: { servers: { '192.0.2.124': {} } } } }],
    ['syslog server', ['logging server 192.0.2.50 5', 'no logging server 192.0.2.50'], {}],
    ['SNMP community', ['snmp-server community PLACEHOLDER group network-operator', 'snmp-server contact noc', 'no snmp-server community PLACEHOLDER'], { system: { snmp: { contact: 'noc' } } }],
    ['SNMP contact and location', ['snmp-server contact noc', 'snmp-server location rack 4', 'no snmp-server contact', 'no snmp-server location rack 4'], {}],
    ['NTP source interface', ['ntp source-interface loopback0', 'no ntp source-interface loopback0'], {}],
    ['syslog source interface', ['logging source-interface loopback0', 'no logging source-interface'], {}],
    ['MTU', ['interface Ethernet1/1', '  mtu 9216', '  no mtu'], { interfaces: { 'Ethernet1/1': { type: 'ethernet' } } }],
    ['one IP address', ['interface Ethernet1/1', '  ip address 192.0.2.1/24', '  ip address 198.51.100.1/24 secondary', '  no ip address 198.51.100.1/24 secondary'], { interfaces: { 'Ethernet1/1': { type: 'ethernet', subinterfaces: { '0': { ipv4: { addresses: { '192.0.2.1': { prefixLength: 24 } } } } } } } }],
    ['VLAN tag, and with the last one the parent\'s tagging', ['interface Ethernet1/1.10', '  encapsulation dot1q 10', '  no encapsulation dot1q 10'], { interfaces: { 'Ethernet1/1': { type: 'ethernet', subinterfaces: { '10': {} } } } }],
    ['global route', ['ip route 10.0.0.0/8 192.0.2.1', 'ip route 10.0.0.0/8 192.0.2.2', 'no ip route 10.0.0.0/8 192.0.2.1'], { networkInstances: { default: { staticRoutes: { '10.0.0.0/8': { nextHops: { '0': { address: '192.0.2.2' } } } } } } }],
    ['route in a VRF', ['vrf context A', '  ip route 10.0.0.0/8 192.0.2.1', '  ipv6 route 2001:db8::/32 2001:db8::1', '  no ipv6 route 2001:db8::/32 2001:db8::1'], { networkInstances: { A: { type: 'vrf', staticRoutes: { '10.0.0.0/8': { nextHops: { '0': { address: '192.0.2.1' } } } } } } }],
    ['every next hop of a route', ['ip route 10.0.0.0/8 192.0.2.1', 'ip route 10.0.0.0/8 Null0', 'no ip route 10.0.0.0/8'], {}],
    ['VRF', ['vrf context A', '  ip route 10.0.0.0/8 192.0.2.1', 'vrf context B', 'no vrf context A'], { networkInstances: { B: { type: 'vrf' } } }],
    ['VRF membership', ['vrf context A', 'interface Ethernet1/1', '  no switchport', '  vrf member A', '  no vrf member A'], { networkInstances: { A: { type: 'vrf' } }, interfaces: { 'Ethernet1/1': { type: 'ethernet' } } }],
    ['route distinguisher', ['vrf context A', '  rd 65000:1', '  no rd 65000:1'], { networkInstances: { A: { type: 'vrf' } } }],
    ['one direction of a route target', ['vrf context A', '  address-family ipv4 unicast', '    route-target both 65000:1', '    route-target import 65000:2', '    no route-target export 65000:1'], { networkInstances: { A: { type: 'vrf', routeTargets: { import: ['65000:1', '65000:2'] } } } }]
  ]
  for (const [what, lines, model] of cases) {
    it(what, () => {
      const result = parse(lines.join('\n'))
      expect(result.model).toEqual(model)
      expect(buildLedger(result).complete).toBe(true)
      expect(roundTrips(lines.join('\n'))).toEqual([])
      // The `no` statement and what it removed are ignored-by-design, saying why.
      const last = lines.findLastIndex((l) => l.trim().startsWith('no '))
      expect(result.dispositions[`L${last + 1}`]).toMatchObject({ kind: 'ignored-by-design' })
    })
  }

  it('the statement a "no" removed says by which line', () => {
    const result = parse('ip name-server 192.0.2.53\nntp server 192.0.2.123\nno ip name-server 192.0.2.53\nno ntp server 192.0.2.123')
    expect(result.dispositions.L1).toEqual({ kind: 'ignored-by-design', reason: 'removed by line 3' })
    expect(result.dispositions.L2).toEqual({ kind: 'ignored-by-design', reason: 'removed by line 4' })
  })

  it('a name server statement keeps the servers a later "no" didn\'t remove', () => {
    const result = parse('ip name-server 192.0.2.53 192.0.2.54\nno ip name-server 192.0.2.53')
    expect(result.dispositions.L1).toEqual({ kind: 'mapped', fields: ['system.dns.servers["192.0.2.54"]'] })
  })

  it('"no feature" turns off the feature before it', () => {
    const result = parse('feature sftp-server\nno feature sftp-server')
    expect(result.dispositions.L1).toEqual({ kind: 'ignored-by-design', reason: 'turned off by line 2' })
    expect(result.dispositions.L2).toMatchObject({ kind: 'unsupported' })
  })
})

describe('addresses, VRF membership and DHCP', () => {
  const addresses = (result: ParseResult, name = 'Ethernet1/1') => result.model.interfaces?.[name]?.subinterfaces?.['0']?.ipv4?.addresses

  const vrfA = 'vrf context A'
  const sub0 = (result: ParseResult, name = 'Ethernet1/1') => result.model.interfaces?.[name]?.subinterfaces?.['0']

  it('"vrf member" puts the interface in the VRF, and clears the addresses before it, as on the device', () => {
    const text = [vrfA, 'interface Ethernet1/1', '  no switchport', '  ip address 192.0.2.1/24', '  vrf member A', '  ip address 192.0.2.9/24'].join('\n')
    const result = parse(text)
    expect(sub0(result)).toEqual({ networkInstance: 'A', ipv4: { addresses: { '192.0.2.9': { prefixLength: 24 } } } })
    expect(result.dispositions.L4).toEqual({ kind: 'ignored-by-design', reason: 'removed by line 5, which moves the interface to another VRF' })
    expect(result.dispositions.L5).toEqual({ kind: 'mapped', fields: ['interfaces["Ethernet1/1"].subinterfaces["0"].networkInstance'] })
    expect(roundTrips(text)).toEqual([])
    // Written before the addresses, which it would otherwise clear.
    expect(render(result.model).text).toContain('interface Ethernet1/1\n  no switchport\n  vrf member A\n  ip address 192.0.2.9/24\n')
  })

  it('a subinterface\'s "vrf member" goes on that subinterface', () => {
    const text = [vrfA, 'interface Ethernet1/1', '  no switchport', 'interface Ethernet1/1.10', '  encapsulation dot1q 10', '  vrf member A', '  ip address 192.0.2.1/24'].join('\n')
    const result = parse(text)
    expect(result.model.interfaces?.['Ethernet1/1'].subinterfaces).toEqual({ '10': { vlanId: 10, networkInstance: 'A', ipv4: { addresses: { '192.0.2.1': { prefixLength: 24 } } } } })
    expect(roundTrips(text)).toEqual([])
  })

  it('an interface in a VRF the text doesn\'t define is left out with its addresses, not put in the global table', () => {
    // (One in a VRF the text deletes: "a VRF deleted while interfaces are in it", below.)
    for (const lines of [['interface Ethernet1/1', '  no switchport', '  vrf member A', '  ip address 192.0.2.1/24', '  ipv6 address 2001:db8::1/64']]) {
      const result = parse(lines.join('\n'))
      const member = lines.indexOf('  vrf member A') + 1
      expect(result.model.interfaces, lines.join(' / ')).toEqual({ 'Ethernet1/1': { type: 'ethernet' } })
      expect(result.dispositions[`L${member}`]).toEqual({ kind: 'unsupported', reason: 'names a VRF the configuration doesn\'t define' })
      expect(result.dispositions[`L${member + 1}`]).toEqual({ kind: 'unsupported', reason: `an address in the VRF of line ${member}, which the configuration doesn't define` })
      expect(result.dispositions[`L${member + 2}`]).toMatchObject({ kind: 'unsupported' })
      expect(buildLedger(result).complete).toBe(true)
    }
  })

  it('the VRF may be defined after the interface that names it', () => {
    const result = parse(['interface loopback1', '  vrf member A', '  ip address 192.0.2.1/32', vrfA].join('\n'))
    expect(sub0(result, 'loopback1')).toEqual({ networkInstance: 'A', ipv4: { addresses: { '192.0.2.1': { prefixLength: 32 } } } })
  })

  it('"no ip address" in a VRF removes the addresses and keeps the membership', () => {
    const result = parse([vrfA, 'interface Ethernet1/1', '  vrf member A', '  ip address 192.0.2.1/24', '  ipv6 address 2001:db8::1/64', '  no ip address'].join('\n'))
    expect(sub0(result)).toEqual({ networkInstance: 'A', ipv6: { addresses: { '2001:db8::1': { prefixLength: 64 } } } })
    expect(result.dispositions.L4).toEqual({ kind: 'ignored-by-design', reason: 'removed by line 6' })
    expect(result.dispositions.L6).toEqual({ kind: 'ignored-by-design', reason: 'removes the addresses on line 4: nothing to convert' })
  })

  it('"no vrf member" returns the interface to the global table, clearing its addresses', () => {
    const result = parse([vrfA, 'interface Ethernet1/1', '  vrf member A', '  ip address 192.0.2.1/24', '  no vrf member', '  ip address 192.0.2.9/24'].join('\n'))
    expect(sub0(result)).toEqual({ ipv4: { addresses: { '192.0.2.9': { prefixLength: 24 } } } })
    expect(result.dispositions.L3).toEqual({ kind: 'ignored-by-design', reason: 'undone by line 5' })
    expect(result.dispositions.L4).toMatchObject({ kind: 'ignored-by-design' })
    expect(parse([vrfA, 'interface Ethernet1/1', '  vrf member A', '  no vrf member B'].join('\n')).dispositions.L4).toEqual({ kind: 'ignored-by-design', reason: 'not in that VRF: nothing to convert' })
  })

  it('"vrf member default" returns the interface to the global table as "no vrf member" does, with or without global routes', () => {
    for (const route of [[], ['ip route 10.0.0.0/8 192.0.2.254']]) {
      for (const [name, head] of [['Ethernet1/1', ['interface Ethernet1/1']], ['Ethernet1/1.10', ['interface Ethernet1/1', '  no switchport', 'interface Ethernet1/1.10', '  encapsulation dot1q 10']]] as const) {
        const lines = [...route, vrfA, ...head, '  vrf member A', '  ip address 192.0.2.1/24', '  vrf member default', '  ip address 192.0.2.2/24']
        const result = parse(lines.join('\n'))
        const sub = result.model.interfaces?.['Ethernet1/1'].subinterfaces?.[name === 'Ethernet1/1' ? '0' : '10']
        expect(sub, lines.join(' / ')).toMatchObject({ ipv4: { addresses: { '192.0.2.2': { prefixLength: 24 } } } })
        expect(sub?.networkInstance).toBeUndefined()
        expect(Object.keys(sub?.ipv4?.addresses ?? {})).toEqual(['192.0.2.2'])
        const at = (text: string) => `L${lines.indexOf(text) + 1}`
        expect(result.dispositions[at('  vrf member A')]).toEqual({ kind: 'ignored-by-design', reason: `undone by line ${lines.indexOf('  vrf member default') + 1}` })
        expect(result.dispositions[at('  vrf member default')]).toMatchObject({ kind: 'ignored-by-design' })
        expect(result.dispositions[at('  ip address 192.0.2.1/24')]).toMatchObject({ kind: 'ignored-by-design' })
        expect(roundTrips(lines.join('\n'))).toEqual([])
      }
    }
    expect(parse('interface Ethernet1/1\n  vrf member default').dispositions.L2).toEqual({ kind: 'ignored-by-design', reason: 'already in the default VRF: nothing to convert' })
  })

  it('mgmt0 is always in the management VRF, which is built in: in the model whether the text says so or not', () => {
    for (const lines of [['interface mgmt0', '  vrf member management', '  ip address 192.0.2.10/24'], ['interface mgmt0', '  ip address 192.0.2.10/24']]) {
      const text = lines.join('\n')
      const result = parse(text)
      expect(result.model).toEqual({ networkInstances: { management: { type: 'vrf' } }, interfaces: { mgmt0: { type: 'management', subinterfaces: { '0': { networkInstance: 'management', ipv4: { addresses: { '192.0.2.10': { prefixLength: 24 } } } } } } } })
      expect(result.dispositions.L1).toEqual({ kind: 'mapped', fields: ['interfaces.mgmt0.type', 'interfaces.mgmt0.subinterfaces["0"].networkInstance', 'networkInstances.management.type'] })
      expect(render(result.model).text).toContain('interface mgmt0\n  vrf member management\n  ip address 192.0.2.10/24\n')
      expect(roundTrips(text)).toEqual([])
    }
    expect(parse('interface mgmt0\n  vrf member management').dispositions.L2).toEqual({ kind: 'ignored-by-design', reason: 'mgmt0 is always in the management VRF: its interface statement says so' })
    // The text's own `vrf context management` defines it.
    expect(parse('vrf context management\ninterface mgmt0').dispositions.L2).toEqual({ kind: 'mapped', fields: ['interfaces.mgmt0.type', 'interfaces.mgmt0.subinterfaces["0"].networkInstance'] })
    expect(parse('interface mgmt0\n  vrf member other').dispositions.L2).toEqual({ kind: 'unsupported', reason: 'mgmt0 is always in the management VRF' })
    expect(parse('interface mgmt0\n  no vrf member').dispositions.L2).toEqual({ kind: 'unsupported', reason: 'mgmt0 is always in the management VRF' })
    expect(parse('interface Ethernet1/1\n  vrf member management').dispositions.L2).toEqual({ kind: 'unsupported', reason: 'only mgmt0 is in the management VRF' })
    expect(parse('vrf context management\nno vrf context management').dispositions.L2).toEqual({ kind: 'unsupported', reason: 'the management VRF is built in: NX-OS can\'t remove it' })
  })

  it('a render leaves out a membership NX-OS can\'t say, with the addresses that would land in another table', () => {
    const ipv4 = { ipv4: { addresses: { '192.0.2.1': { prefixLength: 24 } } } }
    const result = render({
      networkInstances: { A: { type: 'vrf' }, management: { type: 'vrf' } },
      interfaces: {
        'Ethernet1/1': { subinterfaces: { '0': { networkInstance: 'B', ...ipv4 } } },
        'Ethernet1/2': { subinterfaces: { '0': { networkInstance: 'management', ...ipv4 } } },
        mgmt0: { subinterfaces: { '0': { networkInstance: 'A', ...ipv4 } } },
        MGMT0: { subinterfaces: { '0': { networkInstance: 'default', ...ipv4 } } },
        'Ethernet1/3': { subinterfaces: { '0': { networkInstance: 'default', ...ipv4 } } }
      }
    })
    const at = (name: string, ...leaf: string[]) => result.dispositions[fieldPath('interfaces', name, 'subinterfaces', '0', ...leaf)]
    expect(at('Ethernet1/1', 'networkInstance')).toEqual({ kind: 'unsupported', reason: 'a VRF the model doesn\'t have' })
    expect(at('Ethernet1/2', 'networkInstance')).toEqual({ kind: 'unsupported', reason: 'only mgmt0 is in the management VRF' })
    expect(at('mgmt0', 'networkInstance')).toEqual({ kind: 'unsupported', reason: 'mgmt0 is always in the management VRF' })
    expect(at('MGMT0', 'networkInstance')).toEqual({ kind: 'unsupported', reason: 'mgmt0 is always in the management VRF' })
    for (const name of ['Ethernet1/1', 'Ethernet1/2', 'mgmt0', 'MGMT0']) expect(at(name, 'ipv4', 'addresses', '192.0.2.1', 'prefixLength')).toMatchObject({ kind: 'unsupported' })
    expect(at('Ethernet1/3', 'networkInstance')).toMatchObject({ kind: 'not-applicable' })
    expect(at('Ethernet1/3', 'ipv4', 'addresses', '192.0.2.1', 'prefixLength')).toMatchObject({ kind: 'rendered' })
    expect(result.text).not.toContain('vrf member B')
    expect(result.text.match(/192\.0\.2\.1\//g)).toHaveLength(1)
  })

  it('"ip address dhcp" replaces the static addresses before it, and a later address replaces it', () => {
    const before = parse(['interface Ethernet1/1', '  ip address 192.0.2.1/24', '  ip address 198.51.100.1/24 secondary', '  ip address dhcp'].join('\n'))
    expect(addresses(before)).toBeUndefined()
    expect(before.dispositions.L4).toEqual({ kind: 'unsupported', reason: 'an address from DHCP, replacing the addresses on lines 2, 3' })
    const after = parse(['interface Ethernet1/1', '  ip address dhcp', '  ip address 192.0.2.1/24'].join('\n'))
    expect(addresses(after)).toEqual({ '192.0.2.1': { prefixLength: 24 } })
    expect(after.dispositions.L2).toEqual({ kind: 'ignored-by-design', reason: 'replaced by line 3' })
  })

  it('a secondary address with no primary is unsupported, not turned into a primary', () => {
    const result = parse(['interface Ethernet1/1', '  ip address 192.0.2.1/24 secondary', '  ipv6 address 2001:db8::1/64 secondary'].join('\n'))
    expect(result.model.interfaces).toEqual({ 'Ethernet1/1': { type: 'ethernet' } })
    expect(result.dispositions.L2).toMatchObject({ kind: 'unsupported' })
    expect(result.dispositions.L3).toMatchObject({ kind: 'unsupported' })
  })

  it('IPv6 has one primary too, with secondaries beside it', () => {
    const result = parse(['interface Ethernet1/1', '  ipv6 address 2001:db8::1/64', '  ipv6 address 2001:db8:1::1/64 secondary'].join('\n'))
    expect(result.model.interfaces?.['Ethernet1/1'].subinterfaces?.['0'].ipv6?.addresses).toEqual({ '2001:db8::1': { prefixLength: 64, primary: true }, '2001:db8:1::1': { prefixLength: 64 } })
    expect(render(result.model).text).toContain('  ipv6 address 2001:db8::1/64\n  ipv6 address 2001:db8:1::1/64 secondary\n')
  })

  it('an interface range or list is unsupported, not taken as an interface name', () => {
    for (const header of ['interface Ethernet1/1-4', 'interface Ethernet1/1, Ethernet1/3']) {
      const result = parse(`${header}\n  description d`)
      expect(result.model, header).toEqual({})
      expect(result.dispositions.L1).toEqual({ kind: 'unsupported' })
    }
  })
})

describe('a VRF deleted while interfaces are in it (#47)', () => {
  // NX-OS's guides say `no vrf context` deletes "the VRF and all associated configuration", but not what its interfaces
  // keep (#47). Their membership and addresses up to the deletion are left out, even if the VRF comes back; a later
  // `vrf member` or `no vrf member` says it again, and what follows maps normally. Decided on #47 (option 2).
  const why = (n: number) => ({ kind: 'unsupported', reason: `in a VRF line ${n} deletes: what the device keeps of it isn't certain` })
  const members = ['vrf context A', 'vrf context B', 'interface Ethernet1/1', '  no switchport', '  vrf member A', '  ip address 192.0.2.1/24', '  ipv6 address 2001:db8::1/64', 'interface Ethernet1/2', '  no switchport', '  vrf member B', '  ip address 198.51.100.1/24']
  const inB = { networkInstance: 'B', ipv4: { addresses: { '198.51.100.1': { prefixLength: 24 } } } }

  it('deleted and recreated: the membership and its IPv4 and IPv6 addresses are left out; another VRF\'s interface is untouched', () => {
    const result = parse([...members, 'no vrf context A', 'vrf context A'].join('\n'))
    expect(result.model.interfaces?.['Ethernet1/1']).toEqual({ type: 'ethernet' })
    expect(result.model.interfaces?.['Ethernet1/2'].subinterfaces?.['0']).toEqual(inB)
    expect(result.model.networkInstances).toEqual({ A: { type: 'vrf' }, B: { type: 'vrf' } })
    for (const l of ['L5', 'L6', 'L7']) expect(result.dispositions[l], l).toEqual(why(12))
    expect(result.dispositions.L10).toMatchObject({ kind: 'mapped' })
    expect(buildLedger(result).complete).toBe(true)
  })

  it('deleted only: the same, and nothing goes to the global table', () => {
    const result = parse([...members, 'no vrf context A'].join('\n'))
    expect(result.model.interfaces?.['Ethernet1/1']).toEqual({ type: 'ethernet' })
    expect(result.model.networkInstances).toEqual({ B: { type: 'vrf' } })
    for (const l of ['L5', 'L6', 'L7']) expect(result.dispositions[l], l).toEqual(why(12))
    expect(roundTrips([...members, 'no vrf context A'].join('\n'))).toEqual([])
  })

  it('an address given after the deletion, with no new membership, is left out too: it may be in the deleted VRF', () => {
    const result = parse([...members, 'no vrf context A', 'vrf context A', 'interface Ethernet1/1', '  ip address 192.0.2.9/24'].join('\n'))
    expect(result.model.interfaces?.['Ethernet1/1']).toEqual({ type: 'ethernet' })
    expect(result.dispositions.L15).toEqual(why(12))
  })

  it('recreated, then a new membership: it and the addresses after it map, IPv4 and IPv6', () => {
    const text = [...members, 'no vrf context A', 'vrf context A', 'interface Ethernet1/1', '  vrf member A', '  ip address 192.0.2.9/24', '  ipv6 address 2001:db8::9/64'].join('\n')
    const result = parse(text)
    expect(result.model.interfaces?.['Ethernet1/1'].subinterfaces?.['0']).toEqual({ networkInstance: 'A', ipv4: { addresses: { '192.0.2.9': { prefixLength: 24 } } }, ipv6: { addresses: { '2001:db8::9': { prefixLength: 64 } } } })
    expect(result.dispositions.L15).toEqual({ kind: 'mapped', fields: ['interfaces["Ethernet1/1"].subinterfaces["0"].networkInstance'] })
    for (const l of ['L5', 'L6', 'L7']) expect(result.dispositions[l], l).toEqual(why(12))
    expect(result.model.interfaces?.['Ethernet1/2'].subinterfaces?.['0']).toEqual(inB)
    expect(roundTrips(text)).toEqual([])
  })

  it('"no vrf member" after the deletion says the interface is in the global table: addresses after it map there', () => {
    const result = parse([...members, 'no vrf context A', 'interface Ethernet1/1', '  no vrf member', '  ip address 192.0.2.9/24'].join('\n'))
    expect(result.model.interfaces?.['Ethernet1/1'].subinterfaces?.['0']).toEqual({ ipv4: { addresses: { '192.0.2.9': { prefixLength: 24 } } } })
    expect(result.dispositions.L14).toMatchObject({ kind: 'ignored-by-design' })
  })

  it('names no VRF in its reasons: a VRF can share its name with a secret', () => {
    const text = ['snmp-server community CANARY_SECRET group network-operator', 'vrf context CANARY_SECRET', 'interface Ethernet1/1', '  no switchport', '  vrf member CANARY_SECRET', '  ip address 192.0.2.1/24', 'no vrf context CANARY_SECRET', 'vrf context CANARY_SECRET', 'interface Ethernet1/1', '  ip address 192.0.2.9/24'].join('\n')
    expect(checkSecrets(plugin, text, ['CANARY_SECRET'], { allowances: [] }).leaks).toEqual([])
  })

  it('a numeric community reused as a route map sequence, an access list entry or a term\'s key never reaches a message either', () => {
    const secret = '48213'
    const next = String(Number(secret) + 1)
    const community = `snmp-server community ${secret} group network-operator`
    const cases: [string[], RegExp][] = [
      // Removing the sequence, a sequence left out whole and the route map with it, and an access list entry.
      [[community, `route-map M permit ${secret}`, '  set tag 1', `no route-map M permit ${secret}`], /^removes the route map sequence configured on lines 2, 3:/],
      [[community, `route-map M permit ${secret}`, '  match interface Ethernet1/1', `route-map M permit ${next}`], /^left out whole: the sequence of line 2 isn't converted/],
      [[community, `route-map M permit ${secret}`, '  match interface Ethernet1/1', `route-map M permit ${next}`], /^part of the route map sequence of line 2/],
      [[community, 'ip access-list F', `  ${secret} permit ip 10.0.0.0 0.255.0.255 any`, `  ${next} deny ip any any`], /^left out whole: the entry on line 3 isn't converted/]
    ]
    for (const [lines, reason] of cases) {
      const text = lines.join('\n')
      // The case reaches the reason it is about, and no message carries the number.
      expect(Object.values(parse(text).dispositions).some((d) => 'reason' in d && reason.test(d.reason ?? '')), text).toBe(true)
      expect(checkSecrets(plugin, text, [secret], { allowances: [] }).leaks, text).toEqual([])
    }
    // A render from another platform, with the number as a term's key.
    const filter = { matches: { routeFilters: { '1': { prefix: '10.0.0.0/8', minLength: 8, maxLength: 32 } } } }
    const rendered = render({
      routingPolicy: { policies: { P: { fallThrough: 'reject', terms: { [secret]: { ...filter, actions: { flow: 'reject' } }, [next]: { actions: { flow: 'accept' } } } } } },
      filters: { ipv4: { F: { implicitAction: 'deny', terms: { [secret]: { matches: { prefixes: ['10.0.0.0/8'] }, description: 'x'.repeat(300), actions: { action: 'discard' } }, [next]: { actions: { action: 'accept' } } } } } }
    })
    const reasons = Object.values(rendered.dispositions).flatMap((d) => ('reason' in d && d.reason !== undefined ? [d.reason] : []))
    expect(reasons.some((r) => r.startsWith('left out whole: one of its terms can\'t be written'))).toBe(true)
    for (const r of reasons) expect(r).not.toContain(secret)
    expect(rendered.diagnostics.map((d) => d.message).join(' ')).not.toContain(secret)
  })
})

describe('VRF route distinguishers and route targets', () => {
  const vrf = (text: string) => parse(text).model.networkInstances?.A

  it('a route distinguisher in any of the three forms maps; a later one supersedes it, and "rd auto" leaves it out', () => {
    for (const rd of ['65000:100', '192.0.2.1:100', '4200000000:100']) expect(vrf(`vrf context A\n  rd ${rd}`)).toEqual({ type: 'vrf', routeDistinguisher: rd })
    const result = parse('vrf context A\n  rd 65000:1\n  rd auto')
    expect(result.model.networkInstances?.A).toEqual({ type: 'vrf' })
    expect(result.dispositions.L2).toEqual({ kind: 'ignored-by-design', reason: 'superseded by line 3' })
    expect(result.dispositions.L3).toEqual({ kind: 'unsupported', reason: 'an automatic route distinguisher, which depends on the device\'s BGP router id' })
    for (const bad of ['65536:4294967296', '192.0.2.1:65536', 'x:1']) expect(parse(`vrf context A\n  rd ${bad}`).dispositions.L2, bad).toMatchObject({ kind: 'unsupported' })
    // The global table has none.
    expect(parse('vrf context default\n  rd 65000:1').dispositions.L2).toMatchObject({ kind: 'unsupported' })
  })

  it('route targets map when every address family agrees, and render under both', () => {
    const text = ['vrf context A', '  address-family ipv4 unicast', '    route-target both 65000:1', '    route-target import 65000:2', '  address-family ipv6 unicast', '    route-target import 65000:1', '    route-target export 65000:1', '    route-target import 65000:2'].join('\n')
    const result = parse(text)
    expect(result.model.networkInstances?.A).toEqual({ type: 'vrf', routeTargets: { import: ['65000:1', '65000:2'], export: ['65000:1'] } })
    expect(result.dispositions.L3).toEqual({ kind: 'mapped', fields: ['networkInstances.A.routeTargets.import', 'networkInstances.A.routeTargets.export'] })
    expect(result.dispositions.L2).toMatchObject({ kind: 'ignored-by-design' })
    expect(roundTrips(text)).toEqual([])
    expect(render(result.model).text).toBe(['feature bgp', '', 'vrf context A', '  address-family ipv4 unicast', '    route-target import 65000:1', '    route-target import 65000:2', '    route-target export 65000:1', '  address-family ipv6 unicast', '    route-target import 65000:1', '    route-target import 65000:2', '    route-target export 65000:1', ''].join('\n'))
    // One address family alone is the VRF's.
    expect(vrf('vrf context A\n  address-family ipv4 unicast\n    route-target export 65000:1')).toEqual({ type: 'vrf', routeTargets: { export: ['65000:1'] } })
  })

  it('route targets that differ between address families, or with one not converted, are all left out', () => {
    const differ = parse(['vrf context A', '  address-family ipv4 unicast', '    route-target both 65000:1', '  address-family ipv6 unicast', '    route-target import 65000:1'].join('\n'))
    expect(differ.model.networkInstances?.A).toEqual({ type: 'vrf' })
    expect(differ.dispositions.L3).toEqual({ kind: 'unsupported', reason: 'route targets that differ between IPv4 and IPv6: the model holds one set for the VRF' })
    expect(differ.dispositions.L5).toEqual(differ.dispositions.L3)
    // The same set in another order, or with a value again, agrees: the model keeps the first family's order.
    for (const v6 of [['    route-target import 65000:2', '    route-target import 65000:1'], ['    route-target import 65000:2', '    route-target import 65000:1', '    route-target import 65000:2']]) {
      const text = ['vrf context A', '  address-family ipv4 unicast', '    route-target import 65000:1', '    route-target import 65000:2', '  address-family ipv6 unicast', ...v6].join('\n')
      const result = parse(text)
      expect(result.model.networkInstances?.A, text).toEqual({ type: 'vrf', routeTargets: { import: ['65000:1', '65000:2'] } })
      expect(Object.values(result.dispositions).filter((d) => d.kind === 'unsupported')).toEqual([])
      expect(roundTrips(text)).toEqual([])
    }
    // A different set doesn't, nor does the same value in another direction.
    expect(vrf('vrf context A\n  address-family ipv4 unicast\n    route-target import 65000:1\n    route-target import 65000:2\n  address-family ipv6 unicast\n    route-target import 65000:1\n    route-target import 65000:3')).toEqual({ type: 'vrf' })
    expect(vrf('vrf context A\n  address-family ipv4 unicast\n    route-target import 65000:1\n  address-family ipv6 unicast\n    route-target export 65000:1')).toEqual({ type: 'vrf' })
    // An address family with none disagrees with one with some.
    expect(vrf('vrf context A\n  address-family ipv4 unicast\n    route-target both 65000:1\n  address-family ipv6 unicast')).toEqual({ type: 'vrf' })
    const auto = parse(['vrf context A', '  address-family ipv4 unicast', '    route-target import 65000:1', '    route-target both auto'].join('\n'))
    expect(auto.model.networkInstances?.A).toEqual({ type: 'vrf' })
    expect(auto.dispositions.L3).toEqual({ kind: 'unsupported', reason: 'left out whole: line 4 about the VRF\'s route targets isn\'t converted' })
    expect(auto.dispositions.L4).toEqual({ kind: 'unsupported', reason: 'an automatic route target, which depends on the device\'s BGP AS' })
    // EVPN's are another address family's: unsupported without taking the others with them.
    const evpn = parse(['vrf context A', '  address-family ipv4 unicast', '    route-target import 65000:1', '    route-target both 65000:9 evpn'].join('\n'))
    expect(evpn.model.networkInstances?.A).toEqual({ type: 'vrf', routeTargets: { import: ['65000:1'] } })
    expect(evpn.dispositions.L4).toEqual({ kind: 'unsupported', reason: 'a route target for EVPN, which comes later' })
    // Another address family is unsupported, with what is inside it.
    const l2vpn = parse('vrf context A\n  address-family l2vpn evpn\n    route-target both auto')
    expect([l2vpn.dispositions.L2, l2vpn.dispositions.L3]).toMatchObject([{ kind: 'unsupported' }, { kind: 'unsupported' }])
  })

  it('"no vrf context" removes the route distinguisher and targets with the VRF', () => {
    const result = parse(['vrf context A', '  rd 65000:1', '  address-family ipv4 unicast', '    route-target both 65000:1', '  vni 5000', 'no vrf context A', 'vrf context A'].join('\n'))
    expect(result.model.networkInstances).toEqual({ A: { type: 'vrf' } })
    for (const l of ['L1', 'L2', 'L3', 'L4', 'L5']) expect(result.dispositions[l], l).toEqual({ kind: 'ignored-by-design', reason: 'removed by line 6' })
  })

  it('a render writes a VRF\'s route distinguisher, and says what it can\'t write', () => {
    const result = render({ networkInstances: { default: { routeDistinguisher: '65000:1', routeTargets: { import: ['65000:1'] } }, A: { type: 'vrf', routeDistinguisher: 'bad', routeTargets: { import: ['bad'], export: [] } } } })
    expect(result.dispositions['networkInstances.default.routeDistinguisher']).toEqual({ kind: 'unsupported', reason: 'the global routing table has no route distinguisher' })
    expect(result.dispositions['networkInstances.default.routeTargets.import']).toEqual({ kind: 'unsupported', reason: 'the global routing table has no route targets' })
    expect(result.dispositions['networkInstances.A.routeDistinguisher']).toMatchObject({ kind: 'unsupported' })
    expect(result.dispositions['networkInstances.A.routeTargets.import']).toMatchObject({ kind: 'unsupported' })
    expect(result.dispositions['networkInstances.A.routeTargets.export']).toMatchObject({ kind: 'not-applicable' })
    expect(result.text).toBe('vrf context A\n')
  })
})

describe('route next hops', () => {
  it('a malformed address or a stray word isn\'t taken as an interface: the route is unsupported', () => {
    for (const text of ['ipv6 route 2001:db8::/32 dead::beef::bad', 'ip route 10.0.0.0/8 dead::beef::bad', 'ip route 10.0.0.0/8 192.0.2.1 frobnicate', 'ip route 10.0.0.0/8 not-an-interface']) {
      const result = parse(text)
      expect(result.model, text).toEqual({})
      expect(result.dispositions.L1, text).toMatchObject({ kind: 'unsupported' })
    }
  })
})

describe('SNMP communities', () => {
  const communities = (text: string) => parse(text).model.system?.snmp?.communities

  it('one limited by IPv4 and IPv6 access lists on one line is left out whole, whichever comes first', () => {
    for (const lines of [
      ['snmp-server community PLACEHOLDER group network-operator', 'snmp-server community PLACEHOLDER use-ipv4acl ACL use-ipv6acl ACL6'],
      ['snmp-server community PLACEHOLDER use-ipv4acl ACL use-ipv6acl ACL6', 'snmp-server community PLACEHOLDER group network-operator'],
      ['snmp-server community PLACEHOLDER group network-operator', 'snmp-server community PLACEHOLDER use-ipv6acl ACL6 use-ipv4acl ACL']
    ]) {
      const result = parse(lines.join('\n'))
      expect(result.model, lines.join(' / ')).toEqual({})
      expect(Object.values(result.dispositions).map((d) => d.kind)).toEqual(['unsupported', 'unsupported'])
      expect(render(result.model).text).not.toContain('community')
    }
  })

  it('one with any statement not converted (another group, part of it removed) is left out whole', () => {
    expect(communities('snmp-server community PLACEHOLDER group network-operator\nsnmp-server community PLACEHOLDER group custom')).toBeUndefined()
    expect(communities('snmp-server community PLACEHOLDER group network-operator\nno snmp-server community PLACEHOLDER use-ipv4acl ACL')).toBeUndefined()
    const result = parse('snmp-server community PLACEHOLDER group network-operator\nsnmp-server community PLACEHOLDER group custom\nsnmp-server community OTHER-PLACEHOLDER')
    expect(result.dispositions.L1).toEqual({ kind: 'unsupported', reason: 'left out whole: line 2 about the same community isn\'t converted, and may limit or change it' })
    expect(result.model.system?.snmp?.communities).toEqual({ 'OTHER-PLACEHOLDER': {} })
  })
})

describe('no secret where it is repeated', () => {
  it('a community value reused as a VRF, an option and a name is in no message', () => {
    const text = [
      'snmp-server community CANARY_SECRET group network-operator',
      'interface Ethernet1/1',
      '  ip address 192.0.2.1/24',
      '  vrf member CANARY_SECRET',
      '  ip address 192.0.2.2/24',
      '  no vrf member CANARY_SECRET',
      '  no vrf member CANARY_SECRET',
      '  vrf member CANARY_SECRET',
      '  vrf member CANARY_SECRET',
      'ip route 10.0.0.0/8 192.0.2.1 CANARY_SECRET',
      'ip route 10.0.0.0/8 192.0.2.9 name CANARY_SECRET',
      'ip route 10.0.0.0/8 192.0.2.8 name other',
      'ip name-server 192.0.2.53 CANARY_SECRET',
      'ip name-server 192.0.2.54 use-vrf CANARY_SECRET',
      'ip name-server 192.0.2.54',
      'ntp server 192.0.2.123 CANARY_SECRET',
      'logging server 192.0.2.50 CANARY_SECRET',
      'feature CANARY_SECRET',
      'vrf context CANARY_SECRET',
      '  CANARY_SECRET'
    ].join('\n')
    expect(findSecrets(text)).toEqual(['CANARY_SECRET'])
    const { leaks } = checkSecrets(plugin, text, ['CANARY_SECRET'], { allowances: [] })
    expect(leaks.map((l) => `${l.site}: ${l.text}`)).toEqual([])
    // And through the kit's own five checks.
    expect(roundTrips(text)).toEqual([])
  })
})

/**
 * The `feature` lines a text needs, by its own reading of NX-OS rather than the plugin's table: which statements a
 * feature has to be on for, and whether a `feature` line comes before the first of them.
 */
const NEEDS: readonly (readonly [RegExp, string])[] = [
  [/^interface vlan\d/i, 'interface-vlan'],
  [/^interface tunnel\d/i, 'tunnel'],
  // A VRF's route distinguisher and route targets are BGP's (L3VPN).
  [/^\s+(rd|route-target) /, 'bgp'],
  [/^router bgp /, 'bgp'],
  [/^router ospf /, 'ospf'],
  [/^\s+ip (router )?ospf /, 'ospf'],
  // LACP: a member bundling with it, and a port-channel's minimum links (`mode on`, or no mode, needs nothing).
  [/^\s+channel-group \d+ (force )?mode (active|passive)$/, 'lacp'],
  [/^\s+lacp /, 'lacp']
]
function missingFeatures(text: string): string[] {
  const lines = text.split('\n')
  const missing = new Set<string>()
  for (const [statement, feature] of NEEDS) {
    const first = lines.findIndex((l) => statement.test(l))
    if (first >= 0 && !lines.slice(0, first).includes(`feature ${feature}`)) missing.add(feature)
  }
  return [...missing]
}

describe('feature lines', () => {
  it('the check catches a render without the feature it needs', () => {
    expect(missingFeatures('interface Vlan10\n  no shutdown\n')).toEqual(['interface-vlan'])
    expect(missingFeatures('interface Vlan10\nfeature interface-vlan\n')).toEqual(['interface-vlan'])
    expect(missingFeatures('feature tunnel\ninterface Tunnel1\n')).toEqual([])
    expect(missingFeatures('vrf context A\n  rd 65000:1\n')).toEqual(['bgp'])
    expect(missingFeatures('vrf context A\n  address-family ipv4 unicast\n    route-target import 65000:1\n')).toEqual(['bgp'])
    expect(missingFeatures('router bgp 65000\n  neighbor 192.0.2.2 remote-as 65001\n')).toEqual(['bgp'])
    expect(missingFeatures('interface loopback0\n  ip router ospf 1 area 0.0.0.0\nrouter ospf 1\n')).toEqual(['ospf'])
    expect(missingFeatures('interface Ethernet1/1\n  ip ospf cost 5\n')).toEqual(['ospf'])
    expect(missingFeatures('interface Ethernet1/1\n  channel-group 1 mode active\n')).toEqual(['lacp'])
    expect(missingFeatures('interface port-channel1\n  lacp min-links 2\n')).toEqual(['lacp'])
    expect(missingFeatures('interface Ethernet1/1\n  channel-group 1 mode on\ninterface Ethernet1/2\n  channel-group 2\n')).toEqual([])
    expect(missingFeatures('feature lacp\ninterface Ethernet1/1\n  channel-group 1 mode passive\n')).toEqual([])
    expect(missingFeatures('feature bgp\nfeature ospf\nrouter ospf 1\nrouter bgp 65000\n')).toEqual([])
  })

  it('a render writes every feature its statements need, before them, from any model', () => {
    const model: Device = { interfaces: { 'Ethernet1/1': {}, Vlan10: { description: 'svi' }, Tunnel5: {}, vlan20: { type: 'vlan' } } }
    const text = render(model).text
    expect(missingFeatures(text)).toEqual([])
    expect(text.split('\n').filter((l) => l.startsWith('feature '))).toEqual(['feature interface-vlan', 'feature tunnel'])
    expect(missingFeatures(render({ interfaces: { 'Ethernet1/1': {} } }).text)).toEqual([])
    expect(render({ interfaces: { 'Ethernet1/1': {} } }).text).not.toContain('feature')
  })

  it('a VRF\'s route distinguisher or route targets bring feature bgp; a VRF with neither, or only what isn\'t written, doesn\'t', () => {
    for (const instance of [{ routeDistinguisher: '65000:1' }, { routeTargets: { import: ['65000:1'] } }, { routeTargets: { export: ['65000:1'] } }]) {
      const text = render({ networkInstances: { A: { type: 'vrf', ...instance } } }).text
      expect(text.startsWith('feature bgp\n\nvrf context A\n'), text).toBe(true)
      expect(missingFeatures(text)).toEqual([])
      // Without it, the guard fails the render.
      expect(missingFeatures(text.replace('feature bgp\n', ''))).toEqual(['bgp'])
    }
    const without: Device[] = [{ networkInstances: { A: { type: 'vrf' } } }, { networkInstances: { A: { routeDistinguisher: 'bad', routeTargets: { import: [] } } } }, { networkInstances: { default: { routeDistinguisher: '65000:1' } } }]
    for (const model of without)
      expect(render(model).text).not.toContain('feature')
  })

  it('every render of the fixtures and the corpus has the features it needs', () => {
    const sources = [...fixtureSources, ...every(join(root, 'nxos'))]
    expect(sources.length).toBeGreaterThan(80)
    let needing = 0
    for (const file of sources) {
      const text = render(parse(readFileSync(file, 'utf8')).model).text
      if (NEEDS.some(([statement]) => text.split('\n').some((l) => statement.test(l)))) needing++
      expect(missingFeatures(text), file).toEqual([])
    }
    // The check had something to check.
    expect(needing).toBeGreaterThan(3)
  })

  it('on parse, a feature a converted statement needs is ignored-by-design; any other is unsupported', () => {
    const result = parse('feature interface-vlan\nfeature tunnel\nfeature bgp\nfeature nv overlay')
    expect(result.dispositions.L1).toEqual({ kind: 'ignored-by-design', reason: 'needed by Vlan interfaces: written whenever one is' })
    expect(result.dispositions.L2).toEqual({ kind: 'ignored-by-design', reason: 'needed by Tunnel interfaces: written whenever one is' })
    expect(result.dispositions.L3).toEqual({ kind: 'unsupported', reason: 'turns on a feature whose configuration isn\'t converted yet' })
    expect(result.dispositions.L4).toEqual({ kind: 'unsupported', reason: 'turns on a feature whose configuration isn\'t converted yet' })
  })

  it('on parse, feature bgp is needed when BGP or a VRF\'s route distinguisher or targets are converted', () => {
    const vpn = ['feature bgp', 'vrf context A', '  rd 65000:1', '  address-family ipv4 unicast', '    route-target both 65000:1']
    const result = parse(vpn.join('\n'))
    expect(result.dispositions.L1).toEqual({ kind: 'ignored-by-design', reason: 'needed by VRF route distinguishers and targets: written whenever one is' })
    expect(render(result.model).text.split('\n')[0]).toBe('feature bgp')
    const bgp = parse([...vpn, 'router bgp 65000', '  router-id 192.0.2.1'].join('\n'))
    expect(bgp.dispositions.L1).toEqual({ kind: 'ignored-by-design', reason: 'needed by BGP: written whenever BGP is' })
    expect([bgp.dispositions.L6, bgp.dispositions.L7]).toMatchObject([{ kind: 'mapped' }, { kind: 'mapped' }])
    expect(parse('feature bgp\nrouter bgp 65000').dispositions.L1).toEqual({ kind: 'ignored-by-design', reason: 'needed by BGP: written whenever BGP is' })
    // With only an `rd auto`, or BGP that isn't converted, nothing needs it.
    expect(parse('feature bgp\nvrf context A\n  rd auto').dispositions.L1).toMatchObject({ kind: 'unsupported' })
    expect(parse('feature bgp\nrouter bgp 4294967296').dispositions.L1).toMatchObject({ kind: 'unsupported' })
  })

  it('"no feature bgp" leaves out the route distinguishers and targets before it', () => {
    const result = parse(['feature bgp', 'vrf context A', '  rd 65000:1', '  address-family ipv4 unicast', '    route-target both 65000:1', '    route-target both auto', 'no feature bgp', 'vrf context B', '  rd 65000:2'].join('\n'))
    expect(result.model.networkInstances).toEqual({ A: { type: 'vrf' }, B: { type: 'vrf', routeDistinguisher: '65000:2' } })
    for (const l of ['L3', 'L5', 'L6']) expect(result.dispositions[l], l).toEqual({ kind: 'unsupported', reason: 'BGP\'s, which line 7 turns off: left out' })
    expect(result.dispositions.L1).toEqual({ kind: 'ignored-by-design', reason: 'turned off by line 7' })
    expect(result.dispositions.L9).toMatchObject({ kind: 'mapped' })
  })
})

describe('switchport', () => {
  /** Each Ethernet or port-channel interface's switchport lines in a render. */
  const modes = (text: string) => {
    const out: Record<string, string[]> = {}
    let current: string | undefined
    for (const line of text.split('\n')) {
      const m = /^interface (\S+)$/.exec(line)
      if (m) current = /^(?:ethernet|port-channel)\d[\d/]*$/i.test(m[1]) ? m[1] : undefined
      else if (current && /^ {2}(?:no )?switchport$/.test(line)) (out[current] ??= []).push(line.trim())
      if (m && current) out[current] = []
    }
    return out
  }

  it('is written explicitly on every Ethernet and port-channel interface: no switchport with IP configuration', () => {
    const model: Device = {
      interfaces: {
        'Ethernet1/1': { subinterfaces: { '0': { ipv4: { addresses: { '192.0.2.1': { prefixLength: 24 } } } } } },
        'Ethernet1/2': { description: 'plain' },
        'Ethernet1/3': { subinterfaces: { '10': { vlanId: 10 } } },
        'port-channel1': { subinterfaces: { '0': { ipv6: { addresses: { '2001:db8::1': { prefixLength: 64 } } } } } },
        'port-channel2': {},
        loopback0: { subinterfaces: { '0': { ipv4: { addresses: { '192.0.2.255': { prefixLength: 32 } } } } } },
        Vlan10: {}
      }
    }
    const text = render(model).text
    expect(modes(text)).toEqual({ 'Ethernet1/1': ['no switchport'], 'Ethernet1/2': ['switchport'], 'Ethernet1/3': ['no switchport'], 'port-channel1': ['no switchport'], 'port-channel2': ['switchport'] })
    expect(text).not.toMatch(/interface (?:loopback0|Vlan10)\n {2}(?:no )?switchport/)
  })

  it('"no switchport" maps when the port has IP configuration, and is unsupported without', () => {
    const result = parse(['interface Ethernet1/1', '  no switchport', '  ip address 192.0.2.1/24', 'interface Ethernet1/2', '  no switchport', 'interface Ethernet1/3', '  no switchport', '  switchport'].join('\n'))
    expect(result.dispositions.L2).toEqual({ kind: 'ignored-by-design', reason: 'a routed port, as its IP configuration says: written back with it' })
    expect(result.dispositions.L5).toEqual({ kind: 'unsupported', reason: 'a routed port with no IP configuration the model holds: the model can\'t say it' })
    expect(result.dispositions.L7).toEqual({ kind: 'ignored-by-design', reason: 'superseded by line 8' })
    expect(result.dispositions.L8).toEqual({ kind: 'ignored-by-design', reason: 'a switch port: written back on every port with no IP configuration' })
  })
})

describe('configuration names that are Object.prototype\'s own (__proto__, constructor, toString)', () => {
  const KEYS = ['__proto__', 'constructor', 'toString']

  it('stay own keys of the model, round-trip, and never touch Object.prototype', () => {
    const prototypeNames = Object.getOwnPropertyNames(Object.prototype).sort()
    // Twice: a polluted prototype would show on the second parse.
    for (let run = 0; run < 2; run++) {
      for (const key of KEYS) {
        const text = [`snmp-server community ${key} group network-admin`, `vrf context ${key}`, '  ip route 0.0.0.0/0 192.0.2.1', `ip route 192.0.2.0/24 192.0.2.9 name ${key}`, 'ntp server constructor', 'logging server toString', `ip domain-list ${key}`, `feature ${key}`, `ip name-server 192.0.2.53 use-vrf ${key}`].join('\n')
        const result = parse(text)
        const communities = result.model.system?.snmp?.communities ?? {}
        expect(Object.hasOwn(communities, key), key).toBe(true)
        expect(Object.getPrototypeOf(communities)).toBe(Object.prototype)
        expect(communities[key]).toEqual({ access: 'read-write' })
        expect(Object.hasOwn(result.model.networkInstances ?? {}, key)).toBe(true)
        expect(Object.keys(result.model.system?.ntp?.servers ?? {})).toEqual(['constructor'])
        expect(Object.keys(result.model.system?.logging?.remoteServers ?? {})).toEqual(['toString'])
        expect(result.model.system?.dns).toEqual({ search: [key], servers: { '192.0.2.53': { networkInstance: key } } })
        // Through the kit's four checks, against the same model as JSON would carry it.
        expect(roundTrips(text, JSON.parse(JSON.stringify(result.model)) as Device)).toEqual([])
        expect(render(result.model).text).toContain(`snmp-server community ${key} group network-admin`)
        // A "no" form for such a name removes it, and only it.
        const removed = parse(`${text}\nno snmp-server community ${key}\nno ip domain-list ${key}`)
        expect(removed.model.system?.snmp).toBeUndefined()
        expect(removed.model.system?.dns?.search).toBeUndefined()
      }
    }
    expect(Object.getOwnPropertyNames(Object.prototype).sort()).toEqual(prototypeNames)
    expect(({} as Record<string, unknown>).access).toBeUndefined()
  })
})

describe('no secrets in what the plugin reports', () => {
  // Words that stand for secrets in each statement: none may appear in a disposition's reason or a diagnostic.
  const SECRETS = ['SECRET-COMMUNITY', 'SECRET-KEY', 'SECRET-HASH', 'SECRET-AUTH', 'SECRET-PRIV', 'SECRET-ACL-COMMUNITY']
  const text = [
    'snmp-server community SECRET-COMMUNITY group network-operator',
    'snmp-server community SECRET-COMMUNITY group custom-group',
    'snmp-server community SECRET-ACL-COMMUNITY use-ipv4acl CLIENTS',
    'snmp-server community SECRET-COMMUNITY ro extra',
    'snmp-server host 192.0.2.1 traps version 2c SECRET-COMMUNITY',
    'snmp-server user admin network-admin auth sha SECRET-AUTH priv aes-128 SECRET-PRIV',
    'ntp authentication-key 1 md5 SECRET-KEY 7',
    'ntp server 192.0.2.123 key SECRET-KEY',
    'username admin password 5 SECRET-HASH role network-admin',
    'tacacs-server host 192.0.2.5 key 7 SECRET-KEY',
    'no snmp-server community SECRET-ACL-COMMUNITY'
  ].join('\n')

  it('in parse dispositions and diagnostics', () => {
    const result = parse(text)
    const said = [...Object.values(result.dispositions).map((d) => ('reason' in d ? (d.reason ?? '') : '')), ...result.diagnostics.map((d) => d.message)]
    for (const secret of SECRETS) for (const s of said) expect(s, secret).not.toContain(secret)
  })

  it('in render dispositions and diagnostics, for a community left out', () => {
    const result = render({ system: { snmp: { communities: { 'SECRET-COMMUNITY': { access: 'read-only', clients: ['192.0.2.0/24'] } } } } })
    expect(result.text).not.toContain('SECRET-COMMUNITY')
    const said = [...Object.values(result.dispositions).map((d) => ('reason' in d ? d.reason : '')), ...result.diagnostics.map((d) => d.message)]
    expect(said.length).toBeGreaterThan(0)
    for (const s of said) expect(s).not.toContain('SECRET-COMMUNITY')
  })
})

describe('DNS', () => {
  it('a server already named in another VRF is unsupported: the model keys servers by address alone', () => {
    const result = parse('ip name-server 192.0.2.53 use-vrf A\nip name-server 192.0.2.53 192.0.2.54')
    expect(result.model.system?.dns).toEqual({ servers: { '192.0.2.53': { networkInstance: 'A' } } })
    expect(result.dispositions.L2).toEqual({ kind: 'unsupported', reason: 'a server of line 1 in another VRF: the model keys name servers by address alone' })
  })

  it('"use-vrf default" is the global table: same model as no VRF, and round-trips', () => {
    for (const text of ['ip name-server 192.0.2.53 use-vrf default', 'ntp server 192.0.2.123 use-vrf default', 'logging server 192.0.2.50 use-vrf default']) {
      expect(JSON.stringify(parse(text).model), text).not.toContain('networkInstance')
      expect(roundTrips(text), text).toEqual([])
    }
  })

  it('"no ip name-server" removes a server only in the VRF it names: no VRF and default alike', () => {
    const servers = (text: string) => parse(text).model.system?.dns?.servers
    expect(servers('ip name-server 192.0.2.53 use-vrf management\nno ip name-server 192.0.2.53 use-vrf other')).toEqual({ '192.0.2.53': { networkInstance: 'management' } })
    expect(servers('ip name-server 192.0.2.53 use-vrf management\nno ip name-server 192.0.2.53')).toEqual({ '192.0.2.53': { networkInstance: 'management' } })
    expect(servers('ip name-server 192.0.2.53 use-vrf management\nno ip name-server 192.0.2.53 use-vrf management')).toBeUndefined()
    expect(servers('ip name-server 192.0.2.53\nno ip name-server 192.0.2.53 use-vrf default')).toBeUndefined()
    expect(servers('ip name-server 192.0.2.53 use-vrf default\nno ip name-server 192.0.2.53')).toBeUndefined()
    const kept = parse('ip name-server 192.0.2.53 use-vrf management\nno ip name-server 192.0.2.53 use-vrf other')
    expect(kept.dispositions.L1).toMatchObject({ kind: 'mapped' })
    expect(kept.dispositions.L2).toEqual({ kind: 'ignored-by-design', reason: 'no such name server in that VRF: nothing to convert' })
  })

  it('a statement with a malformed server is unsupported as a whole', () => {
    for (const bad of ['2001:db8:::53', 'dns.example.net']) {
      const result = parse(`ip name-server 192.0.2.53 ${bad}`)
      expect(result.model, bad).toEqual({})
      expect(result.dispositions.L1).toEqual({ kind: 'unsupported', reason: 'word 4 isn\'t an address' })
    }
  })

  it('DNS inside a VRF context is unsupported: the model has one DNS configuration', () => {
    const result = parse('vrf context management\n  ip domain-name example.net\n  ip name-server 192.0.2.53')
    expect(result.model).toEqual({ networkInstances: { management: { type: 'vrf' } } })
    expect(result.dispositions.L2).toEqual({ kind: 'unsupported' })
    expect(result.dispositions.L3).toEqual({ kind: 'unsupported' })
  })
})

describe('static routes', () => {
  it('a second name for a route is unsupported: the model names the route, NX-OS each next hop', () => {
    const result = parse('ip route 10.0.0.0/8 192.0.2.1 name one\nip route 10.0.0.0/8 192.0.2.2 name two')
    expect(result.model.networkInstances?.default.staticRoutes?.['10.0.0.0/8']).toEqual({ description: 'one', nextHops: { '0': { address: '192.0.2.1' } } })
    expect(result.dispositions.L2).toEqual({ kind: 'unsupported', reason: 'a second name for the route named on line 1' })
  })

  it('a VRF\'s routes go inside its vrf context, the global table\'s at the top', () => {
    const text = 'vrf context A\n  ip route 0.0.0.0/0 192.0.2.1\nip route 10.0.0.0/8 Null0'
    expect(render(parse(text).model).text).toBe('ip route 10.0.0.0/8 Null0\n\nvrf context A\n  ip route 0.0.0.0/0 192.0.2.1\n')
    expect(roundTrips(text)).toEqual([])
  })
})

describe('the plugin', () => {
  it('loads in the registry as a source and a target', () => {
    const registry = createRegistry([plugin])
    expect(registry.sources().map((p) => p.id)).toEqual(['nxos'])
    expect(registry.targets().map((p) => p.id)).toEqual(['nxos'])
  })

  it('knows an IPv6 address from a malformed one, and masks from prefix lengths', () => {
    for (const a of ['2001:db8::53', '::', '::ffff:192.0.2.1']) expect(isIpv6(a), a).toBe(true)
    for (const a of ['2001:db8:::53', '1::2::3', '192.0.2.1', '']) expect(isIpv6(a), a).toBe(false)
    for (let len = 0; len <= 32; len++) expect(maskLength(lengthMask(len))).toBe(len)
    expect(maskLength('255.0.255.0')).toBeNull()
  })
})

describe('detect', () => {
  const whole = (platform: string) => readdirSync(join(root, platform, 'whole')).map((f) => [f, readFileSync(join(root, platform, 'whole', f), 'utf8')] as const)

  it('is sure of whole NX-OS configs that say anything NX-OS\'s own', () => {
    const scored = whole('nxos').map(([name, text]) => [name, plugin.detect!(text)] as const)
    // batfish__unit-tests_nexus.cfg is a hostname and a `configure session`: nothing tells it from IOS.
    for (const [name, score] of scored.filter(([file]) => file !== 'batfish__unit-tests_nexus.cfg')) expect(score, name).toBeGreaterThanOrEqual(0.7)
  })

  it('scores whole IOS / IOS-XE and IOS-XR configs low, and every Junos file', () => {
    for (const platform of ['iosxe', 'iosxr']) for (const [name, text] of whole(platform)) expect(plugin.detect!(text), `${platform}/${name}`).toBeLessThan(0.4)
    const junos = every(join(root, 'junos'))
    expect(junos.length).toBeGreaterThan(200)
    for (const file of junos) expect(plugin.detect!(readFileSync(file, 'utf8')), file).toBeLessThan(0.4)
  })

  it('separates NX-OS from IOS-XE across the corpus: wherever either is sure, the right one scores higher', () => {
    let sure = 0
    for (const [platform, right, wrong] of [['nxos', plugin, iosxe], ['iosxe', iosxe, plugin]] as const) {
      for (const file of every(join(root, platform))) {
        const text = readFileSync(file, 'utf8')
        const [r, w] = [right.detect!(text), wrong.detect!(text)]
        if (Math.max(r, w) < 0.4) continue
        sure++
        expect(r, `${file}: ${r} vs ${w}`).toBeGreaterThan(w)
      }
    }
    expect(sure).toBeGreaterThan(120)
  })

  it('scores text that isn\'t a config 0', () => {
    expect(plugin.detect!('')).toBe(0)
    expect(plugin.detect!('Dear team, the meeting is at noon.')).toBe(0)
  })
})

describe('rendering a model from another platform', () => {
  // Junos-shaped: unit 0 with its own description, two addresses and no primary, a reject route, a metric, an SNMP
  // client list, an NTP version.
  const model: Device = {
    system: {
      hostname: 'mx1',
      ntp: { servers: { '192.0.2.123': { version: 4, prefer: true } } },
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
          '10': { vlanId: 10, ipv6: { addresses: { '2001:db8::1': { prefixLength: 64, primary: true } } } }
        }
      }
    },
    networkInstances: {
      default: { type: 'default', staticRoutes: { '0.0.0.0/0': { nextHops: { '0': { drop: 'reject' } } }, '192.0.2.128/25': { nextHops: { '0': { address: '192.0.2.2', metric: 5 } } } } },
      CUST: { type: 'vrf', staticRoutes: { '10.0.0.0/8': { nextHops: { '0': { interface: 'ge-0/0/1.0' } } } } }
    }
  }
  const result = render(model)

  it('accounts for every populated field', () => {
    const ledger = buildLedger({ tree: [], model, dispositions: {}, diagnostics: [] }, result)
    expect(ledgerProblems(ledger)).toEqual([])
    expect(ledger.target?.strayPaths).toEqual([])
  })

  it('says what NX-OS can\'t write, and warns where it chose', () => {
    const notRendered = Object.entries(result.dispositions).filter(([, d]) => d.kind === 'unsupported').map(([path]) => path)
    expect(notRendered.sort()).toEqual([
      'interfaces["ge-0/0/0"].subinterfaces["0"].description',
      'interfaces["ge-0/0/0"].subinterfaces["0"].ipv4.mtu',
      'networkInstances.default.staticRoutes["0.0.0.0/0"].nextHops["0"].drop',
      'networkInstances.default.staticRoutes["192.0.2.128/25"].nextHops["0"].metric',
      'system.ntp.servers["192.0.2.123"].version',
      'system.snmp.communities.PLACEHOLDER.access',
      'system.snmp.communities.PLACEHOLDER.clients',
      'system.snmp.communities["PLACEHOLDER-RW"].access',
      'system.snmp.communities["PLACEHOLDER-RW"].clients'
    ])
    expect(result.diagnostics.map((d) => d.code)).toEqual(['nxos.snmp-community-restricted', 'nxos.snmp-community-restricted', 'nxos.primary-chosen'])
    expect(result.text).toContain('interface ge-0/0/0\n  description uplink\n  ip address 192.0.2.1/24\n  ip address 198.51.100.1/24 secondary\n')
    expect(result.text).toContain('interface ge-0/0/0.10\n  encapsulation dot1q 10\n  ipv6 address 2001:db8::1/64\n')
    expect(result.text).toContain('logging server 192.0.2.50 3\nlogging server 192.0.2.51 5 facility local7\n')
    expect(result.text).toContain('ntp server 192.0.2.123 prefer\n')
    expect(result.text).toContain('vrf context CUST\n  ip route 10.0.0.0/8 ge-0/0/1.0\n')
  })

  it('leaves out a community limited to some clients, RO or RW, rather than open it to every client', () => {
    expect(result.text.split('\n').filter((l) => l.startsWith('snmp-server community'))).toEqual(['snmp-server community OPEN'])
  })

  it('doesn\'t echo a left-out community\'s name, a secret, in its warning', () => {
    for (const w of result.diagnostics.filter((d) => d.code === 'nxos.snmp-community-restricted')) for (const name of ['PLACEHOLDER', 'PLACEHOLDER-RW']) expect(w.message).not.toContain(name)
  })

  it('leaves a field of a later model version unrendered, for the ledger to report', () => {
    const later = { ...model, system: { ...model.system, timezone: 'UTC' } } as Device
    const ledger = buildLedger({ tree: [], model: later, dispositions: {}, diagnostics: [] }, render(later))
    expect(ledgerProblems(ledger)).toEqual(['unrendered: system.timezone'])
  })

  it('writes every leaf of a fully populated NX-OS model back', () => {
    const parsed = parse(readFileSync(join(fixtures, 'interfaces/addresses.cfg'), 'utf8'))
    const rendered = render(parsed.model)
    const notRendered = populatedLeaves(parsed.model).map((l) => l.path).filter((p) => rendered.dispositions[p]?.kind !== 'rendered')
    expect(notRendered.every((p) => /\.type$|\.vlanTagging$/.test(p)), notRendered.join('\n')).toBe(true)
  })
})
