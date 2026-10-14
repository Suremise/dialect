// The shared model → IOS / IOS-XE text, for the phase 1 areas. Every populated leaf of model 0.2 gets a disposition:
// `rendered` with the line it went to, `unsupported` with why (IOS can't say it, or this renderer can't yet), or
// `not-applicable` (IOS implies it). Fields of a later model version are left without one, so the ledger reports them
// as unrendered rather than this renderer claiming them.
import { fieldPath, populatedLeaves, type AddressFamily, type Context, type Device, type Diagnostic, type FieldDisposition, type Interface, type NetworkInstance, type RenderResult, type StaticRoute, type Subinterface } from '@dialect/core'
import { lengthMask } from './addresses'
import { SEVERITIES } from './parse'

type Segments = readonly (string | number)[]

const IOS_SEVERITY: Readonly<Record<string, string>> = Object.fromEntries(Object.entries(SEVERITIES).map(([ios, model]) => [model, ios]))

/**
 * An interface reference as IOS writes it. The model's references are `name` or `name.<subinterface>`, and IOS has no
 * subinterface 0: its addresses are the main interface's (a Junos `ge-0/0/0.0` renamed to `Gi0/0/0.0`), so `.0` is the
 * main interface.
 */
const ref = (name: string) => name.replace(/\.0$/, '')

/** A word IOS reads back as one: quoted when it has a space in it. */
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
    if (lines.length && lines[lines.length - 1] !== '!') lines.push('!')
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
    if (system.domainName !== undefined) emit(`ip domain name ${system.domainName}`, ['system', 'domainName'])
    const dns = system.dns
    if (dns) {
      emptyContainer(dns, ['system', 'dns'])
      emptyContainer(dns.servers, ['system', 'dns', 'servers'])
      if (dns.search !== undefined) {
        if (!dns.search.length) skip(['system', 'dns', 'search'], 'not-applicable', 'an empty search list: nothing to write')
        // A leaf-list is one field: marked on its first line.
        dns.search.forEach((domain, i) => emit(`ip domain list ${domain}`, ...(i === 0 ? [['system', 'dns', 'search']] : [])))
      }
      for (const [address, server] of Object.entries(dns.servers ?? {})) {
        const at = ['system', 'dns', 'servers', address]
        const fields: Segments[] = isEmpty(server) ? [at] : []
        let line = 'ip name-server'
        if (server.networkInstance !== undefined) {
          if (server.networkInstance !== 'default') line += ` vrf ${server.networkInstance}`
          fields.push([...at, 'networkInstance'])
        }
        emit(`${line} ${address}`, ...fields)
      }
    }
  }

  // ---- interfaces

  for (const [name, iface] of Object.entries(model.interfaces ?? {})) renderInterface(name, iface)
  emptyContainer(model.interfaces, ['interfaces'])

  function renderInterface(name: string, iface: Interface) {
    const at = ['interfaces', name]
    const subs = Object.entries(iface.subinterfaces ?? {})
    const main = iface.subinterfaces?.['0']
    if (iface.type !== undefined) skip([...at, 'type'], 'not-applicable', 'IOS gives an interface\'s type by its name')
    if (iface.vlanTagging !== undefined) skip([...at, 'vlanTagging'], 'not-applicable', 'IOS tags each subinterface (encapsulation dot1Q)')
    emptyContainer(iface.subinterfaces, [...at, 'subinterfaces'])

    const hasOwn = iface.description !== undefined || iface.enabled !== undefined || iface.mtu !== undefined || main !== undefined
    if (hasOwn || !subs.some(([index]) => index !== '0')) {
      separator()
      emit(`interface ${name}`, ...(isEmpty(iface) ? [at] : []))
      if (iface.description !== undefined) emit(` description ${iface.description}`, [...at, 'description'])
      if (iface.mtu !== undefined) emit(` mtu ${iface.mtu}`, [...at, 'mtu'])
      if (main) {
        const sub = [...at, 'subinterfaces', '0']
        if (isEmpty(main)) skip(sub, 'not-applicable', 'IOS has no unit 0 of its own: the main interface is it')
        if (main.description !== undefined) skip([...sub, 'description'], 'unsupported', 'IOS has one description for the main interface')
        if (main.enabled !== undefined) skip([...sub, 'enabled'], 'unsupported', 'IOS has one shutdown for the main interface')
        if (main.vlanId !== undefined) skip([...sub, 'vlanId'], 'unsupported', 'IOS has no subinterface 0 to tag')
        renderAddresses(main, sub)
      }
      if (iface.enabled !== undefined) emit(iface.enabled ? ' no shutdown' : ' shutdown', [...at, 'enabled'])
    }

    for (const [index, sub] of subs) {
      if (index === '0') continue
      const subAt = [...at, 'subinterfaces', index]
      separator()
      emit(`interface ${name}.${index}`, ...(isEmpty(sub) ? [subAt] : []))
      if (sub.description !== undefined) emit(` description ${sub.description}`, [...subAt, 'description'])
      if (sub.vlanId !== undefined) emit(` encapsulation dot1Q ${sub.vlanId}`, [...subAt, 'vlanId'])
      renderAddresses(sub, subAt)
      if (sub.enabled !== undefined) emit(sub.enabled ? ' no shutdown' : ' shutdown', [...subAt, 'enabled'])
    }
  }

  function renderAddresses(sub: Subinterface, at: Segments) {
    renderFamily(sub.ipv4, [...at, 'ipv4'], 4)
    renderFamily(sub.ipv6, [...at, 'ipv6'], 6)
  }

  function renderFamily(family: AddressFamily | undefined, at: Segments, version: 4 | 6) {
    if (!family) return
    emptyContainer(family, at)
    emptyContainer(family.addresses, [...at, 'addresses'])
    const addresses = Object.entries(family.addresses ?? {})
    if (version === 6) {
      for (const [address, a] of addresses) {
        emit(` ipv6 address ${address}/${a.prefixLength}`, [...at, 'addresses', address, 'prefixLength'])
        if (a.primary !== undefined) skip([...at, 'addresses', address, 'primary'], 'not-applicable', 'IPv6 addresses have no primary on IOS')
      }
      if (family.mtu !== undefined) emit(` ipv6 mtu ${family.mtu}`, [...at, 'mtu'])
      return
    }
    // IOS has one primary address; the others are secondary. Without a primary in the model, the first is made it.
    const primaries = addresses.filter(([, a]) => a.primary)
    const primary = primaries[0]?.[0] ?? addresses[0]?.[0]
    if (addresses.length > 1 && !primaries.length) {
      diagnostics.push({ severity: 'warning', category: 'semantic', code: 'iosxe.primary-chosen', message: `No primary address given: ${primary} is written as the primary, the others as secondary.`, field: fieldPath(...at, 'addresses') })
    }
    const ordered = addresses.filter(([a]) => a === primary).concat(addresses.filter(([a]) => a !== primary))
    for (const [address, a] of ordered) {
      const f = [...at, 'addresses', address]
      if (!Number.isInteger(a.prefixLength) || a.prefixLength < 0 || a.prefixLength > 32) {
        skipAll(a, f, 'not an IPv4 prefix length')
        continue
      }
      const isPrimary = address === primary
      const fields: Segments[] = [[...f, 'prefixLength']]
      if (a.primary !== undefined) {
        if (a.primary === isPrimary) fields.push([...f, 'primary'])
        else skip([...f, 'primary'], 'unsupported', 'IOS has one primary address')
      }
      emit(` ip address ${address} ${lengthMask(a.prefixLength)}${isPrimary ? '' : ' secondary'}`, ...fields)
    }
    if (family.mtu !== undefined) emit(` ip mtu ${family.mtu}`, [...at, 'mtu'])
  }

  // ---- static routes

  separator()
  for (const [name, instance] of Object.entries(model.networkInstances ?? {})) renderInstance(name, instance)
  emptyContainer(model.networkInstances, ['networkInstances'])

  function renderInstance(name: string, instance: NetworkInstance) {
    const at = ['networkInstances', name]
    const isDefault = name === 'default'
    if (instance.type !== undefined) {
      if (isDefault || instance.type === 'default') skip([...at, 'type'], 'not-applicable', 'the global routing table')
      else skip([...at, 'type'], 'unsupported', `VRF definitions come later: the routes are written with "ip route vrf ${name}", but "vrf definition ${name}" isn't`)
    }
    if (!isDefault && Object.keys(instance.staticRoutes ?? {}).length) {
      diagnostics.push({ severity: 'warning', category: 'semantic', code: 'iosxe.vrf-not-defined', message: `VRF ${name} isn't defined in the output (VRFs come later): add "vrf definition ${name}" before its routes.`, field: fieldPath(...at) })
    }
    if (isEmpty(instance)) skip(at, 'unsupported', 'VRFs without routes come later')
    emptyContainer(instance.staticRoutes, [...at, 'staticRoutes'])
    for (const [prefix, route] of Object.entries(instance.staticRoutes ?? {})) renderRoute(isDefault ? '' : `vrf ${name} `, prefix, route, [...at, 'staticRoutes', prefix])
  }

  function renderRoute(vrf: string, prefix: string, route: StaticRoute, at: Segments) {
    const v6 = prefix.includes(':')
    const m = /^(.+)\/(\d+)$/.exec(prefix)
    if (!m || (!v6 && Number(m[2]) > 32)) {
      skipAll(route, at, 'not a prefix')
      return
    }
    const destination = v6 ? prefix : `${m[1]} ${lengthMask(Number(m[2]))}`
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
        if (hop.drop !== undefined) skip([...h, 'drop'], 'unsupported', 'IOS has no reject route: Null0 discards')
        if (hop.interface !== undefined) {
          parts.push(ref(hop.interface))
          fields.push([...h, 'interface'])
        }
        if (hop.address !== undefined) {
          parts.push(hop.address)
          fields.push([...h, 'address'])
        }
      }
      if (!parts.length) {
        // A reject route says why above; its other leaves (a metric, a preference) go with it.
        skipAll(hop, h, hop.drop === 'reject' ? 'IOS has no reject route: Null0 discards' : 'a next hop with no address, interface or discard')
        continue
      }
      if (hop.preference !== undefined) {
        parts.push(String(hop.preference))
        fields.push([...h, 'preference'])
      }
      if (hop.tag !== undefined) {
        parts.push(`tag ${hop.tag}`)
        fields.push([...h, 'tag'])
      }
      if (hop.metric !== undefined) skip([...h, 'metric'], 'unsupported', 'IOS static routes have no metric')
      if (route.description !== undefined) {
        parts.push(`name ${word(route.description)}`)
        if (!described) fields.push([...at, 'description'])
        described = true
      }
      emit(`${v6 ? 'ipv6' : 'ip'} route ${vrf}${destination} ${parts.join(' ')}`, ...fields)
    }
    if (route.description !== undefined && !described) skip([...at, 'description'], 'unsupported', 'a route name needs a next hop to go on')
  }

  // ---- NTP, logging, SNMP

  if (system) {
    const ntp = system.ntp
    if (ntp) {
      separator()
      emptyContainer(ntp, ['system', 'ntp'])
      emptyContainer(ntp.servers, ['system', 'ntp', 'servers'])
      if (ntp.sourceInterface !== undefined) emit(`ntp source ${ref(ntp.sourceInterface)}`, ['system', 'ntp', 'sourceInterface'])
      for (const [address, server] of Object.entries(ntp.servers ?? {})) {
        const at = ['system', 'ntp', 'servers', address]
        const fields: Segments[] = isEmpty(server) ? [at] : []
        let line = 'ntp server'
        if (server.networkInstance !== undefined) {
          if (server.networkInstance !== 'default') line += ` vrf ${server.networkInstance}`
          fields.push([...at, 'networkInstance'])
        }
        line += ` ${address}`
        if (server.version !== undefined) {
          line += ` version ${server.version}`
          fields.push([...at, 'version'])
        }
        if (server.prefer !== undefined) {
          if (server.prefer) line += ' prefer'
          fields.push([...at, 'prefer'])
        }
        emit(line, ...fields)
      }
    }

    const logging = system.logging
    if (logging) {
      separator()
      emptyContainer(logging, ['system', 'logging'])
      emptyContainer(logging.remoteServers, ['system', 'logging', 'remoteServers'])
      const at = ['system', 'logging']
      if (logging.sourceInterface !== undefined) emit(`logging source-interface ${ref(logging.sourceInterface)}`, [...at, 'sourceInterface'])
      const servers = Object.entries(logging.remoteServers ?? {})
      // IOS has one trap level and one facility for every host: write them when every host agrees.
      for (const field of ['facility', 'severity'] as const) {
        const values = new Set(servers.map(([, s]) => s[field]))
        const set = servers.filter(([, s]) => s[field] !== undefined)
        if (!set.length) continue
        if (values.size === 1 && (field === 'facility' || Object.hasOwn(IOS_SEVERITY, String(set[0][1][field])))) {
          const value = set[0][1][field]!
          emit(field === 'severity' ? `logging trap ${IOS_SEVERITY[value]}` : `logging facility ${value}`, ...set.map(([address]) => [...at, 'remoteServers', address, field]))
        } else {
          const why = values.size === 1 ? 'not a syslog severity IOS knows' : `IOS sets one ${field === 'severity' ? 'trap level' : 'facility'} for every syslog host, and these differ`
          for (const [address] of set) skip([...at, 'remoteServers', address, field], 'unsupported', why)
        }
      }
      for (const [address, server] of servers) {
        const s = [...at, 'remoteServers', address]
        const fields: Segments[] = isEmpty(server) ? [s] : []
        let line = `logging host ${address}`
        if (server.networkInstance !== undefined) {
          if (server.networkInstance !== 'default') line += ` vrf ${server.networkInstance}`
          fields.push([...s, 'networkInstance'])
        }
        if (server.port !== undefined) {
          line += ` transport udp port ${server.port}`
          fields.push([...s, 'port'])
        }
        emit(line, ...fields)
      }
    }

    const snmp = system.snmp
    if (snmp) {
      separator()
      emptyContainer(snmp, ['system', 'snmp'])
      emptyContainer(snmp.communities, ['system', 'snmp', 'communities'])
      if (snmp.location !== undefined) emit(`snmp-server location ${snmp.location}`, ['system', 'snmp', 'location'])
      if (snmp.contact !== undefined) emit(`snmp-server contact ${snmp.contact}`, ['system', 'snmp', 'contact'])
      for (const [name, community] of Object.entries(snmp.communities ?? {})) {
        const at = ['system', 'snmp', 'communities', name]
        const access = community.access === undefined ? '' : community.access === 'read-write' ? ' RW' : ' RO'
        if (community.clients !== undefined) {
          // Written without its access list, the community would answer every client: leave it out whole.
          skipAll(community, at, 'IOS limits a community\'s clients with an access list, which comes with filters: left out rather than open to every client')
          diagnostics.push({ severity: 'warning', category: 'semantic', code: 'iosxe.snmp-community-restricted', message: 'An SNMP community limited to some clients needs an access list, so it isn\'t written.', field: fieldPath(...at) })
          continue
        }
        emit(`snmp-server community ${word(name)}${access}`, ...(community.access !== undefined ? [[...at, 'access']] : isEmpty(community) ? [at] : []))
      }
    }
  }

  separator()
  lines.push('end')
  return { text: `${lines.join('\n')}\n`, dispositions, diagnostics }
}
