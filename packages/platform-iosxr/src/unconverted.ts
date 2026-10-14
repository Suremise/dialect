// Why a statement isn't converted, when the mapper found nothing more particular to say: every `unsupported` statement
// has a reason (#109), so the ledger never shows a bare "not converted". The reason comes from the keywords of the
// top-level statement it is in, and is one of the fixed texts below: never a word of the configuration, as a value can
// be a secret.

const LOGGING = 'logging to the console, the buffer, terminals or an archive, and logging options (facility, prefix, events), come later: the model has remote syslog hosts'
const AAA = 'users, task groups and AAA come later'
const MANAGEMENT = 'management services (SSH, Telnet, NETCONF, gRPC, XML) come later'
const MPLS = 'MPLS and segment routing come later'
const DEVICE = 'a device setting the model has no place for'

/** By a top-level statement's first keyword. */
const TOP: Readonly<Record<string, string>> = {
  interface: 'an interface setting the model has no place for',
  vrf: "a VRF setting this converter doesn't read yet",
  ntp: "an NTP setting this converter doesn't read yet (keys, access groups, peers)",
  domain: 'a DNS setting the model has no place for',
  logging: LOGGING,
  l2vpn: 'Layer 2 VPNs and bridge domains come later',
  evpn: 'EVPN comes later',
  taskgroup: AAA,
  usergroup: AAA,
  username: AAA,
  aaa: AAA,
  'tacacs-server': AAA,
  'radius-server': AAA,
  line: 'terminal lines come later',
  'vty-pool': 'terminal lines come later',
  'policy-map': 'QoS (class and policy maps) comes later',
  'class-map': 'QoS (class and policy maps) comes later',
  'end-policy-map': 'QoS (class and policy maps) comes later',
  'end-class-map': 'QoS (class and policy maps) comes later',
  mpls: MPLS,
  'segment-routing': MPLS,
  rsvp: MPLS,
  'explicit-path': MPLS,
  ssh: MANAGEMENT,
  telnet: MANAGEMENT,
  grpc: MANAGEMENT,
  'netconf-yang': MANAGEMENT,
  netconf: MANAGEMENT,
  xml: MANAGEMENT,
  http: MANAGEMENT,
  service: MANAGEMENT,
  tcp: MANAGEMENT,
  cdp: 'CDP and LLDP come later',
  lldp: 'CDP and LLDP come later',
  'call-home': 'call-home comes later',
  'control-plane': 'control-plane protection comes later',
  lpts: 'control-plane protection comes later',
  bfd: 'BFD comes later',
  'ethernet-services': 'Ethernet services access lists come later',
  'multicast-routing': 'multicast comes later',
  key: 'key chains come later: the model keeps no keys',
  crypto: 'crypto settings come later: the model keeps no keys',
  'snmp-server': 'an SNMP setting the model has no place for',
  ipv4: 'a global IPv4 setting the model has no place for',
  ipv6: 'a global IPv6 setting the model has no place for',
  clock: DEVICE,
  cef: DEVICE,
  nsr: DEVICE,
  fpd: DEVICE,
  'hw-module': DEVICE,
  isolation: DEVICE,
  hostname: 'not a hostname this converter reads'
}

/** By the keyword after `router`. */
const ROUTER: Readonly<Record<string, string>> = {
  bgp: "a BGP setting this converter doesn't read yet",
  ospf: "an OSPF setting this converter doesn't read yet",
  ospfv3: 'OSPFv3 comes later: the model has OSPFv2',
  isis: 'IS-IS comes later',
  static: "a static route setting this converter doesn't read yet",
  hsrp: 'first-hop redundancy (HSRP, VRRP) comes later',
  vrrp: 'first-hop redundancy (HSRP, VRRP) comes later',
  pim: 'multicast comes later',
  igmp: 'multicast comes later',
  mld: 'multicast comes later'
}

/** By the keyword after `snmp-server`. */
const SNMP: Readonly<Record<string, string>> = {
  traps: 'SNMP traps come later',
  host: 'SNMP trap and inform hosts come later',
  vrf: 'SNMP in a VRF comes later',
  view: 'SNMP views come later',
  user: 'SNMPv3 comes later: the model has SNMP communities',
  group: 'SNMPv3 comes later: the model has SNMP communities'
}

/** Why a statement inside the top-level statement whose lowercased words are `top` isn't converted, from keywords alone. */
export function unconvertedReason(top: readonly string[]): string {
  const [first, second] = top[0] === 'no' ? top.slice(1) : top
  const pick = (table: Readonly<Record<string, string>>, key: string | undefined) => (key !== undefined && Object.hasOwn(table, key) ? table[key] : undefined)
  if (first === 'router') return pick(ROUTER, second) ?? 'routing protocols other than OSPF and BGP come later'
  if (first === 'snmp-server') return pick(SNMP, second) ?? TOP[first]
  return pick(TOP, first) ?? "a statement this converter doesn't read"
}
