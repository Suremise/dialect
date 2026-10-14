// The shared model → NX-OS text, for the phase 1 areas. Every populated leaf of model 0.3 gets a disposition:
// `rendered` with the line it went to, `unsupported` with why (NX-OS can't say it, or this renderer can't yet), or
// `not-applicable` (NX-OS implies it). Fields of a later model version are left without one, so the ledger reports them
// as unrendered rather than this renderer claiming them. The text says everything it relies on: each `feature` a
// written statement needs, and `switchport` or `no switchport` on every Ethernet and port-channel interface, so the
// result doesn't depend on the switch's defaults.
import { fieldPath, isRouteDistinguisher, populatedLeaves, type AddressFamily, type Context, type Device, type Diagnostic, type FieldDisposition, type Interface, type NetworkInstance, type RenderResult, type RouteTargets, type StaticRoute, type Subinterface } from '@dialect/core'
import { featuresFor, VPN_FEATURE } from './features'
import { isSwitchable } from './names'
import { SEVERITY_LEVELS, SNMP_GROUPS } from './parse'

type Segments = readonly (string | number)[]

/** A word NX-OS reads back as one: quoted when it has a space in it. */
const word = (s: string) => (/\s/.test(s) ? `"${s}"` : s)

export function render(model: Device, _context: Context): RenderResult {
  const lines: string[] = []
  const dispositions: Record<string, FieldDisposition> = {}
  const diagnostics: Diagnostic[] = []

  /** Writes a line, marking the fields it says as rendered there. */
  const emit = (line: string, ...fields: Segments[]) => {
    lines.push(line)
    const n = lines.length
    for (const f of fields) dispositions[fieldPath(...f)] = { kind: 'rendered', span: { startLine: n, startColumn: 1, endLine: n, endColumn: line.length + 1 } }
  }
  const separator = () => {
    if (lines.length && lines[lines.length - 1] !== '') lines.push('')
  }
  const skip = (field: Segments, kind: 'unsupported' | 'not-applicable', reason: string) => {
    dispositions[fieldPath(...field)] = { kind, reason }
  }
  /** Every populated leaf under `at` (of `value`), as unsupported: a part the renderer can't write at all. */
  const skipAll = (value: unknown, at: Segments, reason: string) => {
    for (const leaf of populatedLeaves(value, [...at])) dispositions[leaf.path] = { kind: 'unsupported', reason }
  }
  /** An object configured with nothing in it is a leaf of its own (`{}`): mark it with what became of it. */
  const isEmpty = (value: object | undefined) => value !== undefined && populatedLeaves(value, ['x']).every((l) => l.path === 'x')
  const emptyContainer = (value: object | undefined, at: Segments) => {
    if (value !== undefined && isEmpty(value)) skip(at, 'not-applicable', 'configured empty: nothing to write')
  }

  const system = model.system
  if (system) {
    emptyContainer(system, ['system'])
    if (system.hostname !== undefined) emit(`hostname ${system.hostname}`, ['system', 'hostname'])
  }

  // ---- features: before anything that needs them

  const features = new Set(Object.keys(model.interfaces ?? {}).flatMap(featuresFor))
  if (Object.entries(model.networkInstances ?? {}).some(([name, instance]) => name !== 'default' && writesVpn(instance))) features.add(VPN_FEATURE)
  if (features.size) {
    separator()
    for (const feature of [...features].sort()) emit(`feature ${feature}`)
  }

  // ---- DNS

  if (system) {
    const dns = system.dns
    if (system.domainName !== undefined || dns) separator()
    if (system.domainName !== undefined) emit(`ip domain-name ${system.domainName}`, ['system', 'domainName'])
    if (dns) {
      emptyContainer(dns, ['system', 'dns'])
      emptyContainer(dns.servers, ['system', 'dns', 'servers'])
      if (dns.search !== undefined) {
        if (!dns.search.length) skip(['system', 'dns', 'search'], 'not-applicable', 'an empty search list: nothing to write')
        // A leaf-list is one field: marked on its first line.
        dns.search.forEach((domain, i) => emit(`ip domain-list ${domain}`, ...(i === 0 ? [['system', 'dns', 'search']] : [])))
      }
      for (const [address, server] of Object.entries(dns.servers ?? {})) {
        const at = ['system', 'dns', 'servers', address]
        const fields: Segments[] = isEmpty(server) ? [at] : []
        let line = `ip name-server ${address}`
        if (server.networkInstance !== undefined) {
          if (server.networkInstance !== 'default') line += ` use-vrf ${server.networkInstance}`
          fields.push([...at, 'networkInstance'])
        }
        emit(line, ...fields)
      }
    }
  }

  // ---- SNMP, NTP, logging

  if (system) {
    const snmp = system.snmp
    if (snmp) {
      separator()
      emptyContainer(snmp, ['system', 'snmp'])
      emptyContainer(snmp.communities, ['system', 'snmp', 'communities'])
      if (snmp.contact !== undefined) emit(`snmp-server contact ${snmp.contact}`, ['system', 'snmp', 'contact'])
      if (snmp.location !== undefined) emit(`snmp-server location ${snmp.location}`, ['system', 'snmp', 'location'])
      for (const [name, community] of Object.entries(snmp.communities ?? {})) {
        const at = ['system', 'snmp', 'communities', name]
        if (community.clients !== undefined) {
          // Written without its access list, the community would answer every client: leave it out whole.
          skipAll(community, at, 'NX-OS limits a community\'s clients with an access list, which comes with filters: left out rather than open to every client')
          diagnostics.push({ severity: 'warning', category: 'semantic', code: 'nxos.snmp-community-restricted', message: 'An SNMP community limited to some clients needs an access list, so it isn\'t written.', field: fieldPath(...at) })
          continue
        }
        const group = community.access === undefined ? '' : ` group ${SNMP_GROUPS[community.access]}`
        emit(`snmp-server community ${word(name)}${group}`, ...(community.access !== undefined ? [[...at, 'access']] : isEmpty(community) ? [at] : []))
      }
    }

    const ntp = system.ntp
    if (ntp) {
      separator()
      emptyContainer(ntp, ['system', 'ntp'])
      emptyContainer(ntp.servers, ['system', 'ntp', 'servers'])
      for (const [address, server] of Object.entries(ntp.servers ?? {})) {
        const at = ['system', 'ntp', 'servers', address]
        const fields: Segments[] = isEmpty(server) ? [at] : []
        let line = `ntp server ${address}`
        if (server.prefer !== undefined) {
          if (server.prefer) line += ' prefer'
          fields.push([...at, 'prefer'])
        }
        if (server.networkInstance !== undefined) {
          if (server.networkInstance !== 'default') line += ` use-vrf ${server.networkInstance}`
          fields.push([...at, 'networkInstance'])
        }
        if (server.version !== undefined) skip([...at, 'version'], 'unsupported', 'NX-OS doesn\'t set an NTP server\'s version')
        emit(line, ...fields)
      }
      if (ntp.sourceInterface !== undefined) emit(`ntp source-interface ${ntp.sourceInterface}`, ['system', 'ntp', 'sourceInterface'])
    }

    const logging = system.logging
    if (logging) {
      separator()
      emptyContainer(logging, ['system', 'logging'])
      emptyContainer(logging.remoteServers, ['system', 'logging', 'remoteServers'])
      const at = ['system', 'logging']
      for (const [address, server] of Object.entries(logging.remoteServers ?? {})) {
        const s = [...at, 'remoteServers', address]
        const fields: Segments[] = isEmpty(server) ? [s] : []
        let line = `logging server ${address}`
        if (server.severity !== undefined) {
          const level = SEVERITY_LEVELS.indexOf(server.severity)
          if (level >= 0) {
            line += ` ${level}`
            fields.push([...s, 'severity'])
          } else skip([...s, 'severity'], 'unsupported', 'not a syslog severity NX-OS knows')
        }
        if (server.port !== undefined) {
          line += ` port ${server.port}`
          fields.push([...s, 'port'])
        }
        if (server.networkInstance !== undefined) {
          if (server.networkInstance !== 'default') line += ` use-vrf ${server.networkInstance}`
          fields.push([...s, 'networkInstance'])
        }
        if (server.facility !== undefined) {
          line += ` facility ${server.facility}`
          fields.push([...s, 'facility'])
        }
        emit(line, ...fields)
      }
      if (logging.sourceInterface !== undefined) emit(`logging source-interface ${logging.sourceInterface}`, [...at, 'sourceInterface'])
    }
  }

  // ---- VRFs and static routes

  const instances = Object.entries(model.networkInstances ?? {})
  emptyContainer(model.networkInstances, ['networkInstances'])
  // The global table first, then each VRF with its routes inside `vrf context`.
  for (const [name, instance] of instances.filter(([n]) => n === 'default')) renderInstance(name, instance)
  for (const [name, instance] of instances.filter(([n]) => n !== 'default')) renderInstance(name, instance)

  function renderInstance(name: string, instance: NetworkInstance) {
    const at = ['networkInstances', name]
    const isDefault = name === 'default'
    separator()
    let indent = ''
    if (isDefault) {
      if (instance.type !== undefined) skip([...at, 'type'], 'not-applicable', 'the global routing table')
      if (isEmpty(instance)) skip(at, 'not-applicable', 'the global routing table, with nothing in it')
    } else {
      const fields: Segments[] = isEmpty(instance) ? [at] : []
      if (instance.type === 'vrf') fields.push([...at, 'type'])
      else if (instance.type !== undefined) skip([...at, 'type'], 'unsupported', 'NX-OS\'s global table is "default": another instance is a VRF')
      emit(`vrf context ${name}`, ...fields)
      indent = '  '
    }
    if (isDefault) {
      if (instance.routeDistinguisher !== undefined) skip([...at, 'routeDistinguisher'], 'unsupported', 'the global routing table has no route distinguisher')
      if (instance.routeTargets !== undefined) skipAll(instance.routeTargets, [...at, 'routeTargets'], 'the global routing table has no route targets')
    } else if (instance.routeDistinguisher !== undefined) {
      if (isRouteDistinguisher(instance.routeDistinguisher)) emit(`  rd ${instance.routeDistinguisher}`, [...at, 'routeDistinguisher'])
      else skip([...at, 'routeDistinguisher'], 'unsupported', 'not a route distinguisher in the form ASN:nn, IP:nn or ASN4:nn')
    }
    emptyContainer(instance.staticRoutes, [...at, 'staticRoutes'])
    for (const [prefix, route] of Object.entries(instance.staticRoutes ?? {})) renderRoute(indent, prefix, route, [...at, 'staticRoutes', prefix])
    if (!isDefault && instance.routeTargets !== undefined) renderRouteTargets(instance.routeTargets, [...at, 'routeTargets'])
  }

  /** Whether a VRF's route distinguisher or route targets are written: they need `feature bgp`. */
  function writesVpn(instance: NetworkInstance): boolean {
    const targets = instance.routeTargets
    return isRouteDistinguisher(instance.routeDistinguisher) || (['import', 'export'] as const).some((d) => !!targets?.[d]?.length && targets[d].every(isRouteDistinguisher))
  }

  /**
   * A VRF's route targets: NX-OS sets them per address family, and the model's are the VRF's, so they go under both
   * IPv4 and IPv6 unicast. Each list is one field (a leaf-list), marked on its first line.
   */
  function renderRouteTargets(targets: RouteTargets, at: Segments) {
    emptyContainer(targets, at)
    const lists: [direction: 'import' | 'export', values: readonly string[]][] = []
    for (const direction of ['import', 'export'] as const) {
      const values = targets[direction]
      if (values === undefined) continue
      if (!values.length) skip([...at, direction], 'not-applicable', 'an empty list: nothing to write')
      else if (!values.every(isRouteDistinguisher)) skip([...at, direction], 'unsupported', 'a route target not in the form ASN:nn, IP:nn or ASN4:nn')
      else lists.push([direction, values])
    }
    if (!lists.length) return
    for (const family of ['ipv4', 'ipv6']) {
      emit(`  address-family ${family} unicast`)
      for (const [direction, values] of lists) values.forEach((v, i) => emit(`    route-target ${direction} ${v}`, ...(family === 'ipv4' && i === 0 ? [[...at, direction]] : [])))
    }
  }

  function renderRoute(indent: string, prefix: string, route: StaticRoute, at: Segments) {
    const v6 = prefix.includes(':')
    const m = /^(.+)\/(\d+)$/.exec(prefix)
    if (!m || Number(m[2]) > (v6 ? 128 : 32)) {
      skipAll(route, at, 'not a prefix')
      return
    }
    const hops = Object.entries(route.nextHops ?? {})
    emptyContainer(route.nextHops, [...at, 'nextHops'])
    if (isEmpty(route)) skip(at, 'unsupported', 'a route with no next hop')
    let described = false
    for (const [index, hop] of hops) {
      const h = [...at, 'nextHops', index]
      const parts: string[] = []
      const fields: Segments[] = []
      if (hop.drop === 'discard') {
        parts.push('Null0')
        fields.push([...h, 'drop'])
        if (hop.interface !== undefined) skip([...h, 'interface'], 'unsupported', 'a discard route has no interface')
        if (hop.address !== undefined) skip([...h, 'address'], 'unsupported', 'a discard route has no next-hop address')
      } else {
        if (hop.drop !== undefined) skip([...h, 'drop'], 'unsupported', 'NX-OS has no reject route: Null0 discards')
        if (hop.interface !== undefined) {
          parts.push(hop.interface)
          fields.push([...h, 'interface'])
        }
        if (hop.address !== undefined) {
          parts.push(hop.address)
          fields.push([...h, 'address'])
        }
      }
      if (!parts.length) {
        skipAll(hop, h, 'a next hop with no address, interface or discard')
        continue
      }
      if (hop.metric !== undefined) skip([...h, 'metric'], 'unsupported', 'NX-OS static routes have no metric')
      if (route.description !== undefined) {
        parts.push(`name ${word(route.description)}`)
        if (!described) fields.push([...at, 'description'])
        described = true
      }
      if (hop.tag !== undefined) {
        parts.push(`tag ${hop.tag}`)
        fields.push([...h, 'tag'])
      }
      if (hop.preference !== undefined) {
        parts.push(String(hop.preference))
        fields.push([...h, 'preference'])
      }
      emit(`${indent}${v6 ? 'ipv6' : 'ip'} route ${prefix} ${parts.join(' ')}`, ...fields)
    }
    if (route.description !== undefined && !described) skip([...at, 'description'], 'unsupported', 'a route name needs a next hop to go on')
  }

  // ---- interfaces

  for (const [name, iface] of Object.entries(model.interfaces ?? {})) renderInterface(name, iface)
  emptyContainer(model.interfaces, ['interfaces'])

  function renderInterface(name: string, iface: Interface) {
    const at = ['interfaces', name]
    const subs = Object.entries(iface.subinterfaces ?? {})
    const main = iface.subinterfaces?.['0']
    if (iface.type !== undefined) skip([...at, 'type'], 'not-applicable', 'NX-OS gives an interface\'s type by its name')
    if (iface.vlanTagging !== undefined) skip([...at, 'vlanTagging'], 'not-applicable', 'NX-OS tags each subinterface (encapsulation dot1q)')
    emptyContainer(iface.subinterfaces, [...at, 'subinterfaces'])

    // A routed port: an address or a VRF on it, or subinterfaces (which need a routed parent).
    const routed = subs.some(([index, s]) => index !== '0' || s.ipv4 !== undefined || s.ipv6 !== undefined || s.networkInstance !== undefined)
    separator()
    emit(`interface ${name}`, ...(isEmpty(iface) ? [at] : []))
    if (iface.description !== undefined) emit(`  description ${iface.description}`, [...at, 'description'])
    if (isSwitchable(name)) emit(routed ? '  no switchport' : '  switchport')
    if (iface.mtu !== undefined) emit(`  mtu ${iface.mtu}`, [...at, 'mtu'])
    const isMgmt = /^mgmt0$/i.test(name)
    // mgmt0 is always in the management VRF: said, as NX-OS shows it, whether the model says so or not.
    if (isMgmt && main?.networkInstance === undefined) emit('  vrf member management')
    if (main) {
      const sub = [...at, 'subinterfaces', '0']
      if (isEmpty(main)) skip(sub, 'not-applicable', 'NX-OS has no subinterface 0 of its own: the main interface is it')
      if (main.description !== undefined) skip([...sub, 'description'], 'unsupported', 'NX-OS has one description for the main interface')
      if (main.enabled !== undefined) skip([...sub, 'enabled'], 'unsupported', 'NX-OS has one shutdown for the main interface')
      if (main.vlanId !== undefined) skip([...sub, 'vlanId'], 'unsupported', 'NX-OS has no subinterface 0 to tag')
      if (renderMembership(main, sub, isMgmt)) renderAddresses(main, sub)
    }
    if (iface.enabled !== undefined) emit(iface.enabled ? '  no shutdown' : '  shutdown', [...at, 'enabled'])

    for (const [index, sub] of subs) {
      if (index === '0') continue
      const subAt = [...at, 'subinterfaces', index]
      separator()
      emit(`interface ${name}.${index}`, ...(isEmpty(sub) ? [subAt] : []))
      if (sub.description !== undefined) emit(`  description ${sub.description}`, [...subAt, 'description'])
      if (sub.vlanId !== undefined) emit(`  encapsulation dot1q ${sub.vlanId}`, [...subAt, 'vlanId'])
      if (renderMembership(sub, subAt, false)) renderAddresses(sub, subAt)
      if (sub.enabled !== undefined) emit(sub.enabled ? '  no shutdown' : '  shutdown', [...subAt, 'enabled'])
    }
  }

  /**
   * `vrf member V`, before the addresses (on NX-OS it clears those before it). Whether the addresses can follow: in a
   * VRF NX-OS can't put the interface in, they would land in another table, so they are left out with it.
   */
  function renderMembership(sub: Subinterface, at: Segments, isMgmt: boolean): boolean {
    const vrf = sub.networkInstance
    if (vrf === undefined) return true
    const field = [...at, 'networkInstance']
    if (vrf === 'default' && !isMgmt) {
      skip(field, 'not-applicable', 'the global routing table, which interfaces are in unless they say otherwise')
      return true
    }
    let reason: string | undefined
    if (isMgmt && vrf !== 'management') reason = 'mgmt0 is always in the management VRF'
    else if (!isMgmt && vrf === 'management') reason = 'only mgmt0 is in the management VRF'
    else if (!model.networkInstances || !Object.hasOwn(model.networkInstances, vrf)) reason = 'a VRF the model doesn\'t have'
    if (reason === undefined) {
      emit(`  vrf member ${vrf}`, field)
      return true
    }
    skip(field, 'unsupported', reason)
    for (const family of ['ipv4', 'ipv6'] as const) if (sub[family] !== undefined) skipAll(sub[family], [...at, family], `in a VRF NX-OS can't put the interface in (${reason}): left out rather than put in another table`)
    return false
  }

  function renderAddresses(sub: Subinterface, at: Segments) {
    renderFamily(sub.ipv4, [...at, 'ipv4'], 4)
    renderFamily(sub.ipv6, [...at, 'ipv6'], 6)
  }

  function renderFamily(family: AddressFamily | undefined, at: Segments, version: 4 | 6) {
    if (!family) return
    emptyContainer(family, at)
    emptyContainer(family.addresses, [...at, 'addresses'])
    const addresses = Object.entries(family.addresses ?? {}).filter(([address, a]) => {
      if (Number.isInteger(a.prefixLength) && a.prefixLength >= 0 && a.prefixLength <= (version === 4 ? 32 : 128)) return true
      skipAll(a, [...at, 'addresses', address], `not an IPv${version} prefix length`)
      return false
    })
    // NX-OS has one primary address per family; the others are secondary. Without a primary in the model, the first is.
    const primaries = addresses.filter(([, a]) => a.primary)
    const primary = primaries[0]?.[0] ?? addresses[0]?.[0]
    if (addresses.length > 1 && !primaries.length) {
      diagnostics.push({ severity: 'warning', category: 'semantic', code: 'nxos.primary-chosen', message: 'No primary address given: the first is written as the primary, the others as secondary.', field: fieldPath(...at, 'addresses') })
    }
    const ordered = addresses.filter(([a]) => a === primary).concat(addresses.filter(([a]) => a !== primary))
    for (const [address, a] of ordered) {
      const f = [...at, 'addresses', address]
      const isPrimary = address === primary
      const fields: Segments[] = [[...f, 'prefixLength']]
      if (a.primary !== undefined) {
        if (a.primary === isPrimary) fields.push([...f, 'primary'])
        else skip([...f, 'primary'], 'unsupported', 'NX-OS has one primary address')
      }
      emit(`  ${version === 4 ? 'ip' : 'ipv6'} address ${address}/${a.prefixLength}${isPrimary ? '' : ' secondary'}`, ...fields)
    }
    if (family.mtu !== undefined) skip([...at, 'mtu'], 'unsupported', 'NX-OS sets one MTU for the interface, not one per address family')
  }

  return { text: `${lines.join('\n')}\n`, dispositions, diagnostics }
}
