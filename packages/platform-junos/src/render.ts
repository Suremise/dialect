// The shared model → hierarchical Junos, for the phase 1 areas. Every populated leaf of model 0.2 gets a disposition:
// `rendered` with the line it went to, `unsupported` with why (Junos can't say it, or this renderer can't yet), or
// `not-applicable` (Junos implies it). Fields of a later model version are left without one, so the ledger reports
// them as unrendered rather than this renderer claiming them.
//
// Diagnostics never quote the model's keys or values, nor carry a field path with them: a community name is a secret.
import { fieldPath, populatedLeaves, type AddressFamily, type Context, type Device, type Diagnostic, type FieldDisposition, type Interface, type NetworkInstance, type NextHop, type RenderResult, type StaticRoute, type Subinterface } from '@dialect/core'
import { isIpv4, isIpv6, parsePrefix } from './addresses'
import { SEVERITIES } from './parse'
import { quote } from './words'

type Segments = readonly string[]

/** A statement to write: a leaf (`host-name r1;`) or a container, and the fields it says. */
interface Out {
  readonly text: string
  readonly children: Out[] | null
  readonly fields: Segments[]
}

const JUNOS_SEVERITY: Readonly<Record<string, string>> = Object.fromEntries(Object.entries(SEVERITIES).map(([junos, model]) => [model, junos]))
/** The facilities `facility-override` takes. */
const FACILITIES = new Set(['authorization', 'daemon', 'ftp', 'kernel', 'user', 'local0', 'local1', 'local2', 'local3', 'local4', 'local5', 'local6', 'local7'])
const INTEGER = /^\d+$/
const ROUTE_SETTINGS = ['preference', 'metric', 'tag'] as const

export function render(model: Device, _context: Context): RenderResult {
  const dispositions: Record<string, FieldDisposition> = {}
  const diagnostics: Diagnostic[] = []

  const leaf = (text: string, ...fields: Segments[]): Out => ({ text, children: null, fields })
  const box = (text: string, children: Out[], ...fields: Segments[]): Out => ({ text, children, fields })
  const skip = (field: Segments, kind: 'unsupported' | 'not-applicable', reason: string) => {
    dispositions[fieldPath(...field)] = { kind, reason }
  }
  /** Every populated leaf under `at` (of `value`), as unsupported: a part the renderer can't write at all. */
  const skipAll = (value: unknown, at: Segments, reason: string) => {
    for (const l of populatedLeaves(value, [...at])) dispositions[l.path] = { kind: 'unsupported', reason }
  }
  /** An object configured with nothing in it is a leaf of its own (`{}`). */
  const isEmpty = (value: object | undefined) => value !== undefined && populatedLeaves(value, ['x']).every((l) => l.path === 'x')
  const emptyContainer = (value: object | undefined, at: Segments) => {
    if (value !== undefined && isEmpty(value)) skip(at, 'not-applicable', 'configured empty: nothing to write')
  }
  /** The fields to mark on an entry's own statement: the entry itself when it was configured with nothing in it. */
  const self = (value: object, at: Segments): Segments[] => (isEmpty(value) ? [at] : [])

  const top: Out[] = []

  // ---- system: host name, domain, DNS, NTP, syslog

  const system = model.system
  if (system) {
    emptyContainer(system, ['system'])
    const out: Out[] = []
    if (system.hostname !== undefined) out.push(leaf(`host-name ${quote(system.hostname)}`, ['system', 'hostname']))
    if (system.domainName !== undefined) out.push(leaf(`domain-name ${quote(system.domainName)}`, ['system', 'domainName']))
    const dns = system.dns
    if (dns) {
      emptyContainer(dns, ['system', 'dns'])
      emptyContainer(dns.servers, ['system', 'dns', 'servers'])
      if (dns.search !== undefined) {
        if (!dns.search.length) skip(['system', 'dns', 'search'], 'not-applicable', 'an empty search list: nothing to write')
        else out.push(leaf(dns.search.length === 1 ? `domain-search ${quote(dns.search[0])}` : `domain-search [ ${dns.search.map(quote).join(' ')} ]`, ['system', 'dns', 'search']))
      }
      const servers: Out[] = []
      for (const [address, server] of Object.entries(dns.servers ?? {})) {
        const at = ['system', 'dns', 'servers', address]
        if (!isIpv4(address) && !isIpv6(address)) {
          skipAll(server, at, 'a name server that is not an address')
          continue
        }
        const fields = self(server, at)
        let text = address
        if (server.networkInstance !== undefined) {
          text += ` routing-instance ${quote(server.networkInstance)}`
          fields.push([...at, 'networkInstance'])
        }
        servers.push(leaf(text, ...fields))
      }
      if (servers.length) out.push(box('name-server', servers))
    }
    if (system.ntp) out.push(...ntpOf(system.ntp))
    if (system.logging) out.push(...syslogOf(system.logging))
    if (out.length) top.push(box('system', out))
  }

  function ntpOf(ntp: NonNullable<NonNullable<Device['system']>['ntp']>): Out[] {
    const at = ['system', 'ntp']
    emptyContainer(ntp, at)
    emptyContainer(ntp.servers, [...at, 'servers'])
    if (ntp.sourceInterface !== undefined) skip([...at, 'sourceInterface'], 'unsupported', 'Junos sends NTP from a source address, not an interface')
    const servers: Out[] = []
    for (const [address, server] of Object.entries(ntp.servers ?? {})) {
      const s = [...at, 'servers', address]
      const fields = self(server, s)
      let text = `server ${quote(address)}`
      if (server.version !== undefined) {
        text += ` version ${server.version}`
        fields.push([...s, 'version'])
      }
      if (server.prefer !== undefined) {
        if (server.prefer) text += ' prefer'
        fields.push([...s, 'prefer'])
      }
      if (server.networkInstance !== undefined) {
        text += ` routing-instance ${quote(server.networkInstance)}`
        fields.push([...s, 'networkInstance'])
      }
      servers.push(leaf(text, ...fields))
    }
    return servers.length ? [box('ntp', servers)] : []
  }

  function syslogOf(logging: NonNullable<NonNullable<Device['system']>['logging']>): Out[] {
    const at = ['system', 'logging']
    emptyContainer(logging, at)
    emptyContainer(logging.remoteServers, [...at, 'remoteServers'])
    if (logging.sourceInterface !== undefined) skip([...at, 'sourceInterface'], 'unsupported', 'Junos sends syslog from a source address, not an interface')
    const hosts: Out[] = []
    for (const [address, server] of Object.entries(logging.remoteServers ?? {})) {
      const s = [...at, 'remoteServers', address]
      const out: Out[] = []
      if (server.severity !== undefined) {
        if (Object.hasOwn(JUNOS_SEVERITY, server.severity)) out.push(leaf(`any ${JUNOS_SEVERITY[server.severity]}`, [...s, 'severity']))
        else skip([...s, 'severity'], 'unsupported', 'not a syslog severity')
      }
      if (server.facility !== undefined) {
        if (FACILITIES.has(server.facility)) out.push(leaf(`facility-override ${server.facility}`, [...s, 'facility']))
        else skip([...s, 'facility'], 'unsupported', "not a facility Junos's facility-override takes")
      }
      if (server.port !== undefined) out.push(leaf(`port ${server.port}`, [...s, 'port']))
      if (server.networkInstance !== undefined) out.push(leaf(`routing-instance ${quote(server.networkInstance)}`, [...s, 'networkInstance']))
      hosts.push(out.length ? box(`host ${quote(address)}`, out) : leaf(`host ${quote(address)}`, ...self(server, s)))
    }
    return hosts.length ? [box('syslog', hosts)] : []
  }

  // ---- interfaces

  const interfaces: Out[] = []
  for (const [name, iface] of Object.entries(model.interfaces ?? {})) interfaces.push(interfaceOf(name, iface))
  emptyContainer(model.interfaces, ['interfaces'])
  if (interfaces.length) top.push(box('interfaces', interfaces))

  function interfaceOf(name: string, iface: Interface): Out {
    const at = ['interfaces', name]
    const out: Out[] = []
    if (iface.type !== undefined) skip([...at, 'type'], 'not-applicable', "Junos gives an interface's type by its name")
    if (iface.description !== undefined) out.push(leaf(`description ${quote(iface.description)}`, [...at, 'description']))
    if (iface.enabled === false) out.push(leaf('disable', [...at, 'enabled']))
    else if (iface.enabled) skip([...at, 'enabled'], 'not-applicable', 'a Junos interface is enabled unless disabled')
    if (iface.vlanTagging) out.push(leaf('vlan-tagging', [...at, 'vlanTagging']))
    else if (iface.vlanTagging === false) skip([...at, 'vlanTagging'], 'not-applicable', 'a Junos interface is untagged unless vlan-tagging is set')
    if (iface.mtu !== undefined) out.push(leaf(`mtu ${iface.mtu}`, [...at, 'mtu']))
    emptyContainer(iface.subinterfaces, [...at, 'subinterfaces'])
    for (const [index, sub] of Object.entries(iface.subinterfaces ?? {})) {
      const s = [...at, 'subinterfaces', index]
      if (!INTEGER.test(index)) {
        skipAll(sub, s, 'a Junos unit is a number')
        continue
      }
      out.push(unitOf(index, sub, s))
    }
    // An interface with nothing to write but its type is still configured: `ge-0/0/0;`.
    return out.length ? box(quote(name), out) : leaf(quote(name), ...self(iface, at))
  }

  function unitOf(index: string, sub: Subinterface, at: Segments): Out {
    const out: Out[] = []
    if (sub.description !== undefined) out.push(leaf(`description ${quote(sub.description)}`, [...at, 'description']))
    if (sub.enabled === false) out.push(leaf('disable', [...at, 'enabled']))
    else if (sub.enabled) skip([...at, 'enabled'], 'not-applicable', 'a Junos unit is enabled unless disabled')
    if (sub.vlanId !== undefined) out.push(leaf(`vlan-id ${sub.vlanId}`, [...at, 'vlanId']))
    if (sub.ipv4) out.push(familyOf(sub.ipv4, [...at, 'ipv4'], false))
    if (sub.ipv6) out.push(familyOf(sub.ipv6, [...at, 'ipv6'], true))
    return out.length ? box(`unit ${index}`, out) : leaf(`unit ${index}`, ...self(sub, at))
  }

  function familyOf(family: AddressFamily, at: Segments, v6: boolean): Out {
    const out: Out[] = []
    emptyContainer(family.addresses, [...at, 'addresses'])
    if (family.mtu !== undefined) out.push(leaf(`mtu ${family.mtu}`, [...at, 'mtu']))
    for (const [address, a] of Object.entries(family.addresses ?? {})) {
      const f = [...at, 'addresses', address]
      const p = parsePrefix(`${address}/${a.prefixLength}`)
      if (!p || p.v6 !== v6) {
        skipAll(a, f, `not an ${v6 ? 'IPv6' : 'IPv4'} address and prefix length`)
        continue
      }
      if (a.primary === false) skip([...f, 'primary'], 'not-applicable', 'an address is primary only when marked')
      const text = `address ${address}/${a.prefixLength}`
      out.push(a.primary ? box(text, [leaf('primary', [...f, 'primary'])], [...f, 'prefixLength']) : leaf(text, [...f, 'prefixLength']))
    }
    const name = `family ${v6 ? 'inet6' : 'inet'}`
    return out.length ? box(name, out) : leaf(name, ...self(family, at))
  }

  // ---- SNMP

  const snmp = system?.snmp
  if (snmp) {
    const at = ['system', 'snmp']
    emptyContainer(snmp, at)
    emptyContainer(snmp.communities, [...at, 'communities'])
    const out: Out[] = []
    if (snmp.location !== undefined) out.push(leaf(`location ${quote(snmp.location)}`, [...at, 'location']))
    if (snmp.contact !== undefined) out.push(leaf(`contact ${quote(snmp.contact)}`, [...at, 'contact']))
    for (const [name, community] of Object.entries(snmp.communities ?? {})) {
      const c = [...at, 'communities', name]
      const inner: Out[] = []
      if (community.access !== undefined) inner.push(leaf(`authorization ${community.access}`, [...c, 'access']))
      if (community.clients !== undefined) {
        const bad = community.clients.find((client) => !parsePrefix(client) && !isIpv4(client) && !isIpv6(client))
        // Written without its clients, a community would answer every client: leave it out whole instead.
        if (!community.clients.length || bad !== undefined) {
          skipAll(community, c, community.clients.length ? 'a client that is not an address or prefix: left out rather than open to every client' : 'no clients allowed: left out rather than open to every client')
          diagnostics.push({ severity: 'warning', category: 'semantic', code: 'junos.snmp-community-clients', message: "An SNMP community's client list can't be written, so the community isn't written either." })
          continue
        }
        inner.push(box('clients', community.clients.map((client) => leaf(client)), [...c, 'clients']))
      }
      out.push(inner.length ? box(`community ${quote(name)}`, inner) : leaf(`community ${quote(name)}`, ...self(community, c)))
    }
    if (out.length) top.push(box('snmp', out))
  }

  // ---- static routes and routing instances

  const instances: Out[] = []
  emptyContainer(model.networkInstances, ['networkInstances'])
  for (const [name, instance] of Object.entries(model.networkInstances ?? {})) {
    const at = ['networkInstances', name]
    const isDefault = name === 'default'
    const out: Out[] = []
    if (instance.type !== undefined) {
      if (isDefault && instance.type === 'default') skip([...at, 'type'], 'not-applicable', 'the global routing table')
      else if (!isDefault && instance.type === 'vrf') out.push(leaf('instance-type vrf', [...at, 'type']))
      else skip([...at, 'type'], 'unsupported', isDefault ? 'the global routing table is not a VRF' : 'routing instances other than VRFs come later')
    }
    const options = routingOptionsOf(instance, at, isDefault ? '' : `${name}.`)
    if (isDefault) {
      if (options) top.push(options)
      else if (isEmpty(instance)) skip(at, 'not-applicable', 'the global routing table, configured empty')
      continue
    }
    if (options) out.push(options)
    instances.push(out.length ? box(quote(name), out) : leaf(quote(name), ...self(instance, at)))
  }
  if (instances.length) top.push(box('routing-instances', instances))

  function routingOptionsOf(instance: NetworkInstance, at: Segments, rib: string): Out | null {
    emptyContainer(instance.staticRoutes, [...at, 'staticRoutes'])
    const v4: Out[] = []
    const v6: Out[] = []
    for (const [prefix, route] of Object.entries(instance.staticRoutes ?? {})) {
      const r = [...at, 'staticRoutes', prefix]
      const p = parsePrefix(prefix)
      if (!p) {
        skipAll(route, r, 'not a destination prefix')
        continue
      }
      const out = routeOf(prefix, route, r, p.v6)
      if (out) (p.v6 ? v6 : v4).push(out)
    }
    const out: Out[] = []
    if (v4.length) out.push(box('static', v4))
    if (v6.length) out.push(box(`rib ${rib}inet6.0`, [box('static', v6)]))
    return out.length ? box('routing-options', out) : null
  }

  function routeOf(prefix: string, route: StaticRoute, at: Segments, v6: boolean): Out | null {
    if (route.description !== undefined) skip([...at, 'description'], 'unsupported', 'Junos static routes have no description')
    emptyContainer(route.nextHops, [...at, 'nextHops'])
    const hops = Object.entries(route.nextHops ?? {})
    if (!hops.length) {
      if (isEmpty(route)) skip(at, 'unsupported', 'a route with no next hop')
      return null
    }
    const isAddress = (s: string) => (v6 ? isIpv6(s) : isIpv4(s))
    const out: Out[] = []

    // Junos discards or rejects a route's traffic, or forwards it: with other next hops, a drop is left out.
    const drops = hops.filter(([, h]) => h.drop !== undefined)
    const written = hops.length > 1 ? hops.filter(([, h]) => h.drop === undefined) : hops
    if (hops.length > 1) {
      for (const [index, hop] of drops) skipAll(hop, [...at, 'nextHops', index], 'a Junos discard or reject route has no other next hop')
      if (drops.length) diagnostics.push({ severity: 'warning', category: 'semantic', code: 'junos.drop-with-next-hops', message: 'A static route with both a discard or reject and other next hops is written with its other next hops only.' })
    }

    // A setting every hop has, with the same value, is the route's; otherwise each hop that has it says it itself.
    const shared = new Set<string>()
    for (const setting of ROUTE_SETTINGS) {
      const values = written.map(([, h]) => h[setting])
      if (values.length && values[0] !== undefined && values.every((v) => v === values[0])) {
        shared.add(setting)
        out.push(leaf(`${setting} ${values[0]}`, ...written.map(([index]) => [...at, 'nextHops', index, setting])))
      }
    }

    for (const [index, hop] of written) {
      const h = [...at, 'nextHops', index]
      if (hop.drop !== undefined) {
        out.push(leaf(hop.drop, [...h, 'drop']))
        if (hop.address !== undefined) skip([...h, 'address'], 'unsupported', `a ${hop.drop} route has no next-hop address`)
        if (hop.interface !== undefined) skip([...h, 'interface'], 'unsupported', `a ${hop.drop} route has no interface`)
        continue
      }
      if ((hop.address !== undefined && !isAddress(hop.address)) || (hop.address === undefined && hop.interface === undefined)) {
        skipAll(hop, h, hop.address === undefined ? 'a next hop with no address, interface or discard' : "a next-hop address of another family than the route's")
        continue
      }
      out.push(hopOf(hop, h, shared))
    }
    return out.length ? box(`route ${prefix}`, out) : null
  }

  function hopOf(hop: NextHop, at: Segments, shared: ReadonlySet<string>): Out {
    const own = ROUTE_SETTINGS.filter((s) => hop[s] !== undefined && !shared.has(s))
    const target = hop.address ?? hop.interface!
    const targetField = [...at, hop.address !== undefined ? 'address' : 'interface']
    // A plain next hop when it has nothing of its own; a qualified next hop for its own settings or an interface beside its address.
    if (!own.length && (hop.address === undefined || hop.interface === undefined)) return leaf(`next-hop ${quote(target)}`, targetField)
    const inner: Out[] = []
    if (hop.address !== undefined && hop.interface !== undefined) inner.push(leaf(`interface ${quote(hop.interface)}`, [...at, 'interface']))
    for (const s of own) inner.push(leaf(`${s} ${hop[s]}`, [...at, s]))
    return box(`qualified-next-hop ${quote(target)}`, inner, targetField)
  }

  // ---- write it out

  const lines: string[] = []
  const write = (nodes: readonly Out[], depth: number) => {
    const indent = '    '.repeat(depth)
    for (const n of nodes) {
      const line = n.children && n.children.length ? `${indent}${n.text} {` : `${indent}${n.text};`
      lines.push(line)
      const at = lines.length
      for (const f of n.fields) dispositions[fieldPath(...f)] = { kind: 'rendered', span: { startLine: at, startColumn: indent.length + 1, endLine: at, endColumn: line.length + 1 } }
      if (n.children && n.children.length) {
        write(n.children, depth + 1)
        lines.push(`${indent}}`)
      }
    }
  }
  write(top, 0)
  return { text: lines.length ? `${lines.join('\n')}\n` : '', dispositions, diagnostics }
}
