// Why a statement isn't converted, when the mapper found nothing more particular to say: every `unsupported` statement
// has a reason (#111, as IOS-XR's and Junos's since #109), so the ledger never shows a bare "not converted". The reason
// comes from the keywords of the top-level statement it is in, and is one of the fixed texts below: never a word of the
// configuration, as a value can be a secret.

const AAA = 'users, passwords and AAA come later'
const MANAGEMENT = 'management services (SSH, HTTP, NETCONF, RESTCONF, SCP) come later'
const QOS = 'QoS (class, policy and table maps) comes later'
const DEVICE = 'a device setting the model has no place for'
const MPLS = 'MPLS comes later'
const SECURITY = 'zone-based firewall, NAT and admission control come later'
const VOICE = 'voice and call control come later'
const DISCOVERY = 'CDP and LLDP come later'
const LINES = 'terminal lines come later'
const L2 = 'a Layer 2 setting the model has no place for (spanning tree, VTP)'

/** By a top-level statement's first keyword. */
const TOP: Readonly<Record<string, string>> = {
  interface: "an interface setting this converter doesn't read yet",
  line: LINES,
  crypto: 'crypto settings come later: the model keeps no keys',
  certificate: 'crypto settings come later: the model keeps no keys',
  key: 'key chains come later: the model keeps no keys',
  'policy-map': QOS,
  'class-map': QOS,
  'table-map': QOS,
  logging: 'logging to the console, the buffer or terminals, and logging options, come later: the model has remote syslog hosts',
  'object-group': 'object groups come later',
  object: 'object groups come later',
  service: DEVICE,
  'spanning-tree': L2,
  vtp: L2,
  mpls: MPLS,
  username: AAA,
  enable: AAA,
  password: AAA,
  aaa: AAA,
  radius: AAA,
  'radius-server': AAA,
  tacacs: AAA,
  'tacacs-server': AAA,
  login: AAA,
  vlan: "a VLAN setting this converter doesn't read yet",
  'boot-start-marker': DEVICE,
  'boot-end-marker': DEVICE,
  boot: DEVICE,
  'control-plane': 'control-plane policing comes later',
  platform: DEVICE,
  license: DEVICE,
  redundancy: DEVICE,
  memory: DEVICE,
  'memory-size': DEVICE,
  diagnostic: DEVICE,
  clock: DEVICE,
  version: DEVICE,
  'hw-module': DEVICE,
  archive: DEVICE,
  multilink: DEVICE,
  arp: 'static ARP entries and ARP access lists come later',
  track: 'object tracking and IP SLA come later',
  'call-home': 'call-home comes later',
  'access-list': "an access list entry this converter doesn't read yet",
  vrf: "a VRF setting this converter doesn't read yet",
  ntp: "an NTP setting this converter doesn't read yet (keys, access groups, peers, masters)",
  cdp: DISCOVERY,
  lldp: DISCOVERY,
  zone: SECURITY,
  'zone-pair': SECURITY,
  'parameter-map': SECURITY,
  gatekeeper: VOICE,
  mgcp: VOICE,
  voice: VOICE,
  'voice-port': VOICE,
  'dial-peer': VOICE,
  'telephony-service': VOICE,
  telemetry: 'model-driven telemetry comes later',
  'netconf-yang': MANAGEMENT,
  restconf: MANAGEMENT,
  iox: 'application hosting comes later',
  'app-hosting': 'application hosting comes later',
  event: 'Embedded Event Manager comes later',
  'event-manager': 'Embedded Event Manager comes later',
  sampler: 'NetFlow comes later',
  flow: 'NetFlow comes later',
  'service-template': AAA,
  subscriber: AAA,
  profile: DEVICE,
  'route-map': "a route map statement this converter doesn't read yet",
  scheduler: DEVICE,
  mmi: DEVICE,
  'snmp-server': 'an SNMP setting the model has no place for',
  ipv6: 'a global IPv6 setting the model has no place for',
  ip: 'a global IP setting the model has no place for',
  hostname: 'not a hostname this converter reads',
  banner: 'a banner: the model has no place for it'
}

/** By the keyword after `ip`. */
const IP: Readonly<Record<string, string>> = {
  nat: SECURITY,
  'auth-proxy': SECURITY,
  admission: SECURITY,
  inspect: SECURITY,
  ssh: MANAGEMENT,
  http: MANAGEMENT,
  scp: MANAGEMENT,
  ftp: MANAGEMENT,
  tftp: MANAGEMENT,
  dhcp: 'DHCP comes later',
  sla: 'object tracking and IP SLA come later',
  'forward-protocol': DEVICE,
  cef: DEVICE,
  classless: DEVICE,
  tcp: DEVICE,
  'source-route': DEVICE,
  'bgp-community': "a BGP community setting this converter doesn't read yet",
  'prefix-list': "a prefix list statement this converter doesn't read yet",
  'community-list': "a community list statement this converter doesn't read yet",
  'as-path': "an AS-path list statement this converter doesn't read yet",
  'access-list': "an access list statement this converter doesn't read yet",
  route: "a static route this converter doesn't read yet",
  domain: "a DNS setting this converter doesn't read yet",
  'domain-name': "a DNS setting this converter doesn't read yet",
  'domain-list': "a DNS setting this converter doesn't read yet",
  'name-server': "a DNS setting this converter doesn't read yet",
  dns: 'a DNS server on the device comes later',
  host: 'static host names come later',
  multicast: 'multicast comes later',
  'multicast-routing': 'multicast comes later',
  pim: 'multicast comes later',
  igmp: 'multicast comes later',
  ospf: "an OSPF setting this converter doesn't read yet",
  vrf: "a VRF setting this converter doesn't read yet",
  'default-gateway': "a default gateway this converter doesn't read yet: give it as a static route",
  flow: 'NetFlow comes later',
  'flow-export': 'NetFlow comes later'
}

/** By the keyword after `router`. */
const ROUTER: Readonly<Record<string, string>> = {
  bgp: "a BGP setting this converter doesn't read yet",
  ospf: "an OSPF setting this converter doesn't read yet",
  ospfv3: 'OSPFv3 comes later: the model has OSPFv2',
  eigrp: 'EIGRP comes later',
  isis: 'IS-IS comes later',
  rip: 'RIP comes later',
  lisp: 'LISP comes later'
}

/** By the keyword after `snmp-server`. */
const SNMP: Readonly<Record<string, string>> = {
  enable: 'SNMP traps come later',
  trap: 'SNMP traps come later',
  traps: 'SNMP traps come later',
  'trap-source': 'SNMP traps come later',
  'trap-timeout': 'SNMP traps come later',
  host: 'SNMP trap and inform hosts come later',
  view: 'SNMP views come later',
  user: 'SNMPv3 comes later: the model has SNMP communities',
  group: 'SNMPv3 comes later: the model has SNMP communities',
  engineid: 'SNMPv3 comes later: the model has SNMP communities',
  vrf: 'SNMP in a VRF comes later'
}

/** Why a statement inside the top-level statement whose lowercased words are `top` isn't converted, from keywords alone. */
export function unconvertedReason(top: readonly string[]): string {
  const [first, second] = top[0] === 'no' || top[0] === 'default' ? top.slice(1) : top
  const pick = (table: Readonly<Record<string, string>>, key: string | undefined) => (key !== undefined && Object.hasOwn(table, key) ? table[key] : undefined)
  if (first === 'router') return pick(ROUTER, second) ?? 'routing protocols other than OSPF and BGP come later'
  if (first === 'snmp-server') return pick(SNMP, second) ?? TOP[first]
  if (first === 'ip') return pick(IP, second) ?? TOP[first]
  return pick(TOP, first) ?? "a statement this converter doesn't read"
}
