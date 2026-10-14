// The Junos plugin's adapters for the conformance kit's probes (#33, docs/ARCHITECTURE.md, Probes): every probe's
// sources twice, in set form (`probes`, which conformance.test.ts gives describeConformance()) and in the hierarchical
// form (`hierarchicalProbes`, run beside it), since each form is read its own way. Negation is Junos's `delete` in set
// form (display set input), which takes away the statements before it under its path; the hierarchical form has no
// negation, so there it is the configuration with the setting left out. Community names here are placeholders, as in
// the fixtures.
import type { ProbeAdapter } from '@dialect/conformance'

const lines = (...l: string[]) => l.join('\n') + '\n'

/** VRFs A and B and the global table, each with the same static route, for the scoping probes. */
const routes = lines(
  'set routing-options static route 10.0.0.0/8 next-hop 192.0.2.1',
  ...['A', 'B'].flatMap((vrf, i) => [
    `set routing-instances ${vrf} instance-type vrf`,
    `set routing-instances ${vrf} route-distinguisher 65000:${i + 1}`,
    `set routing-instances ${vrf} vrf-target target:65000:${i + 1}`,
    `set routing-instances ${vrf} routing-options static route 10.0.0.0/8 next-hop 192.0.2.1`
  ])
)

/** OSPF on a unit of its own in the global table, VRF A and VRF B, for the OSPF scoping probe. */
const ospf = lines(
  ...['', 'A', 'B'].flatMap((vrf, i) => [
    `set interfaces ge-0/0/${i} unit 0 family inet address 192.0.2.${i + 1}/24`,
    ...(vrf ? [`set routing-instances ${vrf} instance-type vrf`, `set routing-instances ${vrf} route-distinguisher 65000:${i}`, `set routing-instances ${vrf} vrf-target target:65000:${i}`, `set routing-instances ${vrf} interface ge-0/0/${i}.0`] : []),
    `set ${vrf ? `routing-instances ${vrf} ` : ''}protocols ospf area 0.0.0.0 interface ge-0/0/${i}.0 metric 10`
  ])
)

/** The same BGP neighbor in the global table, VRF A and VRF B, for the BGP scoping probe. */
const bgp = lines(
  ...['', 'A', 'B'].flatMap((vrf, i) => [
    ...(vrf ? [`set routing-instances ${vrf} instance-type vrf`, `set routing-instances ${vrf} route-distinguisher 65000:${i}`, `set routing-instances ${vrf} vrf-target target:65000:${i}`] : []),
    `set ${vrf ? `routing-instances ${vrf} ` : ''}routing-options autonomous-system 65000`,
    `set ${vrf ? `routing-instances ${vrf} ` : ''}protocols bgp group G neighbor 192.0.2.2 peer-as 65001`
  ])
)

/** Name servers in VRF A, VRF B and the global table. */
const dns = lines(
  'set routing-instances A instance-type vrf',
  'set routing-instances B instance-type virtual-router',
  'set system name-server 192.0.2.53 routing-instance A',
  'set system name-server 192.0.2.54 routing-instance B',
  'set system name-server 192.0.2.55'
)

export const probes: ProbeAdapter = {
  prototypeKeys: {
    source: (key) =>
      lines(
        // Junos would want a real interface name (ge-0/0/0); the plugin takes any, so it is probed as one anyway.
        `set interfaces ${key} unit 0 family inet address 192.0.2.1/24`,
        `set routing-instances ${key} instance-type vrf`,
        `set routing-instances ${key} interface ${key}.0`,
        `set routing-instances ${key} route-distinguisher 65000:1`,
        `set routing-instances ${key} vrf-target target:65000:1`,
        `set snmp community ${key} authorization read-only`,
        `set snmp community ${key} clients 192.0.2.0/24`,
        `set system domain-search ${key}`,
        `set system name-server 192.0.2.53 routing-instance ${key}`,
        `set vlans ${key} vlan-id 10`,
        `set interfaces ge-0/0/1 unit 0 family ethernet-switching vlan members ${key}`,
        `set protocols bgp group ${key} type external`,
        `set protocols bgp group ${key} neighbor 192.0.2.2 peer-as 65001`
      ),
    uses: { interface: true, vrf: true, community: true, dns: true, vlan: true, 'bgp-group': true }
  },
  snmpAccess: {
    'read-only': lines('set snmp community PLACEHOLDER authorization read-only', 'set snmp community PLACEHOLDER clients 192.0.2.0/24'),
    'read-write': lines('set snmp community PLACEHOLDER authorization read-write', 'set snmp community PLACEHOLDER clients 192.0.2.0/24')
  },
  negation: {
    address: {
      set: lines('set interfaces ge-0/0/0 unit 0 family inet address 192.0.2.1/24'),
      negated: lines('set interfaces ge-0/0/0 unit 0 family inet address 192.0.2.1/24', 'delete interfaces ge-0/0/0 unit 0 family inet address 192.0.2.1/24'),
      path: ['interfaces', 'ge-0/0/0', 'subinterfaces', '0', 'ipv4', 'addresses', '192.0.2.1']
    },
    description: {
      set: lines('set interfaces ge-0/0/0 description uplink'),
      negated: lines('set interfaces ge-0/0/0 description uplink', 'delete interfaces ge-0/0/0 description'),
      path: ['interfaces', 'ge-0/0/0', 'description']
    },
    'name-server': {
      set: lines('set system name-server 192.0.2.53'),
      negated: lines('set system name-server 192.0.2.53', 'delete system name-server 192.0.2.53'),
      path: ['system', 'dns', 'servers', '192.0.2.53']
    },
    'static-route': {
      set: lines('set routing-options static route 10.0.0.0/8 next-hop 192.0.2.1'),
      negated: lines('set routing-options static route 10.0.0.0/8 next-hop 192.0.2.1', 'delete routing-options static route 10.0.0.0/8'),
      path: ['networkInstances', 'default', 'staticRoutes', '10.0.0.0/8']
    },
    community: {
      set: lines('set snmp community PLACEHOLDER authorization read-only'),
      negated: lines('set snmp community PLACEHOLDER authorization read-only', 'delete snmp community PLACEHOLDER'),
      path: ['system', 'snmp', 'communities', 'PLACEHOLDER']
    },
    'bgp-neighbor': {
      set: lines('set routing-options autonomous-system 65000', 'set protocols bgp group G neighbor 192.0.2.2 peer-as 65001', 'set protocols bgp group G neighbor 192.0.2.3 peer-as 65002'),
      negated: lines('set routing-options autonomous-system 65000', 'set protocols bgp group G neighbor 192.0.2.2 peer-as 65001', 'set protocols bgp group G neighbor 192.0.2.3 peer-as 65002', 'delete protocols bgp group G neighbor 192.0.2.2'),
      path: ['networkInstances', 'default', 'bgp', 'neighbors', '192.0.2.2']
    },
    'ospf-interface': {
      set: lines('set interfaces ge-0/0/0 unit 0 family inet address 192.0.2.1/24', 'set interfaces lo0 unit 0 family inet address 192.0.2.9/32', 'set protocols ospf area 0.0.0.0 interface ge-0/0/0.0', 'set protocols ospf area 0.0.0.0 interface lo0.0 passive'),
      negated: lines('set interfaces ge-0/0/0 unit 0 family inet address 192.0.2.1/24', 'set interfaces lo0 unit 0 family inet address 192.0.2.9/32', 'set protocols ospf area 0.0.0.0 interface ge-0/0/0.0', 'set protocols ospf area 0.0.0.0 interface lo0.0 passive', 'delete protocols ospf area 0.0.0.0 interface ge-0/0/0.0'),
      path: ['networkInstances', 'default', 'ospf', 'areas', '0.0.0.0', 'interfaces', 'ge-0/0/0.0']
    }
  },
  malformed: {
    'ipv4-address': { source: lines('set interfaces ge-0/0/0 unit 0 family inet address 192.0.2.256/24'), value: '192.0.2.256/24' },
    'ipv6-address': { source: lines('set interfaces ge-0/0/0 unit 0 family inet6 address 2001:db8:::1/64'), value: '2001:db8:::1/64' },
    // Junos gives a prefix length, not a mask: one too long for the family is the malformed one.
    mask: { source: lines('set interfaces ge-0/0/0 unit 0 family inet address 192.0.2.1/33'), value: '192.0.2.1/33' },
    'next-hop': { source: lines('set routing-options static route 10.0.0.0/8 next-hop 192.0.2.300'), value: '192.0.2.300' },
    'vlan-id': { source: lines('set vlans V vlan-id 4095'), value: '4095' },
    'as-number': { source: lines('set routing-options autonomous-system 65000', 'set protocols bgp group G neighbor 192.0.2.2 peer-as 4294967296'), value: '4294967296' }
  },
  vrfScoping: {
    delete: { base: routes, changed: routes + lines('delete routing-instances A'), vrf: 'A' },
    ospf: { base: ospf, changed: ospf + lines('delete routing-instances A protocols ospf area 0.0.0.0 interface ge-0/0/1.0 metric'), vrf: 'A' },
    bgp: { base: bgp, changed: bgp + lines('delete routing-instances A protocols bgp group G neighbor 192.0.2.2'), vrf: 'A' },
    dns: { base: dns, changed: dns + lines('delete system name-server 192.0.2.53'), vrf: 'A' },
    'static-route': { base: routes, changed: routes + lines('delete routing-instances A routing-options static route 10.0.0.0/8'), vrf: 'A' }
  }
}

/** Hierarchical Junos from nested [statement, children] pairs: a string is a leaf (`host-name r1;`). */
type Node = string | readonly [string, readonly Node[]]
const tree = (...nodes: Node[]): string => {
  const out: string[] = []
  const write = (n: Node, depth: number) => {
    const indent = '    '.repeat(depth)
    if (typeof n === 'string') return void out.push(`${indent}${n};`)
    out.push(`${indent}${n[0]} {`)
    for (const c of n[1]) write(c, depth + 1)
    out.push(`${indent}}`)
  }
  for (const n of nodes) write(n, 0)
  return out.join('\n') + '\n'
}

const unit0 = (...family: Node[]): Node => ['unit 0', [['family inet', family]]]
const vrf = (name: string, rd: number, ...rest: Node[]): Node => [name, ['instance-type vrf', `route-distinguisher 65000:${rd}`, `vrf-target target:65000:${rd}`, ...rest]]
const route = (...hops: Node[]): Node => ['routing-options', [['static', ['route 10.0.0.0/8 next-hop 192.0.2.1', ...hops]]]]
/** Three units, ge-0/0/0.0 to ge-0/0/2.0, for OSPF in the global table and VRFs A and B. */
const units: Node[] = [0, 1, 2].map((i) => [`ge-0/0/${i}`, [unit0(`address 192.0.2.${i + 1}/24`)]])
const ospfIn = (i: number, metric = 'metric 10'): Node => ['protocols', [['ospf', [['area 0.0.0.0', [[`interface ge-0/0/${i}.0`, [metric]]]]]]]]
const bgpIn = (peerAs = 'peer-as 65001'): Node[] => [['routing-options', ['autonomous-system 65000']], ['protocols', [['bgp', [['group G', [['neighbor 192.0.2.2', [peerAs]]]]]]]]]
const community = (access: string): Node => ['snmp', [['community PLACEHOLDER', [`authorization ${access}`, ['clients', ['192.0.2.0/24']]]]]]

/**
 * The same probes as `probes`, with every source in the hierarchical form, as `show configuration` prints it. That form
 * has no negation (`delete:` belongs to load merge patches, not to a configuration), so a negation case is the
 * configuration before, and after with the setting left out.
 */
export const hierarchicalProbes: ProbeAdapter = {
  prototypeKeys: {
    source: (key) =>
      tree(
        ['interfaces', [[key, [unit0('address 192.0.2.1/24')]], ['ge-0/0/1', [['unit 0', [['family ethernet-switching', [['vlan', [`members ${key}`]]]]]]]]]],
        ['routing-instances', [vrf(key, 1, `interface ${key}.0`)]],
        ['snmp', [[`community ${key}`, ['authorization read-only', ['clients', ['192.0.2.0/24']]]]]],
        ['system', [`domain-search ${key}`, ['name-server', [`192.0.2.53 routing-instance ${key}`]]]],
        ['vlans', [[key, ['vlan-id 10']]]],
        ['protocols', [['bgp', [[`group ${key}`, ['type external', ['neighbor 192.0.2.2', ['peer-as 65001']]]]]]]]
      ),
    uses: { interface: true, vrf: true, community: true, dns: true, vlan: true, 'bgp-group': true }
  },
  snmpAccess: { 'read-only': tree(community('read-only')), 'read-write': tree(community('read-write')) },
  negation: {
    address: {
      set: tree(['interfaces', [['ge-0/0/0', [unit0('address 192.0.2.1/24')]]]]),
      negated: tree(['interfaces', [['ge-0/0/0', [['unit 0', ['family inet']]]]]]),
      path: ['interfaces', 'ge-0/0/0', 'subinterfaces', '0', 'ipv4', 'addresses', '192.0.2.1']
    },
    description: {
      set: tree(['interfaces', [['ge-0/0/0', ['description uplink', 'mtu 9192']]]]),
      negated: tree(['interfaces', [['ge-0/0/0', ['mtu 9192']]]]),
      path: ['interfaces', 'ge-0/0/0', 'description']
    },
    'name-server': {
      set: tree(['system', ['host-name r1', ['name-server', ['192.0.2.53']]]]),
      negated: tree(['system', ['host-name r1']]),
      path: ['system', 'dns', 'servers', '192.0.2.53']
    },
    'static-route': {
      set: tree(route()),
      negated: tree(['routing-options', [['static', ['route 10.1.0.0/16 next-hop 192.0.2.1']]]]),
      path: ['networkInstances', 'default', 'staticRoutes', '10.0.0.0/8']
    },
    community: {
      set: tree(['snmp', ['location lab', ['community PLACEHOLDER', ['authorization read-only']]]]),
      negated: tree(['snmp', ['location lab']]),
      path: ['system', 'snmp', 'communities', 'PLACEHOLDER']
    },
    'bgp-neighbor': {
      set: tree(['routing-options', ['autonomous-system 65000']], ['protocols', [['bgp', [['group G', [['neighbor 192.0.2.2', ['peer-as 65001']], ['neighbor 192.0.2.3', ['peer-as 65002']]]]]]]]),
      negated: tree(['routing-options', ['autonomous-system 65000']], ['protocols', [['bgp', [['group G', [['neighbor 192.0.2.3', ['peer-as 65002']]]]]]]]),
      path: ['networkInstances', 'default', 'bgp', 'neighbors', '192.0.2.2']
    },
    'ospf-interface': {
      set: tree(['interfaces', [['ge-0/0/0', [unit0('address 192.0.2.1/24')]], ['lo0', [unit0('address 192.0.2.9/32')]]]], ['protocols', [['ospf', [['area 0.0.0.0', ['interface ge-0/0/0.0', ['interface lo0.0', ['passive']]]]]]]]),
      negated: tree(['interfaces', [['ge-0/0/0', [unit0('address 192.0.2.1/24')]], ['lo0', [unit0('address 192.0.2.9/32')]]]], ['protocols', [['ospf', [['area 0.0.0.0', [['interface lo0.0', ['passive']]]]]]]]),
      path: ['networkInstances', 'default', 'ospf', 'areas', '0.0.0.0', 'interfaces', 'ge-0/0/0.0']
    }
  },
  malformed: {
    'ipv4-address': { source: tree(['interfaces', [['ge-0/0/0', [unit0('address 192.0.2.256/24')]]]]), value: '192.0.2.256/24' },
    'ipv6-address': { source: tree(['interfaces', [['ge-0/0/0', [['unit 0', [['family inet6', ['address 2001:db8:::1/64']]]]]]]]), value: '2001:db8:::1/64' },
    mask: { source: tree(['interfaces', [['ge-0/0/0', [unit0('address 192.0.2.1/33')]]]]), value: '192.0.2.1/33' },
    'next-hop': { source: tree(['routing-options', [['static', ['route 10.0.0.0/8 next-hop 192.0.2.300']]]]), value: '192.0.2.300' },
    'vlan-id': { source: tree(['vlans', [['V', ['vlan-id 4095']]]]), value: '4095' },
    'as-number': { source: tree(['routing-options', ['autonomous-system 65000']], ['protocols', [['bgp', [['group G', [['neighbor 192.0.2.2', ['peer-as 4294967296']]]]]]]]), value: '4294967296' }
  },
  vrfScoping: {
    delete: {
      base: tree(route(), ['routing-instances', [vrf('A', 1, route()), vrf('B', 2, route())]]),
      changed: tree(route(), ['routing-instances', [vrf('B', 2, route())]]),
      vrf: 'A'
    },
    dns: {
      base: tree(['routing-instances', ['A instance-type vrf', 'B instance-type virtual-router']], ['system', [['name-server', ['192.0.2.53 routing-instance A', '192.0.2.54 routing-instance B', '192.0.2.55']]]]),
      changed: tree(['routing-instances', ['A instance-type vrf', 'B instance-type virtual-router']], ['system', [['name-server', ['192.0.2.54 routing-instance B', '192.0.2.55']]]]),
      vrf: 'A'
    },
    'static-route': {
      base: tree(route(), ['routing-instances', [vrf('A', 1, route()), vrf('B', 2, route())]]),
      changed: tree(route(), ['routing-instances', [vrf('A', 1, ['routing-options', [['static', ['route 10.2.0.0/16 next-hop 192.0.2.1']]]]), vrf('B', 2, route())]]),
      vrf: 'A'
    },
    ospf: {
      base: tree(['interfaces', units], ospfIn(0), ['routing-instances', [vrf('A', 1, 'interface ge-0/0/1.0', ospfIn(1)), vrf('B', 2, 'interface ge-0/0/2.0', ospfIn(2))]]),
      changed: tree(['interfaces', units], ospfIn(0), ['routing-instances', [vrf('A', 1, 'interface ge-0/0/1.0', ospfIn(1, 'metric 20')), vrf('B', 2, 'interface ge-0/0/2.0', ospfIn(2))]]),
      vrf: 'A'
    },
    bgp: {
      base: tree(...bgpIn(), ['routing-instances', [vrf('A', 1, ...bgpIn()), vrf('B', 2, ...bgpIn())]]),
      changed: tree(...bgpIn(), ['routing-instances', [vrf('A', 1, ...bgpIn('peer-as 65009')), vrf('B', 2, ...bgpIn())]]),
      vrf: 'A'
    }
  }
}
