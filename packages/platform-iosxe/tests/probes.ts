// The plugin's adapter for the conformance kit's probes (packages/conformance/src/probes.ts, #33): small IOS sources for
// each bug class reviews kept finding, which the kit checks the same way as every other platform's.
import type { ProbeAdapter } from '@dialect/conformance'

const vrf = (name: string) => [`vrf definition ${name}`, ' address-family ipv4', ' exit-address-family']
const lines = (...l: string[]) => l.join('\n')
/** VRFs A and B and the global table, each with the same route, A with a name server and the global table another. */
const scoped = lines(...vrf('A'), ...vrf('B'), 'ip route 10.0.0.0 255.0.0.0 192.0.2.1', 'ip route vrf A 10.0.0.0 255.0.0.0 192.0.2.2', 'ip route vrf B 10.0.0.0 255.0.0.0 192.0.2.3', 'ip name-server 192.0.2.53', 'ip name-server vrf A 192.0.2.54')
const iface = (...children: string[]) => lines('interface GigabitEthernet1', ...children)
/** An interface in the global table, one in A and one in B, each in OSPF (a process each) and each with a BGP neighbor of the same address. */
const routed = lines(
  ...vrf('A'),
  ...vrf('B'),
  'interface GigabitEthernet1',
  ' ip address 192.0.2.1 255.255.255.0',
  'interface GigabitEthernet2',
  ' vrf forwarding A',
  ' ip address 192.0.2.1 255.255.255.0',
  'interface GigabitEthernet3',
  ' vrf forwarding B',
  ' ip address 192.0.2.1 255.255.255.0',
  'router ospf 1',
  ' network 192.0.2.0 0.0.0.255 area 0',
  'router ospf 2 vrf A',
  ' network 192.0.2.0 0.0.0.255 area 0',
  'router ospf 3 vrf B',
  ' network 192.0.2.0 0.0.0.255 area 0',
  'router bgp 65000',
  ' neighbor 192.0.2.2 remote-as 65001',
  ' address-family ipv4 vrf A',
  '  neighbor 192.0.2.2 remote-as 65001',
  ' exit-address-family',
  ' address-family ipv4 vrf B',
  '  neighbor 192.0.2.2 remote-as 65001',
  ' exit-address-family'
)
const bgp = (...children: string[]) => lines('router bgp 65000', ...children)
/** An extended access list with entries. */
const acl = (...entries: string[]) => lines('ip access-list extended F', ...entries)
/** A route map with one sequence and what it says. */
const routeMap = (...children: string[]) => lines('route-map M permit 10', ...children)
/** A Port-channel with a member link (model 0.5.4). */
const lag = lines('interface Port-channel1', ' port-channel min-links 2', 'interface GigabitEthernet1', ' channel-group 1 mode active')
const ospf = (...children: string[]) => lines('interface GigabitEthernet1', ' ip address 192.0.2.1 255.255.255.0', 'router ospf 1', ' network 192.0.2.0 0.0.0.255 area 0', ...children)

export const IOSXE_PROBES: ProbeAdapter = {
  prototypeKeys: {
    // The key as a community, a VRF (with a route in it), a DNS name (a search domain, a name server's VRF), a VLAN's
    // name and a BGP peer group, in one text: a community value is a secret wherever else it appears.
    source: (key) => lines(`snmp-server community ${key} RO`, ...vrf(key), `ip route vrf ${key} 10.0.0.0 255.0.0.0 192.0.2.1`, `ip domain list ${key}`, `ip name-server vrf ${key} 192.0.2.53`, 'vlan 10', ` name ${key}`, 'router bgp 65000', ` neighbor ${key} peer-group`, ` neighbor ${key} remote-as 65001`, ` neighbor 192.0.2.2 peer-group ${key}`),
    uses: { interface: { notApplicable: 'IOS names an interface by its type and number (GigabitEthernet1): no prototype name is one' }, vrf: true, community: true, dns: true, vlan: true, 'bgp-group': true }
  },
  // Each community limited by an access list, before and after a statement that opens it: either order must leave it
  // out (or limited), never open.
  snmpAccess: {
    'read-only': lines('snmp-server community PLACEHOLDER-RO RO', 'snmp-server community PLACEHOLDER-RO RO 10', 'snmp-server community PLACEHOLDER-RO2 RO 10', 'snmp-server community PLACEHOLDER-RO2 RO'),
    'read-write': lines('snmp-server community PLACEHOLDER-RW RW', 'snmp-server community PLACEHOLDER-RW RW 10', 'snmp-server community PLACEHOLDER-RW2 RW 10', 'snmp-server community PLACEHOLDER-RW2 RW')
  },
  negation: {
    address: { set: iface(' ip address 192.0.2.1 255.255.255.0'), negated: iface(' ip address 192.0.2.1 255.255.255.0', ' no ip address'), path: ['interfaces', 'GigabitEthernet1', 'subinterfaces', '0', 'ipv4', 'addresses', '192.0.2.1'] },
    description: { set: iface(' description uplink'), negated: iface(' description uplink', ' no description'), path: ['interfaces', 'GigabitEthernet1', 'description'] },
    'name-server': { set: 'ip name-server 192.0.2.53', negated: lines('ip name-server 192.0.2.53', 'no ip name-server 192.0.2.53'), path: ['system', 'dns', 'servers', '192.0.2.53'] },
    'static-route': { set: 'ip route 10.0.0.0 255.0.0.0 192.0.2.1', negated: lines('ip route 10.0.0.0 255.0.0.0 192.0.2.1', 'no ip route 10.0.0.0 255.0.0.0 192.0.2.1'), path: ['networkInstances', 'default', 'staticRoutes', '10.0.0.0/8'] },
    community: { set: 'snmp-server community PLACEHOLDER RO', negated: lines('snmp-server community PLACEHOLDER RO', 'no snmp-server community PLACEHOLDER'), path: ['system', 'snmp', 'communities', 'PLACEHOLDER'] },
    'bgp-neighbor': { set: bgp(' neighbor 192.0.2.2 remote-as 65001'), negated: bgp(' neighbor 192.0.2.2 remote-as 65001', ' no neighbor 192.0.2.2'), path: ['networkInstances', 'default', 'bgp', 'neighbors', '192.0.2.2'] },
    'ospf-interface': { set: ospf(), negated: ospf(' no network 192.0.2.0 0.0.0.255 area 0'), path: ['networkInstances', 'default', 'ospf', 'areas', '0.0.0.0', 'interfaces', 'GigabitEthernet1'] },
    'policy-term': { set: routeMap(' set tag 1'), negated: lines(routeMap(' set tag 1'), 'no route-map M permit 10'), path: ['routingPolicy', 'policies', 'M', 'terms', '10'] },
    'prefix-list-entry': { set: 'ip prefix-list L seq 5 permit 10.0.0.0/8', negated: lines('ip prefix-list L seq 5 permit 10.0.0.0/8', 'no ip prefix-list L seq 5'), path: ['routingPolicy', 'prefixLists', 'ipv4', 'L', 'entries', '5'] },
    'filter-term': { set: acl(' 10 permit tcp any any eq 22'), negated: lines(acl(' 10 permit tcp any any eq 22'), acl(' no 10')), path: ['filters', 'ipv4', 'F', 'terms', '10'] },
    'filter-attachment': { set: lines(acl(' 10 permit ip any any'), iface(' ip access-group F in')), negated: lines(acl(' 10 permit ip any any'), iface(' ip access-group F in', ' no ip access-group F in')), path: ['interfaces', 'GigabitEthernet1', 'subinterfaces', '0', 'filters', 'ipv4', 'input'] },
    // Model 0.5.4: a member link taken out of its channel group.
    'aggregate-member': { set: lag, negated: lines(lag, ' no channel-group'), path: ['interfaces', 'GigabitEthernet1', 'aggregate'] }
  },
  malformed: {
    'ipv4-address': { source: iface(' ip address 999.1.1.1 255.255.255.0'), value: '999.1.1.1' },
    'ipv6-address': { source: iface(' ipv6 address dead::beef::1/64'), value: 'dead::beef::1' },
    mask: { source: iface(' ip address 192.0.2.1 255.0.255.0'), value: '255.0.255.0' },
    // Letter-led, so it can't pass for an interface name either (the numeric one is in plugin.test.ts).
    'next-hop': { source: 'ipv6 route 2001:db8::/32 dead::beef::bad', value: 'dead::beef::bad' },
    'vlan-id': { source: iface(' switchport mode access', ' switchport access vlan 4095'), value: '4095' },
    'as-number': { source: bgp(' neighbor 192.0.2.2 remote-as 4294967296'), value: '4294967296' },
    prefix: { source: 'ip prefix-list L seq 5 permit 10.0.0.1/8', value: '10.0.0.1/8' },
    'prefix-length': { source: 'ip prefix-list L seq 5 permit 10.0.0.0/8 le 33', value: '33' },
    port: { source: acl(' 10 permit tcp any any eq 70000'), value: '70000' },
    'filter-prefix': { source: acl(' 10 permit ip host 999.1.1.1 any'), value: '999.1.1.1' },
    // Non-contiguous: never approximated as a prefix.
    wildcard: { source: acl(' 10 permit ip 10.0.0.0 0.255.0.255 any'), value: '0.255.0.255' },
    // Model 0.5.4: no links, and a channel group past the highest (#110).
    'min-links': { source: lines('interface Port-channel1', ' port-channel min-links 0'), value: '0', line: 2 },
    'aggregate-number': { source: iface(' channel-group 4097 mode active'), value: '4097', line: 2 }
  },
  vrfScoping: {
    delete: { base: scoped, changed: lines(scoped, 'no vrf definition A'), vrf: 'A' },
    // The global table's server named as if in A, and A's own: only A's goes.
    dns: { base: scoped, changed: lines(scoped, 'no ip name-server vrf A 192.0.2.53', 'no ip name-server vrf A 192.0.2.54'), vrf: 'A' },
    'static-route': { base: scoped, changed: lines(scoped, 'no ip route vrf A 10.0.0.0 255.0.0.0 192.0.2.2'), vrf: 'A' },
    ospf: { base: routed, changed: lines(routed, 'router ospf 2 vrf A', ' passive-interface GigabitEthernet2', ' area 0 authentication'), vrf: 'A' },
    bgp: { base: routed, changed: lines(routed, 'router bgp 65000', ' address-family ipv4 vrf A', '  no neighbor 192.0.2.2', '  neighbor 192.0.2.9 remote-as 65009'), vrf: 'A' }
  },
  // Model 0.5.0: a route map naming lists the text never defines, and a neighbor naming a route map it never defines.
  unknownReference: {
    'prefix-list': { source: routeMap(' match ip address prefix-list NOPE'), value: 'NOPE' },
    'community-set': { source: routeMap(' match community NOPE'), value: 'NOPE' },
    'as-path-set': { source: routeMap(' match as-path 99'), value: '99' },
    policy: { source: bgp(' neighbor 192.0.2.2 remote-as 65001', ' address-family ipv4', '  neighbor 192.0.2.2 route-map NOPE in'), value: 'NOPE' },
    // Model 0.5.1: an interface applying an access list the text never defines.
    filter: { source: iface(' ip address 192.0.2.1 255.255.255.0', ' ip access-group NOPE in'), value: 'NOPE' },
    // Model 0.5.4: the Port-channel a channel group names is made, as IOS makes it.
    aggregate: { source: iface(' channel-group 7 mode active'), value: 'Port-channel7' }
  },
  // Model 0.5.1: an access list, which ends in IOS's implicit deny.
  implicitAction: { source: acl(' 10 permit tcp any any eq 22') },
  regex: { source: lines('ip as-path access-list 10 permit _65000_', 'ip community-list expanded C permit ^65000:[0-9]+$'), regexes: ['_65000_', '^65000:[0-9]+$'] }
}
