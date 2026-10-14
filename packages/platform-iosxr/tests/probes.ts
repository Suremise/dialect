// The IOS-XR plugin's adapter for the conformance kit's probes (#33, docs/ARCHITECTURE.md, Probes): each probe's
// sources in IOS-XR syntax, which conformance.test.ts gives describeConformance(). Community names here are
// placeholders, as in the fixtures.
import type { ProbeAdapter } from '@dialect/conformance'

const lines = (...l: string[]) => l.join('\n')

/** Routes in VRF A, VRF B and the global table, for the scoping probes; `inA` adds lines inside A's address family. */
const routes = (...inA: string[]) =>
  lines(
    'vrf A',
    '!',
    'vrf B',
    '!',
    'router static',
    ' address-family ipv4 unicast',
    '  10.0.0.0/8 192.0.2.1',
    ' !',
    ' vrf A',
    '  address-family ipv4 unicast',
    '   10.0.0.0/8 192.0.2.1',
    ...inA.map((l) => `   ${l}`),
    '  !',
    ' !',
    ' vrf B',
    '  address-family ipv4 unicast',
    '   10.0.0.0/8 192.0.2.1',
    '  !',
    ' !',
    '!'
  )

/** OSPF in VRFs A and B and the global table, an interface in each; `inA` adds lines inside A's area. */
const ospf = (...inA: string[]) =>
  lines(
    'vrf A',
    '!',
    'vrf B',
    '!',
    ...['A', 'B', ''].flatMap((vrf, i) => [`interface Loopback${i + 1}`, ...(vrf ? [` vrf ${vrf}`] : []), ` ipv4 address 192.0.2.${i + 1} 255.255.255.255`, '!']),
    'router ospf 1',
    ' area 0',
    '  interface Loopback3',
    '  !',
    ' !',
    ...['A', 'B'].flatMap((vrf, i) => [` vrf ${vrf}`, '  area 0', `   interface Loopback${i + 1}`, '   !', ...(vrf === 'A' ? inA.map((l) => `   ${l}`) : []), '  !', ' !']),
    '!'
  )

/** The same BGP neighbor in VRFs A and B and the global table; `inA` adds lines inside A's BGP. */
const bgp = (...inA: string[]) =>
  lines(
    'vrf A',
    '!',
    'vrf B',
    '!',
    'router bgp 65000',
    ' neighbor 192.0.2.2',
    '  remote-as 65001',
    ' !',
    ...['A', 'B'].flatMap((vrf) => [` vrf ${vrf}`, '  neighbor 192.0.2.2', '   remote-as 65001', '  !', ...(vrf === 'A' ? inA.map((l) => `  ${l}`) : []), ' !']),
    '!'
  )

const dns = lines('domain vrf A name-server 192.0.2.53', 'domain vrf B name-server 192.0.2.54', 'domain name-server 192.0.2.55')

export const probes: ProbeAdapter = {
  prototypeKeys: {
    source: (key) =>
      lines(
        `snmp-server community ${key} RO`,
        `vrf ${key}`,
        '!',
        'interface Loopback0',
        ` vrf ${key}`,
        ' ipv4 address 192.0.2.1 255.255.255.255',
        '!',
        `domain list ${key}`,
        `domain vrf ${key} name-server 192.0.2.53`,
        'router bgp 65000',
        ` neighbor-group ${key}`,
        '  remote-as 65001',
        ' !',
        ' neighbor 192.0.2.2',
        `  use neighbor-group ${key}`,
        ' !',
        '!'
      ),
    uses: {
      interface: { notApplicable: 'an IOS-XR interface name is a type and numbers (GigabitEthernet0/0/0/0), which none of the keys is' },
      vrf: true,
      community: true,
      dns: true,
      vlan: { notApplicable: 'IOS-XR\'s Layer 2 (bridge domains) isn\'t converted this phase, so it names no VLAN' },
      'bgp-group': true
    }
  },
  snmpAccess: {
    'read-only': 'snmp-server community PLACEHOLDER RO IPv4 CLIENTS',
    'read-write': 'snmp-server community PLACEHOLDER RW IPv4 CLIENTS'
  },
  negation: {
    address: {
      set: lines('interface Loopback0', ' ipv4 address 192.0.2.1 255.255.255.255'),
      negated: lines('interface Loopback0', ' ipv4 address 192.0.2.1 255.255.255.255', ' no ipv4 address 192.0.2.1 255.255.255.255'),
      path: ['interfaces', 'Loopback0', 'subinterfaces', '0', 'ipv4', 'addresses', '192.0.2.1']
    },
    description: {
      set: lines('interface Loopback0', ' description uplink'),
      negated: lines('interface Loopback0', ' description uplink', ' no description'),
      path: ['interfaces', 'Loopback0', 'description']
    },
    'name-server': {
      set: 'domain name-server 192.0.2.53',
      negated: lines('domain name-server 192.0.2.53', 'no domain name-server 192.0.2.53'),
      path: ['system', 'dns', 'servers', '192.0.2.53']
    },
    'static-route': {
      set: lines('router static', ' address-family ipv4 unicast', '  10.0.0.0/8 192.0.2.1'),
      negated: lines('router static', ' address-family ipv4 unicast', '  10.0.0.0/8 192.0.2.1', '  no 10.0.0.0/8 192.0.2.1'),
      path: ['networkInstances', 'default', 'staticRoutes', '10.0.0.0/8']
    },
    community: {
      set: 'snmp-server community PLACEHOLDER RO',
      negated: lines('snmp-server community PLACEHOLDER RO', 'no snmp-server community PLACEHOLDER'),
      path: ['system', 'snmp', 'communities', 'PLACEHOLDER']
    },
    'bgp-neighbor': {
      set: lines('router bgp 65000', ' neighbor 192.0.2.2', '  remote-as 65001'),
      negated: lines('router bgp 65000', ' neighbor 192.0.2.2', '  remote-as 65001', ' !', ' no neighbor 192.0.2.2'),
      path: ['networkInstances', 'default', 'bgp', 'neighbors', '192.0.2.2']
    },
    'ospf-interface': {
      set: lines('interface Loopback0', '!', 'router ospf 1', ' area 0', '  interface Loopback0'),
      negated: lines('interface Loopback0', '!', 'router ospf 1', ' area 0', '  interface Loopback0', '  !', '  no interface Loopback0'),
      path: ['networkInstances', 'default', 'ospf', 'areas', '0.0.0.0', 'interfaces', 'Loopback0']
    }
  },
  malformed: {
    'ipv4-address': { source: lines('interface Loopback0', ' ipv4 address 192.0.2.256 255.255.255.255'), value: '192.0.2.256' },
    'ipv6-address': { source: lines('interface Loopback0', ' ipv6 address 2001:db8:::1/64'), value: '2001:db8:::1/64' },
    mask: { source: lines('interface Loopback0', ' ipv4 address 192.0.2.1 255.0.255.0'), value: '255.0.255.0' },
    'next-hop': { source: lines('router static', ' address-family ipv4 unicast', '  10.0.0.0/8 192.0.2.300'), value: '192.0.2.300' },
    'as-number': { source: lines('router bgp 65000', ' neighbor 192.0.2.2', '  remote-as 4294967296'), value: '4294967296' },
    'vlan-id': { source: lines('interface GigabitEthernet0/0/0/0.10', ' encapsulation dot1q 4095'), value: '4095' }
  },
  vrfScoping: {
    delete: { base: routes(), changed: lines(routes(), 'no vrf A'), vrf: 'A' },
    dns: { base: dns, changed: lines(dns, 'no domain vrf A name-server 192.0.2.53'), vrf: 'A' },
    'static-route': { base: routes(), changed: routes('no 10.0.0.0/8 192.0.2.1'), vrf: 'A' },
    // A's interface leaves its area; B's and the global table's, the same, stay.
    ospf: { base: ospf(), changed: ospf('no interface Loopback1'), vrf: 'A' },
    bgp: { base: bgp(), changed: bgp('no neighbor 192.0.2.2'), vrf: 'A' }
  }
}
