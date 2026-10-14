// The plugin's adapter for the conformance kit's probes (packages/conformance/src/probes.ts, #33): small NX-OS sources
// for each bug class reviews kept finding, which the kit checks the same way as every other platform's.
import type { ProbeAdapter } from '@dialect/conformance'

const lines = (...l: string[]) => l.join('\n')
const iface = (...children: string[]) => lines('interface Ethernet1/1', '  no switchport', ...children)
/** VRFs A and B and the global table, each with the same route, and a name server in A and one in the global table. */
const scoped = lines('vrf context A', '  ip route 10.0.0.0/8 192.0.2.2', 'vrf context B', '  ip route 10.0.0.0/8 192.0.2.3', 'ip route 10.0.0.0/8 192.0.2.1', 'ip name-server 192.0.2.53', 'ip name-server 192.0.2.54 use-vrf A')
/** OSPF in VRFs A and B and the global table: an interface in each, and a stub area in each VRF. */
const ospfScoped = lines(
  'vrf context A',
  'vrf context B',
  ...['A', 'B', ''].flatMap((vrf, i) => [`interface loopback${i + 1}`, ...(vrf ? [`  vrf member ${vrf}`] : []), `  ip address 192.0.2.${i + 1}/32`, '  ip router ospf 1 area 0']),
  'router ospf 1',
  '  router-id 192.0.2.3',
  ...['A', 'B'].flatMap((vrf) => [`  vrf ${vrf}`, '    area 0.0.0.1 stub'])
)
/** The same BGP neighbor in VRFs A and B and the global table. */
const bgpScoped = lines('vrf context A', 'vrf context B', 'router bgp 65000', '  neighbor 192.0.2.2 remote-as 65001', ...['A', 'B'].flatMap((vrf) => [`  vrf ${vrf}`, '    neighbor 192.0.2.2 remote-as 65001']))

/** An access list with entries. */
const acl = (...entries: string[]) => lines('ip access-list F', ...entries)
/** A port-channel with a member link (model 0.5.4). */
const lag = lines('feature lacp', 'interface port-channel1', '  lacp min-links 2', 'interface Ethernet1/1', '  channel-group 1 mode active')
/** A route map with one sequence and what it says. */
const routeMap = (...children: string[]) => lines('route-map M permit 10', ...children)

export const NXOS_PROBES: ProbeAdapter = {
  prototypeKeys: {
    // The key as a community, a VRF (with a route in it) and a DNS name (a search domain, a name server's VRF), in one
    // text: a community value is a secret wherever else it appears.
    source: (key) =>
      lines(
        `snmp-server community ${key} group network-operator`,
        `vrf context ${key}`,
        '  ip route 10.0.0.0/8 192.0.2.1',
        `ip domain-list ${key}`,
        `ip name-server 192.0.2.53 use-vrf ${key}`,
        'vlan 10',
        `  name ${key}`,
        'router bgp 65000',
        `  template peer ${key}`,
        '    remote-as 65001',
        '  neighbor 192.0.2.2',
        `    inherit peer ${key}`
      ),
    uses: { interface: { notApplicable: 'NX-OS names an interface by its type and number (Ethernet1/1): no prototype name is one' }, vrf: true, community: true, dns: true, vlan: true, 'bgp-group': true }
  },
  // Each community limited by an access list, after and before a statement that opens it: either order must leave it
  // out (or limited), never open.
  snmpAccess: {
    'read-only': lines('snmp-server community PLACEHOLDER-RO group network-operator', 'snmp-server community PLACEHOLDER-RO use-ipv4acl ACL', 'snmp-server community PLACEHOLDER-RO2 use-ipv4acl ACL', 'snmp-server community PLACEHOLDER-RO2 group network-operator'),
    'read-write': lines('snmp-server community PLACEHOLDER-RW group network-admin', 'snmp-server community PLACEHOLDER-RW use-ipv4acl ACL', 'snmp-server community PLACEHOLDER-RW2 use-ipv4acl ACL', 'snmp-server community PLACEHOLDER-RW2 group network-admin')
  },
  negation: {
    address: { set: iface('  ip address 192.0.2.1/24'), negated: iface('  ip address 192.0.2.1/24', '  no ip address'), path: ['interfaces', 'Ethernet1/1', 'subinterfaces', '0', 'ipv4', 'addresses', '192.0.2.1'] },
    description: { set: iface('  description uplink'), negated: iface('  description uplink', '  no description'), path: ['interfaces', 'Ethernet1/1', 'description'] },
    'name-server': { set: 'ip name-server 192.0.2.53', negated: lines('ip name-server 192.0.2.53', 'no ip name-server 192.0.2.53'), path: ['system', 'dns', 'servers', '192.0.2.53'] },
    'static-route': { set: 'ip route 10.0.0.0/8 192.0.2.1', negated: lines('ip route 10.0.0.0/8 192.0.2.1', 'no ip route 10.0.0.0/8 192.0.2.1'), path: ['networkInstances', 'default', 'staticRoutes', '10.0.0.0/8'] },
    community: { set: 'snmp-server community PLACEHOLDER group network-operator', negated: lines('snmp-server community PLACEHOLDER group network-operator', 'no snmp-server community PLACEHOLDER'), path: ['system', 'snmp', 'communities', 'PLACEHOLDER'] },
    'bgp-neighbor': { set: lines('router bgp 65000', '  neighbor 192.0.2.2 remote-as 65001'), negated: lines('router bgp 65000', '  neighbor 192.0.2.2 remote-as 65001', '  no neighbor 192.0.2.2'), path: ['networkInstances', 'default', 'bgp', 'neighbors', '192.0.2.2'] },
    'ospf-interface': { set: iface('  ip address 192.0.2.1/24', '  ip router ospf 1 area 0'), negated: iface('  ip address 192.0.2.1/24', '  ip router ospf 1 area 0', '  no ip router ospf 1 area 0'), path: ['networkInstances', 'default', 'ospf', 'areas', '0.0.0.0', 'interfaces', 'Ethernet1/1'] },
    'policy-term': { set: routeMap('  set tag 1'), negated: lines(routeMap('  set tag 1'), 'no route-map M permit 10'), path: ['routingPolicy', 'policies', 'M', 'terms', '10'] },
    'prefix-list-entry': { set: 'ip prefix-list L seq 5 permit 10.0.0.0/8', negated: lines('ip prefix-list L seq 5 permit 10.0.0.0/8', 'no ip prefix-list L seq 5'), path: ['routingPolicy', 'prefixLists', 'ipv4', 'L', 'entries', '5'] },
    'filter-term': { set: acl('  10 permit tcp any any eq 22'), negated: lines(acl('  10 permit tcp any any eq 22'), acl('  no 10')), path: ['filters', 'ipv4', 'F', 'terms', '10'] },
    'filter-attachment': { set: lines(acl('  10 permit ip any any'), iface('  ip address 192.0.2.1/24', '  ip access-group F in')), negated: lines(acl('  10 permit ip any any'), iface('  ip address 192.0.2.1/24', '  ip access-group F in', '  no ip access-group F in')), path: ['interfaces', 'Ethernet1/1', 'subinterfaces', '0', 'filters', 'ipv4', 'input'] },
    // Model 0.5.4: a member link taken out of its channel group.
    'aggregate-member': { set: lag, negated: lines(lag, '  no channel-group'), path: ['interfaces', 'Ethernet1/1', 'aggregate'] }
  },
  malformed: {
    'ipv4-address': { source: iface('  ip address 999.1.1.1/24'), value: '999.1.1.1' },
    'ipv6-address': { source: iface('  ipv6 address dead::beef::1/64'), value: 'dead::beef::1' },
    mask: { source: iface('  ip address 192.0.2.1/33'), value: '192.0.2.1/33' },
    // Letter-led, so it can't pass for an interface name either (the numeric and stray-word ones are in plugin.test.ts).
    'next-hop': { source: 'ipv6 route 2001:db8::/32 dead::beef::bad', value: 'dead::beef::bad' },
    'as-number': { source: lines('router bgp 65000', '  neighbor 192.0.2.2 remote-as 4294967296'), value: '4294967296' },
    'vlan-id': { source: lines('vlan 4095', 'interface Ethernet1/2', '  switchport access vlan 4095'), value: '4095' },
    prefix: { source: 'ip prefix-list L seq 5 permit 10.0.0.1/8', value: '10.0.0.1/8' },
    'prefix-length': { source: 'ip prefix-list L seq 5 permit 10.0.0.0/8 le 33', value: '33' },
    port: { source: acl('  10 permit tcp any any eq 70000'), value: '70000' },
    'filter-prefix': { source: acl('  10 permit ip 999.1.1.0/24 any'), value: '999.1.1.0/24' },
    // Non-contiguous: never approximated as a prefix.
    wildcard: { source: acl('  10 permit ip 10.0.0.0 0.255.0.255 any'), value: '0.255.0.255' },
    // Model 0.5.4: no links, and a channel group past the highest (#110).
    'min-links': { source: lines('feature lacp', 'interface port-channel1', '  lacp min-links 0'), value: '0', line: 3 },
    'aggregate-number': { source: lines('interface Ethernet1/1', '  channel-group 4097'), value: '4097', line: 2 }
  },
  vrfScoping: {
    delete: { base: scoped, changed: lines(scoped, 'no vrf context A'), vrf: 'A' },
    // The global table's server named as if in A, and A's own: only A's goes.
    dns: { base: scoped, changed: lines(scoped, 'no ip name-server 192.0.2.53 use-vrf A', 'no ip name-server 192.0.2.54 use-vrf A'), vrf: 'A' },
    'static-route': { base: scoped, changed: lines(scoped, 'vrf context A', '  no ip route 10.0.0.0/8 192.0.2.2'), vrf: 'A' },
    // A's stub area and its interface go; B's and the global table's, the same, stay.
    ospf: { base: ospfScoped, changed: lines(ospfScoped, 'router ospf 1', '  vrf A', '    no area 0.0.0.1 stub', 'interface loopback1', '  no ip router ospf 1 area 0'), vrf: 'A' },
    bgp: { base: bgpScoped, changed: lines(bgpScoped, 'router bgp 65000', '  vrf A', '    no neighbor 192.0.2.2'), vrf: 'A' }
  },
  // Model 0.5.0: a route map naming lists the text never defines, and a neighbor naming a route map it never defines.
  unknownReference: {
    'prefix-list': { source: routeMap('  match ip address prefix-list NOPE'), value: 'NOPE' },
    'community-set': { source: routeMap('  match community NOPE'), value: 'NOPE' },
    'as-path-set': { source: routeMap('  match as-path NOPE'), value: 'NOPE' },
    policy: { source: lines('router bgp 65000', '  neighbor 192.0.2.2', '    remote-as 65001', '    address-family ipv4 unicast', '      route-map NOPE in'), value: 'NOPE' },
    // Model 0.5.1: an interface applying an access list the text never defines.
    filter: { source: iface('  ip address 192.0.2.1/24', '  ip access-group NOPE in'), value: 'NOPE' },
    // Model 0.5.4: the port-channel a channel group names is made, as NX-OS makes it.
    aggregate: { source: lines('feature lacp', 'interface Ethernet1/1', '  channel-group 7 mode active'), value: 'port-channel7' }
  },
  // Model 0.5.1: an access list, which ends in NX-OS's implicit deny.
  implicitAction: { source: acl('  10 permit tcp any any eq 22') },
  regex: { source: lines('ip as-path access-list P seq 10 permit "_65000_"', 'ip community-list expanded C seq 10 permit "^65000:[0-9]+$"'), regexes: ['_65000_', '^65000:[0-9]+$'] }
}
