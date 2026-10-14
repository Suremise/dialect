// The plugin beyond its fixtures: nothing dropped silently, later statements acting on earlier ones (`no …` forms,
// `vrf member`, `ip address dhcp`), the `feature` and `switchport` lines a render must carry, configuration names that
// are Object.prototype's own, no secrets in what the plugin reports, detect(), and rendering a model that came from
// another platform.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { checkFixture, checkSecrets, findSecrets } from '@dialect/conformance'
import { buildLedger, createRegistry, ledgerProblems, MODEL_VERSION, populatedLeaves, statementsOf, type Device, type ParseResult } from '@dialect/core'
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
    const text = ['hostname n1', 'router ospf 1', '  router-id 192.0.2.1', 'interface Ethernet1/1', '  speed 1000', '  hsrp 10', '    ip 192.0.2.254', 'frobnicate now'].join('\n')
    const result = parse(text)
    const d = byText(result)
    for (const t of ['router ospf 1', 'router-id 192.0.2.1', 'speed 1000', 'hsrp 10', 'ip 192.0.2.254', 'frobnicate now']) expect(d.get(t), t).toMatchObject({ kind: 'unsupported' })
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
    ['VRF', ['vrf context A', '  ip route 10.0.0.0/8 192.0.2.1', 'vrf context B', 'no vrf context A'], { networkInstances: { B: { type: 'vrf' } } }]
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

  it('"vrf member" clears the addresses before it, as on the device', () => {
    const result = parse(['interface Ethernet1/1', '  no switchport', '  ip address 192.0.2.1/24', '  vrf member A'].join('\n'))
    expect(addresses(result)).toBeUndefined()
    expect(result.dispositions.L3).toEqual({ kind: 'ignored-by-design', reason: 'removed by line 4, which moves the interface to another VRF' })
    expect(result.dispositions.L4).toEqual({ kind: 'unsupported', reason: 'the model can\'t place an interface in a VRF yet, clearing the addresses on line 3' })
  })

  it('an address in a VRF is left out rather than put in the global table', () => {
    const result = parse(['interface Ethernet1/1', '  no switchport', '  vrf member A', '  ip address 192.0.2.1/24', '  ipv6 address 2001:db8::1/64'].join('\n'))
    expect(result.model.interfaces).toEqual({ 'Ethernet1/1': { type: 'ethernet' } })
    expect(result.dispositions.L4).toEqual({ kind: 'unsupported', reason: 'an address in the VRF of line 3: the model can\'t place an interface in a VRF yet' })
    expect(result.dispositions.L2).toMatchObject({ kind: 'unsupported' })
  })

  it('"no ip address" removes an address left out for its VRF too', () => {
    const result = parse(['interface Ethernet1/1', '  vrf member A', '  ip address 192.0.2.1/24', '  ipv6 address 2001:db8::1/64', '  no ip address'].join('\n'))
    expect(result.dispositions.L3).toEqual({ kind: 'ignored-by-design', reason: 'removed by line 5' })
    expect(result.dispositions.L4).toMatchObject({ kind: 'unsupported' })
    expect(result.dispositions.L5).toEqual({ kind: 'ignored-by-design', reason: 'removes the addresses on line 3: nothing to convert' })
  })

  it('"no vrf member" returns the interface to the global table, clearing its addresses', () => {
    const result = parse(['interface Ethernet1/1', '  vrf member A', '  ip address 192.0.2.1/24', '  no vrf member', '  ip address 192.0.2.9/24'].join('\n'))
    expect(addresses(result)).toEqual({ '192.0.2.9': { prefixLength: 24 } })
    expect(result.dispositions.L2).toEqual({ kind: 'ignored-by-design', reason: 'undone by line 4' })
    expect(result.dispositions.L3).toMatchObject({ kind: 'ignored-by-design' })
  })

  it('mgmt0 is always in the management VRF: said by its type, and written back', () => {
    const text = ['interface mgmt0', '  vrf member management', '  ip address 192.0.2.10/24'].join('\n')
    const result = parse(text)
    expect(result.model.interfaces?.mgmt0).toEqual({ type: 'management', subinterfaces: { '0': { ipv4: { addresses: { '192.0.2.10': { prefixLength: 24 } } } } } })
    expect(result.dispositions.L2).toMatchObject({ kind: 'ignored-by-design' })
    expect(render(result.model).text).toContain('interface mgmt0\n  vrf member management\n  ip address 192.0.2.10/24\n')
    expect(parse('interface mgmt0\n  vrf member other').dispositions.L2).toEqual({ kind: 'unsupported', reason: 'mgmt0 is always in the management VRF' })
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
  [/^interface tunnel\d/i, 'tunnel']
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
  })

  it('a render writes every feature its statements need, before them, from any model', () => {
    const model: Device = { interfaces: { 'Ethernet1/1': {}, Vlan10: { description: 'svi' }, Tunnel5: {}, vlan20: { type: 'vlan' } } }
    const text = render(model).text
    expect(missingFeatures(text)).toEqual([])
    expect(text.split('\n').filter((l) => l.startsWith('feature '))).toEqual(['feature interface-vlan', 'feature tunnel'])
    expect(missingFeatures(render({ interfaces: { 'Ethernet1/1': {} } }).text)).toEqual([])
    expect(render({ interfaces: { 'Ethernet1/1': {} } }).text).not.toContain('feature')
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
    expect(result.dispositions.L8).toEqual({ kind: 'unsupported', reason: 'Layer 2 switching comes later' })
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
