// The plugin beyond its fixtures: nothing dropped silently (unknown statements, banners and certificate chains are
// unsupported, with their text kept), VRF membership and definitions, the registry, detect(), and rendering a model that
// came from another platform.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { checkFixture, checkSecrets } from '@dialect/conformance'
import { buildLedger, createRegistry, fieldPath, ledgerProblems, MODEL_VERSION, populatedLeaves, statementsOf, type Device } from '@dialect/core'
import plugin from '../src'
import { isIpv6, lengthMask, maskLength } from '../src/addresses'
import type { IosNode } from '../src/tree'

const context = { modelVersion: MODEL_VERSION }
const parse = (text: string) => plugin.parse!(text, context)
const render = (model: Device) => plugin.render!(model, context)
/** The kit's four checks on `text` against its own parse: no error, a complete ledger, a stable round trip. */
const roundTrips = (text: string) => checkFixture(plugin, { name: text, source: text, expectedModel: parse(text).model }).flatMap((r) => (r.status === 'failed' ? r.problems : []))

describe('nothing is dropped silently', () => {
  it('unknown statements, and everything inside them, are unsupported with their text kept', () => {
    const text = ['hostname r1', 'router ospf 1', ' network 192.0.2.0 0.0.0.255 area 0', 'interface Gi1', ' speed 1000', ' service-policy input P', '  nested thing', 'frobnicate now'].join('\n')
    const result = parse(text)
    const byText = new Map(statementsOf(result.tree).map((n) => [(n as IosNode).text, result.dispositions[n.id]]))
    for (const t of ['router ospf 1', 'network 192.0.2.0 0.0.0.255 area 0', 'speed 1000', 'service-policy input P', 'nested thing', 'frobnicate now']) {
      expect(byText.get(t), t).toMatchObject({ kind: 'unsupported' })
    }
    expect(buildLedger(result).complete).toBe(true)
  })

  it('a banner and a certificate chain each come through as one atomic unsupported statement', () => {
    const banner = ['banner login ^C', 'Line 1', 'interface Gi1', ' ip address 192.0.2.1 255.255.255.0', '^C']
    const chain = ['crypto pki certificate chain TP-1', ' certificate self-signed 01', '  30820330', '  \tquit']
    const result = parse([...banner, ...chain, 'hostname r1'].join('\n'))
    const nodes = result.tree as readonly IosNode[]
    expect(nodes).toHaveLength(3)
    expect(nodes[0]).toMatchObject({ kind: 'banner', text: banner.join('\n'), children: [] })
    expect(result.dispositions[nodes[0].id]).toEqual({ kind: 'unsupported', reason: 'a login banner, 5 lines, kept verbatim' })
    expect(nodes[1]).toMatchObject({ kind: 'certificate-chain', text: chain.join('\n'), children: [] })
    expect(result.dispositions[nodes[1].id]).toEqual({ kind: 'unsupported', reason: 'certificate chain TP-1, 4 lines, kept verbatim' })
    // The interface inside the banner is banner text, not configuration.
    expect(result.model).toEqual({ system: { hostname: 'r1' } })
  })

  it('a statement with an option the model can\'t hold is unsupported as a whole, not half-converted', () => {
    const result = parse('ntp server 192.0.2.1 key 1\nip name-server 192.0.2.53 2.3.4.5 use-vrf management')
    expect(result.model).toEqual({})
    expect(Object.values(result.dispositions)).toEqual([{ kind: 'unsupported', reason: '"key" isn\'t converted yet' }, { kind: 'unsupported', reason: '"use-vrf" isn\'t converted yet' }])
  })

  it('a later setting supersedes an earlier one, as on the device', () => {
    const result = parse('hostname a\nhostname b\ninterface Gi1\n ip address 192.0.2.1 255.255.255.0\n ip address 192.0.2.9 255.255.255.0')
    expect(result.model.system?.hostname).toBe('b')
    expect(result.dispositions.L1).toEqual({ kind: 'ignored-by-design', reason: 'superseded by line 2' })
    expect(Object.keys(result.model.interfaces?.Gi1.subinterfaces?.['0'].ipv4?.addresses ?? {})).toEqual(['192.0.2.9'])
    expect(result.dispositions.L4).toEqual({ kind: 'ignored-by-design', reason: 'replaced by line 5' })
  })
})

describe('DNS', () => {
  it('a server already named in another VRF is unsupported: the model keys servers by address alone', () => {
    const result = parse('ip name-server vrf A 192.0.2.53\nip name-server 192.0.2.53 192.0.2.54')
    expect(result.model.system?.dns).toEqual({ servers: { '192.0.2.53': { networkInstance: 'A' } } })
    expect(result.dispositions.L2).toEqual({ kind: 'unsupported', reason: '192.0.2.53 is already a name server in another VRF' })
  })

  it('a statement with a malformed IPv6 server is unsupported as a whole, with no server added', () => {
    for (const bad of ['2001:db8:::53', '2001:db8:1:2:3:4:5:6:']) {
      const result = parse(`ip name-server 192.0.2.53 ${bad}`)
      expect(result.model, bad).toEqual({})
      expect(result.dispositions.L1).toEqual({ kind: 'unsupported', reason: `"${bad}" isn't converted yet` })
    }
  })

  it('"vrf default" is the global table: same model as no VRF, round-trips, and is no conflict with it', () => {
    for (const text of ['ip name-server vrf default 192.0.2.53', 'ip name-server vrf default 192.0.2.53\nip name-server 192.0.2.53', 'ip name-server 192.0.2.53\nip name-server vrf default 192.0.2.53']) {
      const result = parse(text)
      expect(result.model, text).toEqual({ system: { dns: { servers: { '192.0.2.53': {} } } } })
      expect(Object.values(result.dispositions).every((d) => d.kind === 'mapped'), text).toBe(true)
      const fixture = { name: text, source: text, expectedModel: result.model }
      expect(checkFixture(plugin, fixture).flatMap((r) => (r.status === 'failed' ? r.problems : []))).toEqual([])
    }
  })

  it('"vrf default" on NTP and logging servers round-trips too', () => {
    const text = 'ntp server vrf default 192.0.2.123\nlogging host 192.0.2.50 vrf default'
    const result = parse(text)
    expect(result.model.system).toEqual({ ntp: { servers: { '192.0.2.123': {} } }, logging: { remoteServers: { '192.0.2.50': {} } } })
    expect(checkFixture(plugin, { name: 'vrf default', source: text, expectedModel: result.model }).flatMap((r) => (r.status === 'failed' ? r.problems : []))).toEqual([])
  })

  it('a search domain listed twice is listed once', () => {
    const result = parse('ip domain list example.net\nip domain-list example.net')
    expect(result.model.system?.dns?.search).toEqual(['example.net'])
    expect(result.dispositions.L2).toEqual({ kind: 'ignored-by-design', reason: 'already in the search list' })
  })

  it('renders servers and search domains from another platform\'s model, every field accounted for', () => {
    const model: Device = { system: { dns: { search: ['a.example', 'b.example'], servers: { '192.0.2.1': { networkInstance: 'default' }, '2001:db8::1': {}, '192.0.2.2': { networkInstance: 'MGMT' } } } } }
    const result = plugin.render!(model, context)
    expect(result.text.split('\n').filter((l) => l.startsWith('ip '))).toEqual(['ip domain list a.example', 'ip domain list b.example', 'ip name-server 192.0.2.1', 'ip name-server 2001:db8::1', 'ip name-server vrf MGMT 192.0.2.2'])
    expect(ledgerProblems(buildLedger({ tree: [], model, dispositions: {}, diagnostics: [] }, result))).toEqual([])
  })
})

describe('IPv4 addresses', () => {
  const addresses = (result: ReturnType<typeof parse>) => result.model.interfaces?.Gi1?.subinterfaces?.['0']?.ipv4?.addresses

  it('"no ip address" removes the primary and secondaries before it', () => {
    const result = parse(['interface Gi1', ' ip address 192.0.2.1 255.255.255.0', ' ip address 198.51.100.1 255.255.255.0 secondary', ' no ip address', ' description d'].join('\n'))
    expect(result.model.interfaces).toEqual({ Gi1: { type: 'ethernet', description: 'd' } })
    expect(result.dispositions.L2).toEqual({ kind: 'ignored-by-design', reason: 'removed by "no ip address" on line 4' })
    expect(result.dispositions.L3).toEqual({ kind: 'ignored-by-design', reason: 'removed by "no ip address" on line 4' })
    expect(result.dispositions.L4).toEqual({ kind: 'ignored-by-design', reason: 'removes the IPv4 addresses before it (lines 2, 3): nothing to convert' })
    expect(plugin.render!(result.model, context).text).not.toContain('ip address')
    expect(buildLedger(result).complete).toBe(true)
  })

  it('an address after "no ip address" is the interface\'s address', () => {
    const result = parse(['interface Gi1', ' ip address 192.0.2.1 255.255.255.0', ' ip address 198.51.100.1 255.255.255.0 secondary', ' no ip address', ' ip address 203.0.113.1 255.255.255.0'].join('\n'))
    expect(addresses(result)).toEqual({ '203.0.113.1': { prefixLength: 24 } })
    expect(result.dispositions.L5).toMatchObject({ kind: 'mapped' })
  })

  it('a secondary address with no primary is unsupported, not turned into a primary', () => {
    for (const secondaries of [['192.0.2.1'], ['192.0.2.1', '198.51.100.1']]) {
      const lines = ['interface Gi1', ...secondaries.map((a) => ` ip address ${a} 255.255.255.0 secondary`)]
      const result = parse(lines.join('\n'))
      expect(result.model.interfaces, secondaries.join()).toEqual({ Gi1: { type: 'ethernet' } })
      for (let i = 2; i <= lines.length; i++) expect(result.dispositions[`L${i}`]).toEqual({ kind: 'unsupported', reason: 'a secondary address with no primary address: the model can\'t say an address is secondary' })
      expect(plugin.render!(result.model, context).text).not.toContain('ip address')
    }
  })
})

describe('"no" forms clear what they remove (#55)', () => {
  it('"no description" removes the interface\'s description', () => {
    const result = parse('interface GigabitEthernet1\n description uplink\n no description')
    expect(result.model.interfaces?.GigabitEthernet1).toEqual({ type: 'ethernet' })
    expect(result.dispositions.L2).toEqual({ kind: 'ignored-by-design', reason: 'removed by line 3' })
    expect(result.dispositions.L3).toEqual({ kind: 'ignored-by-design', reason: 'removes the description on line 2: nothing to convert' })
    expect(parse('interface GigabitEthernet1\n no description').dispositions.L2).toMatchObject({ kind: 'ignored-by-design' })
  })

  it('"no ip route" removes the next hop it names, or every one; the others keep their order', () => {
    const text = ['ip route 10.0.0.0 255.0.0.0 192.0.2.1', 'ip route 10.0.0.0 255.0.0.0 192.0.2.2 250', 'ip route 10.0.0.0 255.0.0.0 192.0.2.3', 'no ip route 10.0.0.0 255.0.0.0 192.0.2.2'].join('\n')
    const result = parse(text)
    expect(result.model.networkInstances?.default.staticRoutes?.['10.0.0.0/8']).toEqual({ nextHops: { '0': { address: '192.0.2.1' }, '1': { address: '192.0.2.3' } } })
    expect(result.dispositions.L2).toEqual({ kind: 'ignored-by-design', reason: 'removed by line 4' })
    // Renumbered, and each statement says where its next hop went.
    expect(result.dispositions.L3).toEqual({ kind: 'mapped', fields: ['networkInstances.default.staticRoutes["10.0.0.0/8"].nextHops["1"].address'] })
    expect(buildLedger(result).complete).toBe(true)
    expect(parse(`${text}\nno ip route 10.0.0.0 255.0.0.0`).model.networkInstances).toBeUndefined()
    expect(parse('no ip route 10.0.0.0 255.0.0.0').dispositions.L1).toEqual({ kind: 'ignored-by-design', reason: 'no such route: nothing to convert' })
    // IPv6 too.
    expect(parse('ipv6 route ::/0 2001:db8::1\nno ipv6 route ::/0 2001:db8::1').model).toEqual({})
  })

  it('"no ip route vrf A" touches only A\'s route, and "no ip route" only the global table\'s', () => {
    const routes = ['vrf definition A', ' address-family ipv4', ' exit-address-family', 'ip route 10.0.0.0 255.0.0.0 192.0.2.1', 'ip route vrf A 10.0.0.0 255.0.0.0 192.0.2.1']
    const inA = parse([...routes, 'no ip route vrf A 10.0.0.0 255.0.0.0'].join('\n')).model.networkInstances
    expect(inA?.default.staticRoutes?.['10.0.0.0/8']).toEqual({ nextHops: { '0': { address: '192.0.2.1' } } })
    expect(inA?.A).toEqual({ type: 'vrf' })
    const global = parse([...routes, 'no ip route 10.0.0.0 255.0.0.0'].join('\n')).model.networkInstances
    expect(global?.default).toBeUndefined()
    expect(global?.A.staticRoutes?.['10.0.0.0/8']).toEqual({ nextHops: { '0': { address: '192.0.2.1' } } })
  })

  it('"no ip name-server" removes a server only in the VRF it names (none: the global table), and keeps a statement\'s others', () => {
    const servers = (text: string) => parse(text).model.system?.dns?.servers
    expect(servers('ip name-server vrf A 192.0.2.53\nno ip name-server 192.0.2.53')).toEqual({ '192.0.2.53': { networkInstance: 'A' } })
    expect(servers('ip name-server vrf A 192.0.2.53\nno ip name-server vrf B 192.0.2.53')).toEqual({ '192.0.2.53': { networkInstance: 'A' } })
    expect(servers('ip name-server vrf A 192.0.2.53\nno ip name-server vrf A 192.0.2.53')).toBeUndefined()
    expect(servers('ip name-server 192.0.2.53\nno ip name-server vrf default 192.0.2.53')).toBeUndefined()
    const result = parse('ip name-server 192.0.2.53 192.0.2.54\nno ip name-server 192.0.2.53')
    expect(result.model.system?.dns?.servers).toEqual({ '192.0.2.54': {} })
    expect(result.dispositions.L1).toEqual({ kind: 'mapped', fields: ['system.dns.servers["192.0.2.54"]'] })
    expect(result.dispositions.L2).toEqual({ kind: 'ignored-by-design', reason: 'removes name servers configured on line 1: nothing to convert' })
  })

  it('"no snmp-server community" removes the community, and names it in no reason', () => {
    const result = parse('snmp-server community PLACEHOLDER RO\nsnmp-server contact noc\nno snmp-server community PLACEHOLDER')
    expect(result.model.system).toEqual({ snmp: { contact: 'noc' } })
    expect(result.dispositions.L1).toEqual({ kind: 'ignored-by-design', reason: 'removed by line 3' })
    expect(result.dispositions.L3).toEqual({ kind: 'ignored-by-design', reason: 'removes the community configured on line 1: nothing to convert' })
    expect(parse('no snmp-server community PLACEHOLDER').dispositions.L1).toEqual({ kind: 'ignored-by-design', reason: 'no such community: nothing to convert' })
  })

  it('a community with an access list anywhere is left out whole, in either order and access; another is untouched', () => {
    for (const access of ['RO', 'RW']) {
      for (const lines of [[`snmp-server community PLACEHOLDER ${access}`, `snmp-server community PLACEHOLDER ${access} 10`], [`snmp-server community PLACEHOLDER ${access} 10`, `snmp-server community PLACEHOLDER ${access}`]]) {
        const result = parse([...lines, 'snmp-server community OTHER-PLACEHOLDER RO'].join('\n'))
        expect(result.model.system?.snmp?.communities, lines.join(' / ')).toEqual({ 'OTHER-PLACEHOLDER': { access: 'read-only' } })
        const acl = lines.findIndex((l) => l.endsWith(' 10')) + 1
        const open = acl === 1 ? 2 : 1
        expect(result.dispositions[`L${open}`]).toEqual({ kind: 'unsupported', reason: `left out whole: line ${acl} about the same community isn't converted, and may limit or change it` })
        expect(render(result.model).text).not.toMatch(/community PLACEHOLDER /)
      }
    }
  })

  it('"no snmp-server community" takes its access list with it: the community made again is open, as on the device', () => {
    const result = parse(['snmp-server community PLACEHOLDER RO 10', 'no snmp-server community PLACEHOLDER', 'snmp-server community PLACEHOLDER RO'].join('\n'))
    expect(result.model.system?.snmp?.communities).toEqual({ PLACEHOLDER: { access: 'read-only' } })
    expect(result.dispositions.L1).toEqual({ kind: 'ignored-by-design', reason: 'removed by line 2' })
    expect(result.dispositions.L3).toMatchObject({ kind: 'mapped' })
    // Removed with nothing after it, nothing comes back.
    expect(parse('snmp-server community PLACEHOLDER RO\nsnmp-server community PLACEHOLDER RO 10\nno snmp-server community PLACEHOLDER').model).toEqual({})
  })
})

describe('route next hops', () => {
  it('a malformed address isn\'t taken for an interface: the route is unsupported, also in "no ip route"', () => {
    for (const text of ['ipv6 route 2001:db8::/32 dead::beef::bad', 'ip route 10.0.0.0 255.0.0.0 192.0.2.300', 'ip route 10.0.0.0 255.0.0.0 not-an-interface', 'ip route 10.0.0.0 255.0.0.0 dead::beef::bad']) {
      const result = parse(text)
      expect(result.model, text).toEqual({})
      expect(result.dispositions.L1, text).toMatchObject({ kind: 'unsupported' })
    }
    const removal = parse('ipv6 route 2001:db8::/32 2001:db8::1\nno ipv6 route 2001:db8::/32 dead::beef::bad')
    expect(removal.dispositions.L2).toMatchObject({ kind: 'unsupported' })
    expect(removal.model.networkInstances?.default.staticRoutes?.['2001:db8::/32']).toEqual({ nextHops: { '0': { address: '2001:db8::1' } } })
  })

  it('a real interface name is one: full, short, a channel, a subinterface and Null0', () => {
    for (const [text, hop] of [
      ['ip route 10.0.0.0 255.0.0.0 GigabitEthernet0/0/1', { interface: 'GigabitEthernet0/0/1' }],
      ['ip route 10.0.0.0 255.0.0.0 Gi0/1.10', { interface: 'Gi0/1.10' }],
      ['ip route 10.0.0.0 255.0.0.0 Serial0/0/0:0', { interface: 'Serial0/0/0:0' }],
      ['ip route 10.0.0.0 255.0.0.0 Loopback 1', { interface: 'Loopback1' }],
      ['ip route 10.0.0.0 255.0.0.0 Null0', { drop: 'discard' }]
    ] as const)
      expect(parse(text).model.networkInstances?.default.staticRoutes?.['10.0.0.0/8'], text).toEqual({ nextHops: { '0': hop } })
  })
})

describe('VRF membership', () => {
  const vrfA = 'vrf definition A\n address-family ipv4\n exit-address-family\n address-family ipv6\n exit-address-family'
  const sub0 = (text: string, name = 'GigabitEthernet1') => parse(text).model.interfaces?.[name]?.subinterfaces?.['0']

  it('"vrf forwarding" after addresses clears them, IPv4 and IPv6, as on the device', () => {
    const text = [vrfA, 'interface GigabitEthernet1', ' ip address 192.0.2.1 255.255.255.0', ' ip address 192.0.2.129 255.255.255.128 secondary', ' ipv6 address 2001:db8::1/64', ' vrf forwarding A'].join('\n')
    const result = parse(text)
    expect(result.model.interfaces?.GigabitEthernet1.subinterfaces).toEqual({ '0': { networkInstance: 'A' } })
    for (const l of ['L7', 'L8', 'L9']) expect(result.dispositions[l], l).toEqual({ kind: 'ignored-by-design', reason: 'removed by line 10, which moves the interface to another VRF' })
    expect(result.dispositions.L10).toEqual({ kind: 'mapped', fields: ['interfaces.GigabitEthernet1.subinterfaces["0"].networkInstance'] })
    expect(roundTrips(text)).toEqual([])
  })

  it('addresses after "vrf forwarding" are in the VRF, and render after it', () => {
    for (const forwarding of [' vrf forwarding A', ' ip vrf forwarding A']) {
      const text = [vrfA, 'interface GigabitEthernet1', forwarding, ' ip address 192.0.2.1 255.255.255.0', ' ipv6 address 2001:db8::1/64'].join('\n')
      expect(sub0(text), forwarding).toEqual({ networkInstance: 'A', ipv4: { addresses: { '192.0.2.1': { prefixLength: 24 } } }, ipv6: { addresses: { '2001:db8::1': { prefixLength: 64 } } } })
      expect(render(parse(text).model).text).toContain('interface GigabitEthernet1\n vrf forwarding A\n ip address 192.0.2.1 255.255.255.0\n ipv6 address 2001:db8::1/64\n')
      expect(roundTrips(text)).toEqual([])
    }
  })

  it('a subinterface\'s "vrf forwarding" goes on that subinterface', () => {
    const text = [vrfA, 'interface GigabitEthernet1.10', ' encapsulation dot1Q 10', ' vrf forwarding A', ' ip address 192.0.2.1 255.255.255.0'].join('\n')
    expect(parse(text).model.interfaces?.GigabitEthernet1.subinterfaces).toEqual({ '10': { vlanId: 10, networkInstance: 'A', ipv4: { addresses: { '192.0.2.1': { prefixLength: 24 } } } } })
    expect(roundTrips(text)).toEqual([])
  })

  it('"no vrf forwarding" returns the interface to the global table, clearing its addresses', () => {
    for (const no of [' no vrf forwarding', ' no vrf forwarding A', ' no ip vrf forwarding A']) {
      const text = [vrfA, 'interface GigabitEthernet1', ' vrf forwarding A', ' ip address 192.0.2.1 255.255.255.0', no, ' ip address 192.0.2.9 255.255.255.0'].join('\n')
      const result = parse(text)
      expect(sub0(text), no).toEqual({ ipv4: { addresses: { '192.0.2.9': { prefixLength: 24 } } } })
      expect(result.dispositions.L7).toEqual({ kind: 'ignored-by-design', reason: 'undone by line 9' })
      expect(result.dispositions.L8).toMatchObject({ kind: 'ignored-by-design' })
      expect(result.dispositions.L9).toEqual({ kind: 'ignored-by-design', reason: 'returns the interface to the global table, clearing the addresses on line 8: nothing to convert' })
      expect(roundTrips(text)).toEqual([])
    }
    // Another VRF's `no` touches nothing.
    const other = parse([vrfA, 'interface GigabitEthernet1', ' vrf forwarding A', ' ip address 192.0.2.1 255.255.255.0', ' no vrf forwarding B'].join('\n'))
    expect(other.dispositions.L9).toEqual({ kind: 'ignored-by-design', reason: 'not in that VRF: nothing to convert' })
    expect(other.model.interfaces?.GigabitEthernet1.subinterfaces?.['0']).toMatchObject({ networkInstance: 'A', ipv4: {} })
    expect(parse('interface GigabitEthernet1\n vrf forwarding default').dispositions.L2).toMatchObject({ kind: 'unsupported' })
  })

  it('an interface in a VRF the text doesn\'t define is left out with its addresses, not put in the global table', () => {
    const result = parse(['interface GigabitEthernet1', ' vrf forwarding A', ' ip address 192.0.2.1 255.255.255.0', ' ipv6 address 2001:db8::1/64'].join('\n'))
    expect(result.model.interfaces).toEqual({ GigabitEthernet1: { type: 'ethernet' } })
    expect(result.dispositions.L2).toEqual({ kind: 'unsupported', reason: 'names a VRF the configuration doesn\'t define' })
    for (const l of ['L3', 'L4']) expect(result.dispositions[l]).toEqual({ kind: 'unsupported', reason: 'an address in the VRF of line 2, which the configuration doesn\'t define' })
    // Defined after the interface is fine.
    expect(sub0(['interface GigabitEthernet1', ' vrf forwarding A', vrfA].join('\n'))).toEqual({ networkInstance: 'A' })
  })

  it('a route naming a VRF doesn\'t define it: the membership is still left out, in either order and either form', () => {
    const route = 'ip route vrf MISSING 10.0.0.0 255.0.0.0 192.0.2.254'
    for (const forwarding of [' vrf forwarding MISSING', ' ip vrf forwarding MISSING']) {
      const iface = ['interface GigabitEthernet1', forwarding, ' ip address 192.0.2.1 255.255.255.0']
      for (const lines of [[...iface, route], [route, ...iface]]) {
        const result = parse(lines.join('\n'))
        expect(result.model.interfaces, lines.join(' / ')).toEqual({ GigabitEthernet1: { type: 'ethernet' } })
        expect(result.dispositions[`L${lines.indexOf(forwarding) + 1}`]).toEqual({ kind: 'unsupported', reason: 'names a VRF the configuration doesn\'t define' })
        expect(result.dispositions[`L${lines.indexOf(' ip address 192.0.2.1 255.255.255.0') + 1}`]).toMatchObject({ kind: 'unsupported' })
      }
    }
    // With a definition, later in the text, it maps.
    const defined = parse(['interface GigabitEthernet1', ' vrf forwarding MISSING', ' ip address 192.0.2.1 255.255.255.0', route, 'ip vrf MISSING'].join('\n'))
    expect(defined.model.interfaces?.GigabitEthernet1.subinterfaces?.['0']).toEqual({ networkInstance: 'MISSING', ipv4: { addresses: { '192.0.2.1': { prefixLength: 24 } } } })
  })

  it('"no vrf definition" removes the VRF, its routes, and its interfaces\' membership and addresses', () => {
    for (const [def, no] of [['vrf definition A', 'no vrf definition A'], ['ip vrf A', 'no ip vrf A']]) {
      const lines = [def, ' rd 65000:1', ' route-target both 65000:1', 'interface GigabitEthernet1', ' vrf forwarding A', ' ip address 192.0.2.1 255.255.255.0', 'ip route vrf A 0.0.0.0 0.0.0.0 192.0.2.254', no, 'interface GigabitEthernet1', ' ip address 192.0.2.9 255.255.255.0']
      const result = parse(lines.join('\n'))
      expect(result.model.networkInstances, def).toBeUndefined()
      expect(result.model.interfaces?.GigabitEthernet1.subinterfaces).toEqual({ '0': { ipv4: { addresses: { '192.0.2.9': { prefixLength: 24 } } } } })
      for (const l of ['L1', 'L2', 'L3', 'L5', 'L6', 'L7']) expect(result.dispositions[l], `${def} ${l}`).toEqual({ kind: 'ignored-by-design', reason: 'removed by line 8' })
      expect(buildLedger(result).complete).toBe(true)
    }
    expect(parse('no vrf definition A').dispositions.L1).toEqual({ kind: 'ignored-by-design', reason: 'no such VRF: nothing to convert' })
  })

  it('a render leaves out a membership in a VRF the model doesn\'t have, with the addresses that would land in another table', () => {
    const ipv4 = { ipv4: { addresses: { '192.0.2.1': { prefixLength: 24 } } } }
    const result = render({ interfaces: { GigabitEthernet1: { subinterfaces: { '0': { networkInstance: 'B', ...ipv4 } } }, GigabitEthernet2: { subinterfaces: { '0': { networkInstance: 'default', ...ipv4 } } } } })
    const at = (name: string, ...leaf: string[]) => result.dispositions[fieldPath('interfaces', name, 'subinterfaces', '0', ...leaf)]
    expect(at('GigabitEthernet1', 'networkInstance')).toEqual({ kind: 'unsupported', reason: 'a VRF the model doesn\'t have' })
    expect(at('GigabitEthernet1', 'ipv4', 'addresses', '192.0.2.1', 'prefixLength')).toMatchObject({ kind: 'unsupported' })
    expect(at('GigabitEthernet2', 'networkInstance')).toMatchObject({ kind: 'not-applicable' })
    expect(at('GigabitEthernet2', 'ipv4', 'addresses', '192.0.2.1', 'prefixLength')).toMatchObject({ kind: 'rendered' })
    expect(result.text).not.toContain('vrf forwarding')
  })
})

describe('a VRF only routes name (#53)', () => {
  const routeOnly = ['ip route vrf CUST 10.0.0.0 255.0.0.0 192.0.2.1', 'ipv6 route vrf CUST ::/0 2001:db8::1']

  it('is kept for its routes with a warning saying no definition was given; nothing is invented for it', () => {
    const result = parse(routeOnly.join('\n'))
    expect(result.model.networkInstances?.CUST).toEqual({ type: 'vrf', staticRoutes: { '10.0.0.0/8': { nextHops: { '0': { address: '192.0.2.1' } } }, '::/0': { nextHops: { '0': { address: '2001:db8::1' } } } } })
    expect(result.diagnostics).toEqual([{ severity: 'warning', category: 'semantic', code: 'iosxe.vrf-created', message: 'A VRF only routes name has no definition in the text: it is kept for its routes, with no route distinguisher or route targets, and a render writes a definition for it.', field: 'networkInstances.CUST', statement: 'L1' }])
    // The render writes the definition IOS needs, with the families its routes use, and no RD or route targets.
    const text = render(result.model).text
    expect(text).toContain('vrf definition CUST\n !\n address-family ipv4\n exit-address-family\n !\n address-family ipv6\n exit-address-family\n!')
    expect(text).not.toMatch(/ rd |route-target/)
    expect(roundTrips(routeOnly.join('\n'))).toEqual([])
  })

  it('a VRF with a definition, before or after its routes, gets no warning', () => {
    for (const lines of [['vrf definition CUST', ' address-family ipv4', ' exit-address-family', routeOnly[0]], [routeOnly[0], 'ip vrf CUST']]) expect(parse(lines.join('\n')).diagnostics, lines.join(' / ')).toEqual([])
    // Nor a VRF whose only route a later `no` removed: nothing names it, so it goes too.
    const removed = parse(`${routeOnly[0]}\nno ip route vrf CUST 10.0.0.0 255.0.0.0`)
    expect(removed.diagnostics).toEqual([])
    expect(removed.model).toEqual({})
  })

  it('names no VRF in its warning: a VRF can share its name with a secret', () => {
    const text = ['snmp-server community CANARY-PLACEHOLDER RO', 'ip route vrf CANARY-PLACEHOLDER 10.0.0.0 255.0.0.0 192.0.2.1'].join('\n')
    expect(parse(text).diagnostics.map((d) => d.code)).toEqual(['iosxe.vrf-created'])
    expect(checkSecrets(plugin, text, ['CANARY-PLACEHOLDER'], { allowances: [] }).leaks).toEqual([])
  })
})

describe('VRF definitions', () => {
  const vrf = (text: string) => parse(text).model.networkInstances?.A

  it('a route distinguisher maps in each form, a later one supersedes it, and "no rd" removes it', () => {
    for (const rd of ['65000:100', '192.0.2.1:100', '4200000000:100']) expect(vrf(`vrf definition A\n rd ${rd}`)).toEqual({ type: 'vrf', routeDistinguisher: rd })
    const result = parse('vrf definition A\n rd 65000:1\n rd 65000:2\n no rd 65000:2')
    expect(result.model.networkInstances?.A).toEqual({ type: 'vrf' })
    expect(result.dispositions.L2).toEqual({ kind: 'ignored-by-design', reason: 'superseded by line 3' })
    expect(result.dispositions.L3).toEqual({ kind: 'ignored-by-design', reason: 'removed by line 4' })
    expect(parse('vrf definition A\n rd 65536:4294967296').dispositions.L2).toMatchObject({ kind: 'unsupported' })
  })

  it('a family with route targets of its own uses only those, as IOS does; one with none inherits the VRF-wide ones', () => {
    // Both families override: the VRF-wide target is in neither.
    const override = parse(['vrf definition A', ' route-target both 65000:1', ' address-family ipv4', '  route-target both 65000:2', ' exit-address-family', ' address-family ipv6', '  route-target both 65000:2', ' exit-address-family'].join('\n'))
    expect(override.model.networkInstances?.A).toEqual({ type: 'vrf', routeTargets: { import: ['65000:2'], export: ['65000:2'] } })
    expect(override.dispositions.L2).toEqual({ kind: 'ignored-by-design', reason: 'overridden by the address families\' own route targets' })
    expect(override.dispositions.L4).toEqual({ kind: 'mapped', fields: ['networkInstances.A.routeTargets.import', 'networkInstances.A.routeTargets.export'] })
    // Neither overrides: both inherit.
    const inherit = parse(['vrf definition A', ' route-target both 65000:1', ' address-family ipv4', ' exit-address-family', ' address-family ipv6', ' exit-address-family'].join('\n'))
    expect(inherit.model.networkInstances?.A).toEqual({ type: 'vrf', routeTargets: { import: ['65000:1'], export: ['65000:1'] } })
    expect(inherit.dispositions.L2).toMatchObject({ kind: 'mapped' })
    // One overrides with the same set the other inherits: they agree, and the VRF-wide statement is in use.
    const mixed = parse(['vrf definition A', ' route-target both 65000:1', ' address-family ipv4', '  route-target both 65000:1', ' exit-address-family', ' address-family ipv6', ' exit-address-family'].join('\n'))
    expect(mixed.model.networkInstances?.A).toEqual({ type: 'vrf', routeTargets: { import: ['65000:1'], export: ['65000:1'] } })
    expect(mixed.dispositions.L2).toMatchObject({ kind: 'mapped' })
    // One overrides with another set: they differ.
    expect(vrf(['vrf definition A', ' route-target both 65000:1', ' address-family ipv4', '  route-target both 65000:2', ' exit-address-family', ' address-family ipv6', ' exit-address-family'].join('\n'))).toEqual({ type: 'vrf' })
    // Overriding one direction only: what the family keeps of the other isn't guessed.
    const partial = parse(['vrf definition A', ' route-target both 65000:1', ' address-family ipv4', '  route-target import 65000:2', ' exit-address-family'].join('\n'))
    expect(partial.model.networkInstances?.A).toEqual({ type: 'vrf' })
    expect(partial.dispositions.L4).toEqual({ kind: 'unsupported', reason: 'an address family overrides the VRF-wide route targets in one direction only, and what it keeps of the other isn\'t certain' })
  })

  it('route targets in each family agree as sets, in any order, and render VRF-wide', () => {
    const text = ['vrf definition A', ' address-family ipv4', '  route-target import 65000:2', '  route-target import 65000:3', '  route-target export 65000:2', ' exit-address-family', ' address-family ipv6', '  route-target import 65000:3', '  route-target both 65000:2', ' exit-address-family'].join('\n')
    const result = parse(text)
    expect(result.model.networkInstances?.A).toEqual({ type: 'vrf', routeTargets: { import: ['65000:2', '65000:3'], export: ['65000:2'] } })
    expect(roundTrips(text)).toEqual([])
    // Written VRF-wide: the model's are the VRF's.
    expect(render(result.model).text).toContain('vrf definition A\n route-target import 65000:2\n route-target import 65000:3\n route-target export 65000:2\n !\n address-family ipv4\n exit-address-family\n!')
    // `no route-target` takes one direction.
    expect(vrf('vrf definition A\n route-target both 65000:1\n no route-target export 65000:1')).toEqual({ type: 'vrf', routeTargets: { import: ['65000:1'] } })
  })

  it('an import or export map beside the route targets, VRF-wide, leaves them out whole, in either order; another VRF keeps its own', () => {
    for (const [def, map] of [['ip vrf A', ' import map FILTER'], ['vrf definition A', ' export map FILTER'], ['ip vrf A', ' export map FILTER']]) {
      for (const lines of [[def, ' rd 65000:1', ' route-target import 65000:1', map], [def, ' rd 65000:1', map, ' route-target import 65000:1']]) {
        const result = parse([...lines, 'vrf definition B', ' route-target import 65000:2'].join('\n'))
        expect(result.model.networkInstances, lines.join(' / ')).toEqual({ A: { type: 'vrf', routeDistinguisher: '65000:1' }, B: { type: 'vrf', routeTargets: { import: ['65000:2'] } } })
        const rt = lines.indexOf(' route-target import 65000:1') + 1
        expect(result.dispositions[`L${rt}`]).toEqual({ kind: 'unsupported', reason: `left out whole: line ${lines.indexOf(map) + 1} about the VRF's route targets isn't converted` })
        expect(render(result.model).text).not.toContain('route-target import 65000:1')
      }
    }
    // A description changes nothing about them.
    expect(vrf('vrf definition A\n description tenant\n route-target import 65000:1')).toEqual({ type: 'vrf', routeTargets: { import: ['65000:1'] } })
  })

  it('"no address-family" removes the family\'s route targets, and leaves out the VRF\'s addresses and routes in it', () => {
    const lines = ['vrf definition A', ' address-family ipv4', '  route-target both 65000:1', ' exit-address-family', ' address-family ipv6', '  route-target both 65000:1', ' exit-address-family', 'vrf definition B', ' address-family ipv4', '  route-target both 65000:9', ' exit-address-family', 'interface GigabitEthernet1', ' vrf forwarding A', ' ip address 192.0.2.1 255.255.255.0', ' ipv6 address 2001:db8::1/64', 'ip route vrf A 10.0.0.0 255.0.0.0 192.0.2.254', 'ipv6 route vrf A ::/0 2001:db8::ff', 'vrf definition A', ' no address-family ipv4']
    const result = parse(lines.join('\n'))
    // The IPv6 family's targets are the VRF's now; B's are untouched.
    expect(result.model.networkInstances?.A).toEqual({ type: 'vrf', routeTargets: { import: ['65000:1'], export: ['65000:1'] }, staticRoutes: { '::/0': { nextHops: { '0': { address: '2001:db8::ff' } } } } })
    expect(result.model.networkInstances?.B).toEqual({ type: 'vrf', routeTargets: { import: ['65000:9'], export: ['65000:9'] } })
    expect(result.model.interfaces?.GigabitEthernet1.subinterfaces?.['0']).toEqual({ networkInstance: 'A', ipv6: { addresses: { '2001:db8::1': { prefixLength: 64 } } } })
    for (const l of ['L2', 'L3']) expect(result.dispositions[l], l).toEqual({ kind: 'ignored-by-design', reason: 'removed by line 19' })
    for (const l of ['L14', 'L16']) expect(result.dispositions[l], l).toEqual({ kind: 'unsupported', reason: 'in an address family of its VRF that line 19 removes: left out' })
    expect(result.dispositions.L19).toEqual({ kind: 'ignored-by-design', reason: 'removes the address family on line 2: nothing to convert' })
    expect(buildLedger(result).complete).toBe(true)
    // The family's route targets don't come back in a render, and a family added again starts clean.
    const again = parse(['vrf definition A', ' address-family ipv4', '  route-target both 65000:1', ' exit-address-family', ' no address-family ipv4', ' address-family ipv4', '  route-target import 65000:2', ' exit-address-family'].join('\n'))
    expect(again.model.networkInstances?.A).toEqual({ type: 'vrf', routeTargets: { import: ['65000:2'] } })
    expect(render(parse('vrf definition A\n address-family ipv4\n  route-target both 65000:1\n exit-address-family\n no address-family ipv4').model).text).not.toContain('route-target')
    expect(parse('vrf definition A\n no address-family ipv6').dispositions.L2).toEqual({ kind: 'ignored-by-design', reason: 'no such address family: nothing to convert' })
  })

  it('route targets that differ between families, or with one not converted, are all left out', () => {
    const differ = parse(['vrf definition A', ' address-family ipv4', '  route-target import 65000:1', ' exit-address-family', ' address-family ipv6', ' exit-address-family'].join('\n'))
    expect(differ.model.networkInstances?.A).toEqual({ type: 'vrf' })
    expect(differ.dispositions.L3).toEqual({ kind: 'unsupported', reason: 'route targets that differ between IPv4 and IPv6: the model holds one set for the VRF' })
    const map = parse(['vrf definition A', ' route-target import 65000:1', ' address-family ipv4', '  import map M', ' exit-address-family'].join('\n'))
    expect(map.model.networkInstances?.A).toEqual({ type: 'vrf' })
    expect(map.dispositions.L2).toEqual({ kind: 'unsupported', reason: 'left out whole: line 4 about the VRF\'s route targets isn\'t converted' })
    expect(map.dispositions.L4).toMatchObject({ kind: 'unsupported' })
  })

  it('a blocker in a removed family goes with it: a family added again with valid targets maps, and round-trips', () => {
    for (const blocker of ['  import map FILTER', '  route-target both auto']) {
      const lines = ['vrf definition A', ' address-family ipv4', blocker, ' exit-address-family', ' no address-family ipv4', ' address-family ipv4', '  route-target both 65000:2', ' exit-address-family']
      const result = parse(lines.join('\n'))
      expect(result.model.networkInstances?.A, blocker).toEqual({ type: 'vrf', routeTargets: { import: ['65000:2'], export: ['65000:2'] } })
      expect(result.dispositions.L3).toEqual({ kind: 'ignored-by-design', reason: 'removed by line 5' })
      expect(result.dispositions.L7).toMatchObject({ kind: 'mapped' })
      expect(roundTrips(lines.join('\n'))).toEqual([])
      expect(render(result.model).text).toContain(' route-target import 65000:2\n route-target export 65000:2\n')
    }
  })

  it('a blocker in a scope still there keeps blocking when another is removed: VRF-wide, or in the other family', () => {
    // VRF-wide, beside a family blocker that is removed.
    const vrfWide = parse(['vrf definition A', ' import map FILTER', ' address-family ipv4', '  route-target both auto', ' exit-address-family', ' no address-family ipv4', ' address-family ipv4', '  route-target both 65000:2', ' exit-address-family'].join('\n'))
    expect(vrfWide.model.networkInstances?.A).toEqual({ type: 'vrf' })
    expect(vrfWide.dispositions.L8).toEqual({ kind: 'unsupported', reason: 'left out whole: line 2 about the VRF\'s route targets isn\'t converted' })
    // In the IPv6 family, with the IPv4 family's blocker removed.
    const otherFamily = parse(['vrf definition A', ' address-family ipv4', '  import map FILTER', ' exit-address-family', ' address-family ipv6', '  route-target both auto', '  route-target both 65000:2', ' exit-address-family', ' no address-family ipv4', ' address-family ipv4', '  route-target both 65000:2', ' exit-address-family'].join('\n'))
    expect(otherFamily.model.networkInstances?.A).toEqual({ type: 'vrf' })
    expect(otherFamily.dispositions.L11).toEqual({ kind: 'unsupported', reason: 'left out whole: line 6 about the VRF\'s route targets isn\'t converted' })
    expect(render(otherFamily.model).text).not.toContain('route-target')
  })

  it('a VRF with no addresses, routes or VPN settings is written alone; the global table has no RD or route targets', () => {
    expect(render({ networkInstances: { A: { type: 'vrf' } } }).text).toBe('vrf definition A\n!\nend\n')
    const result = render({ networkInstances: { default: { routeDistinguisher: '65000:1', routeTargets: { import: ['65000:1'] } } } })
    expect(result.dispositions['networkInstances.default.routeDistinguisher']).toMatchObject({ kind: 'unsupported' })
    expect(result.dispositions['networkInstances.default.routeTargets.import']).toMatchObject({ kind: 'unsupported' })
    expect(result.diagnostics).toEqual([])
  })
})

describe('configuration names that are Object.prototype\'s own (__proto__, constructor, toString)', () => {
  const KEYS = ['__proto__', 'constructor', 'toString']

  it('stay own keys of the model, round-trip, and never touch Object.prototype', () => {
    const prototypeNames = Object.getOwnPropertyNames(Object.prototype).sort()
    // Twice: a polluted prototype would show on the second parse.
    for (let run = 0; run < 2; run++) {
      for (const key of KEYS) {
        const text = [`snmp-server community ${key} RW`, `vrf definition ${key}`, ' rd 65000:1', ' address-family ipv4', ' exit-address-family', 'interface Loopback1', ` vrf forwarding ${key}`, ' ip address 192.0.2.1 255.255.255.255', ` no vrf forwarding ${key}`, ` vrf forwarding ${key}`, ` ip vrf forwarding ${key}`, `ip route vrf ${key} 0.0.0.0 0.0.0.0 192.0.2.1`, `ip route 192.0.2.0 255.255.255.0 192.0.2.9 name ${key}`, 'ntp server constructor', 'logging host toString'].join('\n')
        const result = parse(text)
        const communities = result.model.system?.snmp?.communities ?? {}
        expect(Object.hasOwn(communities, key), key).toBe(true)
        expect(Object.getPrototypeOf(communities)).toBe(Object.prototype)
        expect(communities[key]).toEqual({ access: 'read-write' })
        expect(Object.hasOwn(result.model.networkInstances ?? {}, key)).toBe(true)
        expect(result.model.interfaces?.Loopback1.subinterfaces?.['0']).toEqual({ networkInstance: key })
        expect(Object.keys(result.model.system?.ntp?.servers ?? {})).toEqual(['constructor'])
        expect(Object.keys(result.model.system?.logging?.remoteServers ?? {})).toEqual(['toString'])
        // Through the kit's four checks, against the same model as JSON would carry it.
        const fixture = { name: key, source: text, expectedModel: JSON.parse(JSON.stringify(result.model)) as Device }
        expect(checkFixture(plugin, fixture).flatMap((r) => (r.status === 'failed' ? r.problems : []))).toEqual([])
        expect(plugin.render!(result.model, context).text).toContain(`snmp-server community ${key} RW`)
      }
    }
    expect(Object.getOwnPropertyNames(Object.prototype).sort()).toEqual(prototypeNames)
    expect(({} as Record<string, unknown>).access).toBeUndefined()
  })

  it('in a logging level are not a severity', () => {
    expect(parse('logging host 192.0.2.1\nlogging trap constructor').dispositions.L2).toEqual({ kind: 'unsupported' })
  })
})

describe('the plugin', () => {
  it('loads in the registry as a source and a target', () => {
    const registry = createRegistry([plugin])
    expect(registry.sources().map((p) => p.id)).toEqual(['iosxe'])
    expect(registry.targets().map((p) => p.id)).toEqual(['iosxe'])
  })

  it('knows an IPv6 address from a malformed one', () => {
    const valid = ['2001:db8::53', '2001:db8:0:0:0:0:0:53', '2001:DB8:1:2:3:4:5:6', '::', '::1', 'fe80::', '::ffff:192.0.2.1', '64:ff9b::192.0.2.1', '2001:db8:1:2:3:4:192.0.2.1']
    const malformed = ['2001:db8:::53', '2001:db8:1:2:3:4:5:6:', ':2001:db8::1', '1::2::3', '2001:db8:1:2:3:4:5', '2001:db8:1:2:3:4:5:6:7', '2001:db8::12345', '192.0.2.1', '1.2.3.4::', '::192.0.2', 'g::1', '']
    for (const a of valid) expect(isIpv6(a), a).toBe(true)
    for (const a of malformed) expect(isIpv6(a), a).toBe(false)
  })

  it('converts dotted masks and prefix lengths both ways', () => {
    for (let len = 0; len <= 32; len++) expect(maskLength(lengthMask(len))).toBe(len)
    expect(lengthMask(25)).toBe('255.255.255.128')
    expect(maskLength('255.0.255.0')).toBeNull()
    expect(maskLength('0.0.0.255')).toBeNull()
  })
})

describe('detect', () => {
  const root = fileURLToPath(new URL('../../../fixtures/public/', import.meta.url))
  const whole = (platform: string) => readdirSync(join(root, platform, 'whole')).map((f) => [f, readFileSync(join(root, platform, 'whole', f), 'utf8')] as const)

  it('is sure of whole IOS / IOS-XE configs', () => {
    for (const [name, text] of whole('iosxe')) expect(plugin.detect!(text), name).toBeGreaterThanOrEqual(0.7)
  })

  const every = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? every(join(dir, e.name)) : [join(dir, e.name)]))

  it('scores every Junos file low', () => {
    const files = every(join(root, 'junos'))
    expect(files.length).toBeGreaterThan(200)
    for (const file of files) expect(plugin.detect!(readFileSync(file, 'utf8')), file).toBeLessThan(0.4)
  })

  it('scores whole NX-OS and IOS-XR configs low', () => {
    for (const platform of ['nxos', 'iosxr']) {
      for (const [name, text] of whole(platform)) expect(plugin.detect!(text), `${platform}/${name}`).toBeLessThan(0.4)
    }
  })

  it('scores text that isn\'t a config 0', () => {
    expect(plugin.detect!('')).toBe(0)
    expect(plugin.detect!('Dear team, the meeting is at noon.')).toBe(0)
  })
})

describe('rendering a model from another platform', () => {
  // Junos-shaped: unit 0 with its own description, two addresses and no primary, a reject route, an SNMP client list.
  const model: Device = {
    system: { hostname: 'mx1', snmp: { communities: { PLACEHOLDER: { access: 'read-only', clients: ['192.0.2.0/24'] }, 'PLACEHOLDER-RW': { access: 'read-write', clients: ['198.51.100.0/24'] }, OPEN: {} } }, logging: { remoteServers: { '192.0.2.50': { severity: 'error' }, '192.0.2.51': { severity: 'notice' } } } },
    interfaces: {
      'ge-0/0/0': {
        type: 'ethernet',
        description: 'uplink',
        vlanTagging: true,
        subinterfaces: {
          '0': { description: 'unit 0', ipv4: { addresses: { '192.0.2.1': { prefixLength: 24 }, '198.51.100.1': { prefixLength: 24 } } } },
          '10': { vlanId: 10, ipv6: { addresses: { '2001:db8::1': { prefixLength: 64, primary: true } } } }
        }
      }
    },
    networkInstances: { default: { type: 'default', staticRoutes: { '0.0.0.0/0': { nextHops: { '0': { drop: 'reject' } } }, '192.0.2.128/25': { nextHops: { '0': { address: '192.0.2.2', metric: 5 } } } } } }
  }
  const result = plugin.render!(model, context)

  it('accounts for every populated field', () => {
    const ledger = buildLedger({ tree: [], model, dispositions: {}, diagnostics: [] }, result)
    expect(ledgerProblems(ledger)).toEqual([])
    expect(ledger.target?.strayPaths).toEqual([])
  })

  it('says what IOS can\'t write, and warns where it chose', () => {
    const notRendered = Object.entries(result.dispositions).filter(([, d]) => d.kind === 'unsupported').map(([path]) => path)
    expect(notRendered.sort()).toEqual([
      'interfaces["ge-0/0/0"].subinterfaces["0"].description',
      'networkInstances.default.staticRoutes["0.0.0.0/0"].nextHops["0"].drop',
      'networkInstances.default.staticRoutes["192.0.2.128/25"].nextHops["0"].metric',
      'system.logging.remoteServers["192.0.2.50"].severity',
      'system.logging.remoteServers["192.0.2.51"].severity',
      'system.snmp.communities.PLACEHOLDER.access',
      'system.snmp.communities.PLACEHOLDER.clients',
      'system.snmp.communities["PLACEHOLDER-RW"].access',
      'system.snmp.communities["PLACEHOLDER-RW"].clients'
    ])
    expect(result.diagnostics.map((d) => d.code)).toEqual(['iosxe.primary-chosen', 'iosxe.snmp-community-restricted', 'iosxe.snmp-community-restricted'])
    expect(result.text).toContain(' ip address 192.0.2.1 255.255.255.0\n ip address 198.51.100.1 255.255.255.0 secondary\n')
    expect(result.text).toContain('interface ge-0/0/0.10\n encapsulation dot1Q 10\n ipv6 address 2001:db8::1/64\n')
  })

  it('names no address in its primary-address warning: an address can be a secret elsewhere, such as a community', () => {
    const reused: Device = {
      system: { snmp: { communities: { '192.0.2.1': { access: 'read-only' } } } },
      interfaces: { 'GigabitEthernet0/1': { subinterfaces: { '0': { ipv4: { addresses: { '192.0.2.1': { prefixLength: 24 }, '198.51.100.1': { prefixLength: 24 } } } } } } }
    }
    const rendered = render(reused)
    const warning = rendered.diagnostics.find((d) => d.code === 'iosxe.primary-chosen')!
    expect(warning).toEqual({ severity: 'warning', category: 'semantic', code: 'iosxe.primary-chosen', message: 'No primary address given: the first is written as the primary, the others as secondary.', field: 'interfaces["GigabitEthernet0/1"].subinterfaces["0"].ipv4.addresses' })
    for (const d of rendered.diagnostics) expect(d.message).not.toMatch(/192\.0\.2\.1|198\.51\.100\.1/)
    // The choice is unchanged: the first address is the primary.
    expect(rendered.text).toContain('interface GigabitEthernet0/1\n ip address 192.0.2.1 255.255.255.0\n ip address 198.51.100.1 255.255.255.0 secondary\n')
    // The kit's secrets check on the text it renders to, the community a secret, finds nothing either. (Read back, the
    // first address is marked primary, so the warning itself is checked above, on the foreign model.)
    const { leaks } = checkSecrets(plugin, rendered.text, ['192.0.2.1'], { allowances: [] })
    expect(leaks).toEqual([])
  })

  it('leaves out a community limited to some clients, RO or RW, rather than open it to every client', () => {
    const communities = result.text.split('\n').filter((l) => l.startsWith('snmp-server community'))
    expect(communities).toEqual(['snmp-server community OPEN'])
  })

  it('doesn\'t echo a left-out community\'s name, a secret, in its warning', () => {
    const warnings = result.diagnostics.filter((d) => d.code === 'iosxe.snmp-community-restricted')
    expect(warnings).toHaveLength(2)
    for (const w of warnings) for (const name of ['PLACEHOLDER', 'PLACEHOLDER-RW']) expect(w.message).not.toContain(name)
  })

  it('leaves a field of a later model version unrendered, for the ledger to report', () => {
    const later = { ...model, system: { ...model.system, timezone: 'UTC' } } as Device
    const ledger = buildLedger({ tree: [], model: later, dispositions: {}, diagnostics: [] }, plugin.render!(later, context))
    expect(ledgerProblems(ledger)).toEqual(['unrendered: system.timezone'])
  })

  it('writes every leaf of a fully populated IOS model back', () => {
    const text = readFileSync(fileURLToPath(new URL('./fixtures/interfaces/addresses.cfg', import.meta.url)), 'utf8')
    const parsed = parse(text)
    const rendered = plugin.render!(parsed.model, context)
    const leaves = populatedLeaves(parsed.model).map((l) => l.path)
    const notRendered = leaves.filter((p) => rendered.dispositions[p]?.kind !== 'rendered')
    expect(notRendered).toEqual(['interfaces["GigabitEthernet0/0/0"].type', 'interfaces["GigabitEthernet0/0/1"].type', 'interfaces["GigabitEthernet0/0/1"].vlanTagging', 'interfaces.Loopback0.type', 'interfaces["Port-channel1"].type', 'interfaces["GigabitEthernet0/0/2"].type'])
  })
})

describe('VLANs, switch ports and VLAN interfaces (model 0.4.0)', () => {
  const byText = (text: string) => {
    const result = parse(text)
    return { result, at: (t: string) => result.dispositions[statementsOf(result.tree).find((n) => (n as IosNode).text === t)!.id] }
  }
  const iface = (...children: string[]) => ['vlan 10', 'interface Gi1', ...children].join('\n')
  const switching = (text: string) => parse(text).model.interfaces?.Gi1?.switching

  it('reads a trunk\'s allowed list as IOS does: replaced by a list, all, none or except, changed by add and remove', () => {
    expect(switching(iface(' switchport trunk allowed vlan 10, 20-22,5'))?.allowedVlans).toEqual(['5', '10', '20-22'])
    expect(switching(iface(' switchport trunk allowed vlan all'))?.allowedVlans).toEqual(['1-4094'])
    expect(switching(iface(' switchport trunk allowed vlan none'))?.allowedVlans).toEqual([])
    expect(switching(iface(' switchport trunk allowed vlan except 2-4094'))?.allowedVlans).toEqual(['1'])
    // From every VLAN, IOS's default, when no list came before.
    expect(switching(iface(' switchport trunk allowed vlan remove 1-9,11-4094'))?.allowedVlans).toEqual(['10'])
    expect(switching(iface(' switchport trunk allowed vlan none', ' switchport trunk allowed vlan add 10'))?.allowedVlans).toEqual(['10'])
    const { at } = byText(iface(' switchport trunk allowed vlan 10', ' switchport trunk allowed vlan add 20', ' switchport trunk allowed vlan 30'))
    expect(at('switchport trunk allowed vlan 10')).toEqual({ kind: 'ignored-by-design', reason: 'superseded by line 5' })
    expect(at('switchport trunk allowed vlan add 20')).toEqual({ kind: 'ignored-by-design', reason: 'superseded by line 5' })
  })

  it('flags a malformed VLAN ID or list rather than map it, and keeps the list it had', () => {
    for (const bad of [' switchport access vlan 0', ' switchport trunk native vlan 4095', ' switchport trunk allowed vlan 10,5000', ' switchport trunk allowed vlan add 20-10', ' switchport trunk allowed vlan except']) {
      const { result, at } = byText(iface(' switchport trunk allowed vlan 10', bad))
      expect(at(bad.trim()), bad).toEqual({ kind: 'unsupported', reason: bad.includes('allowed') ? 'not a list of VLAN IDs from 1 to 4094' : 'not a VLAN ID from 1 to 4094' })
      expect(result.model.interfaces?.Gi1?.switching, bad).toEqual({ allowedVlans: ['10'] })
    }
    for (const bad of ['vlan 4095', 'vlan 10-5', 'interface Vlan4095', 'interface Vlan10.5']) expect(parse(bad).dispositions.L1, bad).toEqual({ kind: 'unsupported' })
    // IOS VLAN names are one word.
    expect(parse('vlan 10\n name a b').dispositions.L2).toEqual({ kind: 'unsupported' })
  })

  it('"no" forms remove what they name, and "no switchport" every switch port setting before it', () => {
    expect(switching(iface(' switchport mode trunk', ' switchport trunk native vlan 10', ' no switchport trunk native vlan', ' no switchport mode'))).toEqual({})
    expect(switching(iface(' switchport trunk allowed vlan 10', ' no switchport trunk allowed vlan'))).toEqual({})
    const { result, at } = byText(iface(' switchport mode access', ' switchport access vlan 10', ' no switchport', ' ip address 192.0.2.1 255.255.255.0'))
    expect(result.model.interfaces?.Gi1?.switching).toBeUndefined()
    expect(at('switchport access vlan 10')).toEqual({ kind: 'ignored-by-design', reason: 'removed by line 5, which makes the interface a routed port' })
    expect(at('no switchport')).toEqual({ kind: 'unsupported', reason: 'a routed port: the model has no setting for it' })
  })

  it('a mode the model doesn\'t have replaces the one before it, which is then not converted either', () => {
    for (const dynamic of ['dynamic auto', 'dynamic desirable']) {
      const after = byText(iface(' switchport mode trunk', ` switchport mode ${dynamic}`))
      expect(after.result.model.interfaces?.Gi1?.switching, dynamic).toEqual({})
      expect(after.at('switchport mode trunk')).toEqual({ kind: 'ignored-by-design', reason: 'superseded by line 4' })
      expect(after.at(`switchport mode ${dynamic}`)).toEqual({ kind: 'unsupported', reason: 'a switch port mode the model doesn\'t have (only access and trunk)' })
      expect(render(after.result.model).text).not.toContain('switchport mode')
      // The other order: the later supported mode wins, as on the device.
      const before = byText(iface(` switchport mode ${dynamic}`, ' switchport mode access'))
      expect(before.result.model.interfaces?.Gi1?.switching, dynamic).toEqual({ mode: 'access' })
      expect(before.at(`switchport mode ${dynamic}`)).toEqual({ kind: 'ignored-by-design', reason: 'superseded by line 4' })
      // And its "no" form removes it, leaving no mode.
      const removed = byText(iface(' switchport mode trunk', ` switchport mode ${dynamic}`, ' no switchport mode'))
      expect(removed.result.model.interfaces?.Gi1?.switching, dynamic).toEqual({})
      expect(removed.at(`switchport mode ${dynamic}`)).toEqual({ kind: 'ignored-by-design', reason: 'removed by line 5' })
      expect(removed.at('no switchport mode')).toEqual({ kind: 'ignored-by-design', reason: 'removes the setting on line 4: nothing to convert' })
    }
    // A malformed mode is refused by the device: it replaces nothing.
    expect(switching(iface(' switchport mode trunk', ' switchport mode banana'))).toEqual({ mode: 'trunk' })
  })

  it('never brings back a VLAN "no vlan" deleted: its ports and VLAN interface are left out instead', () => {
    const access = byText(['vlan 10', 'interface Gi1', ' switchport mode access', ' switchport access vlan 10', 'no vlan 10'].join('\n'))
    expect(access.result.model.vlans).toBeUndefined()
    expect(access.result.model.interfaces?.Gi1).toEqual({ type: 'ethernet' })
    expect(access.at('switchport access vlan 10')).toEqual({ kind: 'unsupported', reason: 'left out whole: the switch port uses a VLAN line 5 deletes' })
    expect(access.at('switchport mode access')).toEqual({ kind: 'unsupported', reason: 'left out whole: the switch port uses a VLAN line 5 deletes' })
    expect(access.result.diagnostics).toEqual([])
    expect(render(access.result.model).text).not.toMatch(/vlan 10|switchport/)

    const trunk = byText(['vlan 10', 'interface Gi1', ' switchport trunk allowed vlan 10,20-30', ' switchport trunk native vlan 20', 'no vlan 10'].join('\n'))
    expect(trunk.result.model.interfaces?.Gi1?.switching).toBeUndefined()

    const svi = byText(['vlan 10', 'interface Vlan10', ' ip address 192.0.2.1 255.255.255.0', 'no vlan 10'].join('\n'))
    expect(svi.result.model.interfaces).toEqual({})
    expect(svi.at('interface Vlan10')).toEqual({ kind: 'unsupported', reason: 'left out whole: it routes for a VLAN line 4 deletes' })
    expect(svi.at('ip address 192.0.2.1 255.255.255.0')).toEqual({ kind: 'unsupported', reason: 'left out whole: it routes for a VLAN line 4 deletes' })
    for (const r of [access, trunk, svi]) expect(buildLedger(r.result).complete).toBe(true)
    expect(roundTrips(['vlan 10', 'interface Vlan10', ' ip address 192.0.2.1 255.255.255.0', 'interface Gi1', ' switchport access vlan 10', 'no vlan 10'].join('\n'))).toEqual([])
  })

  it('takes a VLAN defined again, or an access VLAN set after the deletion (IOS creates it), as there', () => {
    const again = parse(['vlan 10', 'no vlan 10', 'vlan 10', 'interface Vlan10', 'interface Gi2', ' switchport trunk allowed vlan 10'].join('\n'))
    expect(again.model.vlans).toEqual({ '10': {} })
    expect(again.model.interfaces?.Vlan10?.subinterfaces?.['0']?.routedVlan).toBe(10)
    expect(again.diagnostics).toEqual([])
    // An access VLAN after "no vlan" creates the VLAN again, for the trunk using it too; before it, it doesn't.
    const recreated = parse(['vlan 10', 'no vlan 10', 'interface Gi1', ' switchport access vlan 10', 'interface Gi2', ' switchport trunk allowed vlan 10'].join('\n'))
    expect(recreated.model.vlans).toEqual({ '10': {} })
    expect(recreated.model.interfaces?.Gi2?.switching).toEqual({ allowedVlans: ['10'] })
    expect(recreated.diagnostics.map((d) => d.code)).toEqual(['iosxe.vlan-created'])
    expect(parse(['vlan 10', 'interface Gi1', ' switchport access vlan 10', 'no vlan 10'].join('\n')).model.interfaces?.Gi1?.switching).toBeUndefined()
  })

  it('removes VLANs with "no vlan", but never a default one', () => {
    const { result, at } = byText(['vlan 10,20', 'vlan 30', ' name THIRTY', 'no vlan 20,30', 'no vlan 1'].join('\n'))
    expect(result.model.vlans).toEqual({ '10': {} })
    expect(at('vlan 10,20')).toEqual({ kind: 'mapped', fields: ['vlans["10"]'] })
    expect(at('name THIRTY')).toEqual({ kind: 'ignored-by-design', reason: 'removed by line 4' })
    expect(at('no vlan 1')).toEqual({ kind: 'ignored-by-design', reason: 'IOS can\'t delete a default VLAN: nothing to convert' })
  })

  it('keeps a VLAN a port or VLAN interface uses but the text doesn\'t define, with a warning that names no value', () => {
    const { result, at } = byText(['interface Gi1', ' switchport access vlan 30', 'interface Gi2', ' switchport trunk allowed vlan 1,40,50-60', 'interface Vlan70'].join('\n'))
    expect(result.model.vlans).toEqual({ '1': {}, '30': {}, '40': {}, '70': {} })
    expect(at('switchport access vlan 30')).toEqual({ kind: 'mapped', fields: ['interfaces.Gi1.switching.accessVlan', 'vlans["30"]'] })
    // VLAN 1 is always there: no warning for it.
    expect(result.diagnostics.map((d) => d.field)).toEqual(['vlans["30"]', 'vlans["40"]', 'vlans["70"]'])
    for (const d of result.diagnostics) {
      expect(d).toMatchObject({ severity: 'warning', category: 'semantic', code: 'iosxe.vlan-created' })
      expect(d.message).not.toMatch(/30|40|70/)
    }
    expect(roundTrips(['interface Gi1', ' switchport access vlan 30'].join('\n'))).toEqual([])
  })

  it('makes a Vlan interface an irb-or-svi routing for its VLAN, and never a switch port', () => {
    const { result, at } = byText(['vlan 10', 'interface Vlan10', ' switchport mode access', ' ip address 192.0.2.1 255.255.255.0'].join('\n'))
    expect(result.model.interfaces?.Vlan10).toEqual({ type: 'irb-or-svi', subinterfaces: { '0': { routedVlan: 10, ipv4: { addresses: { '192.0.2.1': { prefixLength: 24 } } } } } })
    expect(at('switchport mode access')).toEqual({ kind: 'unsupported', reason: 'a VLAN interface routes: it isn\'t a switch port' })
  })

  it('renders VLANs, switch ports and routed VLANs from another platform, or says why not', () => {
    const model: Device = {
      vlans: { '1': {}, '100': { name: 'v100', description: 'users' }, '200': { name: 'two words' } },
      interfaces: {
        Vlan100: { type: 'irb-or-svi', subinterfaces: { '0': { routedVlan: 100, ipv4: { addresses: { '192.0.2.1': { prefixLength: 24 } } } } } },
        irb: { type: 'irb-or-svi', subinterfaces: { '200': { routedVlan: 200 } }, switching: { mode: 'access' } },
        Vlan7: { type: 'irb-or-svi', subinterfaces: { '0': { routedVlan: 200 } } },
        'ge-0/0/1': { type: 'ethernet', switching: { mode: 'trunk', nativeVlan: 100, allowedVlans: ['100', '200-300'] } }
      }
    }
    const rendered = render(model)
    const ledger = buildLedger({ tree: [], model, dispositions: {}, diagnostics: [] }, rendered)
    expect(ledgerProblems(ledger)).toEqual([])
    expect(ledger.target?.strayPaths).toEqual([])
    const skipped = Object.entries(rendered.dispositions).filter(([, d]) => d.kind !== 'rendered').map(([path, d]) => `${d.kind} ${path}`)
    expect(skipped.sort()).toEqual([
      'not-applicable interfaces.Vlan100.type',
      'not-applicable interfaces.Vlan7.type',
      'not-applicable interfaces.irb.type',
      'not-applicable interfaces["ge-0/0/1"].type',
      'not-applicable vlans["1"]',
      'unsupported interfaces.Vlan7.subinterfaces["0"].routedVlan',
      'unsupported interfaces.irb.subinterfaces["200"].routedVlan',
      'unsupported interfaces.irb.switching.mode',
      'unsupported vlans["100"].description',
      'unsupported vlans["200"].name'
    ])
    expect(rendered.text).toContain('vlan 100\n name v100\n!\nvlan 200\n!\n')
    expect(rendered.text).toContain('interface Vlan100\n ip address 192.0.2.1 255.255.255.0\n')
    expect(rendered.text).toContain('interface ge-0/0/1\n switchport\n switchport trunk native vlan 100\n switchport trunk allowed vlan 100,200-300\n switchport mode trunk\n')
    expect(rendered.text).not.toMatch(/^vlan 1$/m)
  })
})

describe('names for ports from another platform (convert mode suggestions)', () => {
  it('names Ethernet by speed and numbers, a channel with a colon', () => {
    expect(plugin.nameInterface?.({ type: 'ethernet', speed: 1000, numbers: [0, 0, 0] })).toBe('GigabitEthernet0/0/0')
    expect(plugin.nameInterface?.({ type: 'ethernet', speed: 10000, numbers: [1, 2, 3, 4] })).toBe('TenGigabitEthernet1/2/3:4')
    expect(plugin.nameInterface?.({ type: 'ethernet', speed: 100000, numbers: [0, 0] })).toBe('HundredGigE0/0')
    expect(plugin.nameInterface?.({ type: 'ethernet', numbers: [0, 0, 0] })).toBeUndefined()
    expect(plugin.nameInterface?.({ type: 'ethernet', speed: 1234, numbers: [0] })).toBeUndefined()
  })

  it('names loopbacks, port-channels, tunnels, VLANs and management port 0 by number', () => {
    expect(plugin.nameInterface?.({ type: 'loopback', numbers: [0] })).toBe('Loopback0')
    expect(plugin.nameInterface?.({ type: 'aggregate', numbers: [2] })).toBe('Port-channel2')
    expect(plugin.nameInterface?.({ type: 'aggregate', numbers: [0] })).toBeUndefined()
    expect(plugin.nameInterface?.({ type: 'tunnel', numbers: [5] })).toBe('Tunnel5')
    expect(plugin.nameInterface?.({ type: 'vlan', numbers: [100] })).toBe('Vlan100')
    // A routed VLAN interface by its VLAN's ID (Junos irb.100 for VLAN 100), once convert describes it so.
    expect(plugin.nameInterface?.({ type: 'irb-or-svi', numbers: [100] })).toBe('Vlan100')
    expect(plugin.nameInterface?.({ type: 'irb-or-svi', numbers: [4095] })).toBeUndefined()
    expect(plugin.nameInterface?.({ type: 'management', numbers: [0] })).toBe('GigabitEthernet0')
    expect(plugin.nameInterface?.({ type: 'management', numbers: [1] })).toBeUndefined()
    expect(plugin.nameInterface?.({ type: 'other', numbers: [1] })).toBeUndefined()
  })

  it('writes a reference to subinterface 0 as the main interface', () => {
    const route = { nextHops: { '0': { address: '192.0.2.2', interface: 'Gi0/0/0.0' } } }
    const model: Device = { system: { ntp: { sourceInterface: 'Gi0/0/1.0' }, logging: { sourceInterface: 'Gi0/0/1.20' } }, networkInstances: { default: { staticRoutes: { '0.0.0.0/0': route } } } }
    const { text } = plugin.render!(model, { modelVersion: MODEL_VERSION })
    expect(text).toContain('ip route 0.0.0.0 0.0.0.0 Gi0/0/0 192.0.2.2\n')
    expect(text).toContain('ntp source Gi0/0/1\n')
    expect(text).toContain('logging source-interface Gi0/0/1.20\n')
  })
})
