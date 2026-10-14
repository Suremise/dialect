// Why a statement isn't converted, when the mapper found nothing more particular to say: every `unsupported` statement
// has a reason (#111, as IOS-XR's and Junos's since #109), so the ledger never shows a bare "not converted". The reason
// comes from the keywords of the top-level statement it is in, and is one of the fixed texts below: never a word of the
// configuration, as a value can be a secret.

const AAA = 'users, roles and AAA come later'
const MANAGEMENT = 'management services (SSH, Telnet, NX-API) come later'
const QOS = 'QoS (class and policy maps) comes later'
const DEVICE = 'a device setting the model has no place for'
const FABRIC = 'VXLAN, EVPN and fabric settings come later'

/** By a top-level statement's first keyword. */
const TOP: Readonly<Record<string, string>> = {
  interface: "an interface setting this converter doesn't read yet",
  evpn: FABRIC,
  nv: FABRIC,
  fabric: FABRIC,
  'policy-map': QOS,
  'class-map': QOS,
  vrf: "a VRF setting this converter doesn't read yet",
  line: 'terminal lines come later',
  vdc: 'virtual device contexts come later',
  'object-group': 'object groups come later',
  ntp: "an NTP setting this converter doesn't read yet (keys, access groups, peers)",
  aaa: AAA,
  username: AAA,
  role: AAA,
  userpassphrase: AAA,
  password: AAA,
  'tacacs-server': AAA,
  'radius-server': AAA,
  vlan: "a VLAN setting this converter doesn't read yet",
  system: DEVICE,
  boot: DEVICE,
  hardware: DEVICE,
  cfs: DEVICE,
  configure: DEVICE,
  commit: DEVICE,
  rmon: 'RMON comes later',
  track: 'object tracking comes later',
  'spanning-tree': 'spanning tree comes later',
  vpc: 'vPC comes later',
  lacp: 'a system-wide LACP setting the model has no place for',
  ssh: MANAGEMENT,
  telnet: MANAGEMENT,
  nxapi: MANAGEMENT,
  key: 'key chains come later: the model keeps no keys',
  'control-plane': 'control-plane policing comes later',
  copp: 'control-plane policing comes later',
  logging: 'logging to the console, a file or terminals, and logging options, come later: the model has remote syslog servers',
  'route-map': "a route map statement this converter doesn't read yet",
  'snmp-server': 'an SNMP setting the model has no place for',
  ipv6: 'a global IPv6 setting the model has no place for',
  ip: 'a global IP setting the model has no place for',
  hostname: 'not a hostname this converter reads',
  switchname: 'not a hostname this converter reads'
}

/** By the keyword after `ip`. */
const IP: Readonly<Record<string, string>> = {
  'domain-lookup': 'DNS lookup on the device comes later',
  dns: 'a DNS setting the model has no place for',
  tacacs: AAA,
  radius: AAA,
  arp: 'static ARP entries and ARP inspection come later',
  route: "a static route this converter doesn't read yet",
  'prefix-list': "a prefix list statement this converter doesn't read yet",
  'community-list': "a community list statement this converter doesn't read yet",
  'as-path': "an AS-path list statement this converter doesn't read yet",
  'access-list': "an access list statement this converter doesn't read yet",
  'domain-name': "a DNS setting this converter doesn't read yet",
  'domain-list': "a DNS setting this converter doesn't read yet",
  'name-server': "a DNS setting this converter doesn't read yet",
  pim: 'multicast comes later',
  igmp: 'multicast comes later',
  multicast: 'multicast comes later'
}

/** By the keyword after `router`. */
const ROUTER: Readonly<Record<string, string>> = {
  bgp: "a BGP setting this converter doesn't read yet",
  ospf: "an OSPF setting this converter doesn't read yet",
  ospfv3: 'OSPFv3 comes later: the model has OSPFv2',
  eigrp: 'EIGRP comes later',
  isis: 'IS-IS comes later',
  rip: 'RIP comes later'
}

/** By the keyword after `snmp-server`. */
const SNMP: Readonly<Record<string, string>> = {
  enable: 'SNMP traps come later',
  traps: 'SNMP traps come later',
  host: 'SNMP trap and inform hosts come later',
  user: 'SNMPv3 comes later: the model has SNMP communities',
  'source-interface': 'an SNMP source interface comes later',
  view: 'SNMP views come later'
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
