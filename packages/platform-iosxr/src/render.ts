// The shared model → IOS-XR text, for the phase 1 areas, in the shape `show running-config` gives: one-space indents,
// each block closed by `!`. Every populated leaf of model 0.3 gets a disposition: `rendered` with the line it went to,
// `unsupported` with why (IOS-XR can't say it, or this renderer can't yet), or `not-applicable` (IOS-XR implies it).
// Fields of a later model version are left without one, so the ledger reports them as unrendered rather than this
// renderer claiming them.
import { fieldPath, isRouteDistinguisher, populatedLeaves, type AddressFamily, type Context, type Device, type Diagnostic, type FieldDisposition, type Interface, type NetworkInstance, type RenderResult, type RouteTargets, type StaticRoute, type Subinterface, type SyslogSeverity } from '@dialect/core'
import { lengthMask } from './addresses'

type Segments = readonly (string | number)[]

/** IOS-XR's word for each syslog severity, as `logging A severity S` takes it. */
export const SEVERITY_OUT: Readonly<Record<SyslogSeverity, string>> = {
  emergency: 'emergencies',
  alert: 'alerts',
  critical: 'critical',
  error: 'error',
  warning: 'warning',
  notice: 'notifications',
  informational: 'info',
  debug: 'debugging'
}

/** A word IOS-XR reads back as one: quoted when it has a space in it. */
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
  /** `!` after a top-level block, as IOS-XR shows it. */
  const close = (indent = '') => emit(`${indent}!`)

  const system = model.system
  if (system) {
    emptyContainer(system, ['system'])
    if (system.hostname !== undefined) emit(`hostname ${system.hostname}`, ['system', 'hostname'])
    if (system.domainName !== undefined) emit(`domain name ${system.domainName}`, ['system', 'domainName'])
    const dns = system.dns
    if (dns) {
      emptyContainer(dns, ['system', 'dns'])
      emptyContainer(dns.servers, ['system', 'dns', 'servers'])
      if (dns.search !== undefined) {
        if (!dns.search.length) skip(['system', 'dns', 'search'], 'not-applicable', 'an empty search list: nothing to write')
        // A leaf-list is one field: marked on its first line.
        dns.search.forEach((domain, i) => emit(`domain list ${domain}`, ...(i === 0 ? [['system', 'dns', 'search']] : [])))
      }
      for (const [address, server] of Object.entries(dns.servers ?? {})) {
        const at = ['system', 'dns', 'servers', address]
        const fields: Segments[] = isEmpty(server) ? [at] : []
        let vrf = ''
        if (server.networkInstance !== undefined) {
          if (server.networkInstance !== 'default') vrf = `vrf ${server.networkInstance} `
          fields.push([...at, 'networkInstance'])
        }
        emit(`domain ${vrf}name-server ${address}`, ...fields)
      }
    }
    if (lines.length) close()
  }

  // ---- VRFs, before the interfaces that name them

  const instances = Object.entries(model.networkInstances ?? {})
  emptyContainer(model.networkInstances, ['networkInstances'])
  for (const [name, instance] of instances) {
    const at = ['networkInstances', name]
    if (name === 'default') {
      if (instance.type !== undefined) skip([...at, 'type'], 'not-applicable', 'the global routing table')
      if (isEmpty(instance)) skip(at, 'not-applicable', 'the global routing table, with nothing in it')
      if (instance.routeDistinguisher !== undefined) skip([...at, 'routeDistinguisher'], 'unsupported', 'the global routing table has no route distinguisher')
      if (instance.routeTargets !== undefined) skipAll(instance.routeTargets, [...at, 'routeTargets'], 'the global routing table has no route targets')
      continue
    }
    // An instance with only routes (`router static vrf V` with no `vrf V`): its routes say it, under router static.
    if (instance.type === undefined && instance.routeDistinguisher === undefined && instance.routeTargets === undefined && !isEmpty(instance)) continue
    renderVrf(name, instance, at)
  }

  function renderVrf(name: string, instance: NetworkInstance, at: Segments) {
    const fields: Segments[] = isEmpty(instance) ? [at] : []
    if (instance.type === 'vrf') fields.push([...at, 'type'])
    else if (instance.type !== undefined) skip([...at, 'type'], 'unsupported', 'IOS-XR\'s global table is "default": another instance is a VRF')
    emit(`vrf ${name}`, ...fields)
    if (instance.routeDistinguisher !== undefined) {
      skip([...at, 'routeDistinguisher'], 'unsupported', 'IOS-XR sets a VRF\'s route distinguisher under router bgp, whose AS the model doesn\'t hold')
    }
    if (instance.routeTargets !== undefined) renderRouteTargets(instance.routeTargets, [...at, 'routeTargets'])
    close()
  }

  /**
   * A VRF's route targets: IOS-XR sets them per address family, and the model's are the VRF's, so they go under both
   * IPv4 and IPv6 unicast, in the block form. Each list is one field (a leaf-list), marked on its first line.
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
      emit(` address-family ${family} unicast`)
      for (const [direction, values] of lists) {
        emit(`  ${direction} route-target`)
        values.forEach((v, i) => emit(`   ${v}`, ...(family === 'ipv4' && i === 0 ? [[...at, direction]] : [])))
        close('  ')
      }
      close(' ')
    }
  }

  // ---- interfaces

  for (const [name, iface] of Object.entries(model.interfaces ?? {})) renderInterface(name, iface)
  emptyContainer(model.interfaces, ['interfaces'])

  function renderInterface(name: string, iface: Interface) {
    const at = ['interfaces', name]
    const subs = Object.entries(iface.subinterfaces ?? {})
    const main = iface.subinterfaces?.['0']
    if (iface.type !== undefined) skip([...at, 'type'], 'not-applicable', 'IOS-XR gives an interface\'s type by its name')
    if (iface.vlanTagging !== undefined) skip([...at, 'vlanTagging'], 'not-applicable', 'IOS-XR tags each subinterface (encapsulation dot1q)')
    emptyContainer(iface.subinterfaces, [...at, 'subinterfaces'])

    emit(`interface ${name}`, ...(isEmpty(iface) ? [at] : []))
    if (iface.description !== undefined) emit(` description ${iface.description}`, [...at, 'description'])
    if (iface.mtu !== undefined) emit(` mtu ${iface.mtu}`, [...at, 'mtu'])
    if (main) {
      const sub = [...at, 'subinterfaces', '0']
      if (isEmpty(main)) skip(sub, 'not-applicable', 'IOS-XR has no subinterface 0 of its own: the main interface is it')
      if (main.description !== undefined) skip([...sub, 'description'], 'unsupported', 'IOS-XR has one description for the main interface')
      if (main.enabled !== undefined) skip([...sub, 'enabled'], 'unsupported', 'IOS-XR has one shutdown for the main interface')
      if (main.vlanId !== undefined) skip([...sub, 'vlanId'], 'unsupported', 'IOS-XR has no subinterface 0 to tag')
      if (renderMembership(main, sub)) renderAddresses(main, sub)
    }
    if (iface.enabled !== undefined) emit(iface.enabled ? ' no shutdown' : ' shutdown', [...at, 'enabled'])
    close()

    for (const [index, sub] of subs) {
      if (index === '0') continue
      const subAt = [...at, 'subinterfaces', index]
      emit(`interface ${name}.${index}`, ...(isEmpty(sub) ? [subAt] : []))
      if (sub.description !== undefined) emit(` description ${sub.description}`, [...subAt, 'description'])
      if (renderMembership(sub, subAt)) renderAddresses(sub, subAt)
      if (sub.vlanId !== undefined) emit(` encapsulation dot1q ${sub.vlanId}`, [...subAt, 'vlanId'])
      if (sub.enabled !== undefined) emit(sub.enabled ? ' no shutdown' : ' shutdown', [...subAt, 'enabled'])
      close()
    }
  }

  /**
   * `vrf V`, before the addresses (on IOS-XR it clears those before it). Whether the addresses can follow: in a VRF the
   * model doesn't have, they would land in another table, so they are left out with it.
   */
  function renderMembership(sub: Subinterface, at: Segments): boolean {
    const vrf = sub.networkInstance
    if (vrf === undefined) return true
    const field = [...at, 'networkInstance']
    if (vrf === 'default') {
      skip(field, 'not-applicable', 'the global routing table, which interfaces are in unless they say otherwise')
      return true
    }
    if (model.networkInstances && Object.hasOwn(model.networkInstances, vrf)) {
      emit(` vrf ${vrf}`, field)
      return true
    }
    const reason = 'a VRF the model doesn\'t have'
    skip(field, 'unsupported', reason)
    for (const family of ['ipv4', 'ipv6'] as const) if (sub[family] !== undefined) skipAll(sub[family], [...at, family], `in a VRF IOS-XR can't put the interface in (${reason}): left out rather than put in another table`)
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
    if (version === 6) {
      // IPv6 addresses are all alike on IOS-XR: none is primary.
      for (const [address, a] of addresses) {
        const f = [...at, 'addresses', address]
        if (a.primary !== undefined) skip([...f, 'primary'], 'not-applicable', 'IOS-XR has no primary IPv6 address: they are all alike')
        emit(` ipv6 address ${address}/${a.prefixLength}`, [...f, 'prefixLength'])
      }
    } else {
      // One primary IPv4 address; the others are secondary. Without a primary in the model, the first is.
      const primaries = addresses.filter(([, a]) => a.primary)
      const primary = primaries[0]?.[0] ?? addresses[0]?.[0]
      if (addresses.length > 1 && !primaries.length) {
        diagnostics.push({ severity: 'warning', category: 'semantic', code: 'iosxr.primary-chosen', message: 'No primary address given: the first is written as the primary, the others as secondary.', field: fieldPath(...at, 'addresses') })
      }
      const ordered = addresses.filter(([a]) => a === primary).concat(addresses.filter(([a]) => a !== primary))
      for (const [address, a] of ordered) {
        const f = [...at, 'addresses', address]
        const isPrimary = address === primary
        const fields: Segments[] = [[...f, 'prefixLength']]
        if (a.primary !== undefined) {
          if (a.primary === isPrimary) fields.push([...f, 'primary'])
          else skip([...f, 'primary'], 'unsupported', 'IOS-XR has one primary address')
        }
        emit(` ipv4 address ${address} ${lengthMask(a.prefixLength)}${isPrimary ? '' : ' secondary'}`, ...fields)
      }
    }
    if (family.mtu !== undefined) skip([...at, 'mtu'], 'unsupported', 'the model\'s address family MTU isn\'t written yet')
  }

  // ---- static routes

  const routed = instances.filter(([, i]) => Object.keys(i.staticRoutes ?? {}).length)
  for (const [name, instance] of instances) emptyContainer(instance.staticRoutes, ['networkInstances', name, 'staticRoutes'])
  if (routed.length) {
    emit('router static')
    // The global table first, then each VRF's.
    for (const [name, instance] of [...routed.filter(([n]) => n === 'default'), ...routed.filter(([n]) => n !== 'default')]) {
      const vrf = name !== 'default'
      const indent = vrf ? '  ' : ' '
      if (vrf) emit(` vrf ${name}`)
      for (const v6 of [false, true]) {
        const routes = Object.entries(instance.staticRoutes ?? {}).filter(([prefix]) => prefix.includes(':') === v6)
        if (!routes.length) continue
        emit(`${indent}address-family ${v6 ? 'ipv6' : 'ipv4'} unicast`)
        for (const [prefix, route] of routes) renderRoute(`${indent} `, prefix, route, ['networkInstances', name, 'staticRoutes', prefix])
        close(indent)
      }
      if (vrf) close(' ')
    }
    close()
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
        if (hop.drop !== undefined) skip([...h, 'drop'], 'unsupported', 'IOS-XR has no reject route: Null0 discards')
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
      if (hop.metric !== undefined) skip([...h, 'metric'], 'unsupported', 'IOS-XR static routes have no metric')
      if (hop.preference !== undefined) {
        if (hop.preference >= 1 && hop.preference <= 254) {
          parts.push(String(hop.preference))
          fields.push([...h, 'preference'])
        } else skip([...h, 'preference'], 'unsupported', 'IOS-XR takes a distance from 1 to 254')
      }
      if (hop.tag !== undefined) {
        parts.push(`tag ${hop.tag}`)
        fields.push([...h, 'tag'])
      }
      if (route.description !== undefined) {
        parts.push(`description ${word(route.description)}`)
        if (!described) fields.push([...at, 'description'])
        described = true
      }
      emit(`${indent}${prefix} ${parts.join(' ')}`, ...fields)
    }
    if (route.description !== undefined && !described) skip([...at, 'description'], 'unsupported', 'a route description needs a next hop to go on')
  }

  // ---- NTP, logging, SNMP

  if (system) {
    const ntp = system.ntp
    if (ntp) {
      emptyContainer(ntp, ['system', 'ntp'])
      emptyContainer(ntp.servers, ['system', 'ntp', 'servers'])
      if (!isEmpty(ntp)) {
        emit('ntp')
        for (const [address, server] of Object.entries(ntp.servers ?? {})) {
          const at = ['system', 'ntp', 'servers', address]
          const fields: Segments[] = isEmpty(server) ? [at] : []
          let vrf = ''
          if (server.networkInstance !== undefined) {
            if (server.networkInstance !== 'default') vrf = `vrf ${server.networkInstance} `
            fields.push([...at, 'networkInstance'])
          }
          let line = ` server ${vrf}${address}`
          if (server.version !== undefined) {
            if (Number.isInteger(server.version) && server.version >= 1 && server.version <= 4) {
              line += ` version ${server.version}`
              fields.push([...at, 'version'])
            } else skip([...at, 'version'], 'unsupported', 'IOS-XR takes an NTP version from 1 to 4')
          }
          if (server.prefer !== undefined) {
            if (server.prefer) line += ' prefer'
            fields.push([...at, 'prefer'])
          }
          emit(line, ...fields)
        }
        if (ntp.sourceInterface !== undefined) emit(` source ${ntp.sourceInterface}`, ['system', 'ntp', 'sourceInterface'])
        close()
      }
    }

    const logging = system.logging
    if (logging) {
      emptyContainer(logging, ['system', 'logging'])
      emptyContainer(logging.remoteServers, ['system', 'logging', 'remoteServers'])
      const at = ['system', 'logging']
      for (const [address, server] of Object.entries(logging.remoteServers ?? {})) {
        const s = [...at, 'remoteServers', address]
        const fields: Segments[] = isEmpty(server) ? [s] : []
        // IOS-XR shows every host with its VRF, `default` for the global table.
        let line = `logging ${address} vrf ${server.networkInstance ?? 'default'}`
        if (server.networkInstance !== undefined) fields.push([...s, 'networkInstance'])
        if (server.severity !== undefined) {
          if (Object.hasOwn(SEVERITY_OUT, server.severity)) {
            line += ` severity ${SEVERITY_OUT[server.severity]}`
            fields.push([...s, 'severity'])
          } else skip([...s, 'severity'], 'unsupported', 'not a syslog severity IOS-XR knows')
        }
        if (server.port !== undefined) {
          line += ` port ${server.port}`
          fields.push([...s, 'port'])
        }
        if (server.facility !== undefined) skip([...s, 'facility'], 'unsupported', 'IOS-XR sets one facility for every host')
        emit(line, ...fields)
      }
      if (logging.sourceInterface !== undefined) emit(`logging source-interface ${logging.sourceInterface}`, [...at, 'sourceInterface'])
    }

    const snmp = system.snmp
    if (snmp) {
      emptyContainer(snmp, ['system', 'snmp'])
      emptyContainer(snmp.communities, ['system', 'snmp', 'communities'])
      for (const [name, community] of Object.entries(snmp.communities ?? {})) {
        const at = ['system', 'snmp', 'communities', name]
        if (community.clients !== undefined) {
          // Written without its access list, the community would answer every client: leave it out whole.
          skipAll(community, at, 'IOS-XR limits a community\'s clients with an access list, which comes with filters: left out rather than open to every client')
          diagnostics.push({ severity: 'warning', category: 'semantic', code: 'iosxr.snmp-community-restricted', message: 'An SNMP community limited to some clients needs an access list, so it isn\'t written.', field: fieldPath(...at) })
          continue
        }
        const access = community.access === undefined ? '' : community.access === 'read-write' ? ' RW' : ' RO'
        emit(`snmp-server community ${word(name)}${access}`, ...(community.access !== undefined ? [[...at, 'access']] : isEmpty(community) ? [at] : []))
      }
      if (snmp.contact !== undefined) emit(`snmp-server contact ${snmp.contact}`, ['system', 'snmp', 'contact'])
      if (snmp.location !== undefined) emit(`snmp-server location ${snmp.location}`, ['system', 'snmp', 'location'])
    }
  }

  return { text: lines.length ? `${lines.join('\n')}\n` : '', dispositions, diagnostics }
}
