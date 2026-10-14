// The Junos plugin's adapter for the conformance kit's probes (#33, docs/ARCHITECTURE.md, Probes): each probe's sources
// in Junos set form, which conformance.test.ts gives describeConformance(). Negation is Junos's `delete`, in set form
// (display set input), which takes away the statements before it under its path; the hierarchical form has no
// negation, only a text without the statement. Community names here are placeholders, as in the fixtures.
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
        `set system name-server 192.0.2.53 routing-instance ${key}`
      ),
    uses: { interface: true, vrf: true, community: true, dns: true }
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
    }
  },
  malformed: {
    'ipv4-address': { source: lines('set interfaces ge-0/0/0 unit 0 family inet address 192.0.2.256/24'), value: '192.0.2.256/24' },
    'ipv6-address': { source: lines('set interfaces ge-0/0/0 unit 0 family inet6 address 2001:db8:::1/64'), value: '2001:db8:::1/64' },
    // Junos gives a prefix length, not a mask: one too long for the family is the malformed one.
    mask: { source: lines('set interfaces ge-0/0/0 unit 0 family inet address 192.0.2.1/33'), value: '192.0.2.1/33' },
    'next-hop': { source: lines('set routing-options static route 10.0.0.0/8 next-hop 192.0.2.300'), value: '192.0.2.300' }
  },
  vrfScoping: {
    delete: { base: routes, changed: routes + lines('delete routing-instances A'), vrf: 'A' },
    dns: { base: dns, changed: dns + lines('delete system name-server 192.0.2.53'), vrf: 'A' },
    'static-route': { base: routes, changed: routes + lines('delete routing-instances A routing-options static route 10.0.0.0/8'), vrf: 'A' }
  }
}
