// The shared model → IOS / IOS-XE text, for the phase 1 areas and model 0.4's VLANs, switch ports and VLAN interfaces.
// Every populated leaf of those areas gets a disposition: `rendered` with the line it went to, `unsupported` with why
// (IOS can't say it, or this renderer can't yet), or `not-applicable` (IOS implies it). Fields of areas it doesn't
// render yet (OSPF, BGP) or of a later model version are left without one, so the ledger reports them as unrendered
// rather than this renderer claiming them. VLANs come first, then VRFs; VRFs are defined (`vrf definition`) before the interfaces in
// them, and an interface's `vrf forwarding` comes before its addresses, which it would otherwise clear.
import { fieldPath, isRouteDistinguisher, isVlanId, populatedLeaves, type AddressFamily, type Context, type Device, type Diagnostic, type FieldDisposition, type Interface, type NetworkInstance, type RenderResult, type RouteTargets, type StaticRoute, type Subinterface } from '@dialect/core'
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

/** An entry of a trunk's allowed VLANs: an ID (`10`) or a range (`20-30`, first below last), from 1 to 4094. */
const isVlanRange = (entry: string) => {
  const m = /^([1-9]\d*)(?:-([1-9]\d*))?$/.exec(entry)
  return m !== null && isVlanId(Number(m[1])) && (m[2] === undefined || (isVlanId(Number(m[2])) && Number(m[1]) < Number(m[2])))
}

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

  // ---- VLANs: before the switch ports and VLAN interfaces that use them

  emptyContainer(model.vlans, ['vlans'])
  for (const [id, vlan] of Object.entries(model.vlans ?? {})) {
    const at = ['vlans', id]
    if (!isVlanId(Number(id)) || String(Number(id)) !== id) {
      skipAll(vlan, at, 'not a VLAN ID from 1 to 4094')
      continue
    }
    if (id === '1') {
      // IOS always has VLAN 1, the default, and can't rename it.
      if (isEmpty(vlan)) skip(at, 'not-applicable', 'IOS always has VLAN 1')
      else skipAll(vlan, at, 'IOS can\'t rename VLAN 1 or describe it')
      continue
    }
    separator()
    emit(`vlan ${id}`, ...(isEmpty(vlan) ? [at] : []))
    if (vlan.name !== undefined) {
      if (/^\S+$/.test(vlan.name)) emit(` name ${vlan.name}`, [...at, 'name'])
      else skip([...at, 'name'], 'unsupported', 'IOS VLAN names are one word')
    }
    if (vlan.description !== undefined) skip([...at, 'description'], 'unsupported', 'IOS VLANs have a name but no description')
  }

  // ---- VRF definitions: before the interfaces in them

  const instances = Object.entries(model.networkInstances ?? {})
  for (const [name, instance] of instances) if (name !== 'default') renderDefinition(name, instance)

  /** The address families a VRF needs: those of its interfaces' addresses and its routes, and IPv4 for a VPN. */
  function familiesOf(name: string, instance: NetworkInstance): ('ipv4' | 'ipv6')[] {
    const subs = Object.values(model.interfaces ?? {}).flatMap((i) => Object.values(i.subinterfaces ?? {})).filter((s) => s.networkInstance === name)
    const prefixes = Object.keys(instance.staticRoutes ?? {})
    const v4 = subs.some((s) => s.ipv4 !== undefined) || prefixes.some((p) => !p.includes(':')) || instance.routeDistinguisher !== undefined || instance.routeTargets !== undefined
    const v6 = subs.some((s) => s.ipv6 !== undefined) || prefixes.some((p) => p.includes(':'))
    return [...(v4 ? ['ipv4' as const] : []), ...(v6 ? ['ipv6' as const] : [])]
  }

  function renderDefinition(name: string, instance: NetworkInstance) {
    const at = ['networkInstances', name]
    separator()
    const fields: Segments[] = isEmpty(instance) ? [at] : []
    if (instance.type === 'vrf') fields.push([...at, 'type'])
    else if (instance.type !== undefined) skip([...at, 'type'], 'unsupported', 'IOS\'s global table is unnamed, and every other instance is a VRF')
    emit(`vrf definition ${name}`, ...fields)
    if (instance.routeDistinguisher !== undefined) {
      if (isRouteDistinguisher(instance.routeDistinguisher)) emit(` rd ${instance.routeDistinguisher}`, [...at, 'routeDistinguisher'])
      else skip([...at, 'routeDistinguisher'], 'unsupported', 'not a route distinguisher in the form ASN:nn, IP:nn or ASN4:nn')
    }
    if (instance.routeTargets !== undefined) renderRouteTargets(instance.routeTargets, [...at, 'routeTargets'])
    for (const family of familiesOf(name, instance)) {
      emit(' !')
      emit(` address-family ${family}`)
      emit(' exit-address-family')
    }
  }

  /** A VRF's route targets, VRF-wide (the model's are the VRF's, for every family). Each list is one field, on its first line. */
  function renderRouteTargets(targets: RouteTargets, at: Segments) {
    emptyContainer(targets, at)
    for (const direction of ['import', 'export'] as const) {
      const values = targets[direction]
      if (values === undefined) continue
      if (!values.length) skip([...at, direction], 'not-applicable', 'an empty list: nothing to write')
      else if (!values.every(isRouteDistinguisher)) skip([...at, direction], 'unsupported', 'a route target not in the form ASN:nn, IP:nn or ASN4:nn')
      else values.forEach((v, i) => emit(` route-target ${direction} ${v}`, ...(i === 0 ? [[...at, direction]] : [])))
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

    // A VLAN interface says the VLAN it routes for by its name: `interface Vlan10` routes for VLAN 10.
    const routed = main?.routedVlan
    const routedField = [...at, 'subinterfaces', '0', 'routedVlan']
    const named = routed !== undefined && iface.type === 'irb-or-svi' && isVlanId(routed) && new RegExp(`^(?:Vlan|Vl)0*${routed}$`, 'i').test(name)
    if (routed !== undefined && !named) skip(routedField, 'unsupported', 'IOS routes a VLAN on the interface named for it (VlanN for VLAN N), and this one isn\'t')

    const hasOwn = iface.description !== undefined || iface.enabled !== undefined || iface.mtu !== undefined || iface.switching !== undefined || main !== undefined
    if (hasOwn || !subs.some(([index]) => index !== '0')) {
      separator()
      emit(`interface ${name}`, ...(isEmpty(iface) ? [at] : []), ...(named ? [routedField] : []))
      if (iface.description !== undefined) emit(` description ${iface.description}`, [...at, 'description'])
      if (iface.mtu !== undefined) emit(` mtu ${iface.mtu}`, [...at, 'mtu'])
      if (iface.switching !== undefined) renderSwitching(iface, at)
      if (main) {
        const sub = [...at, 'subinterfaces', '0']
        if (isEmpty(main)) skip(sub, 'not-applicable', 'IOS has no unit 0 of its own: the main interface is it')
        if (main.description !== undefined) skip([...sub, 'description'], 'unsupported', 'IOS has one description for the main interface')
        if (main.enabled !== undefined) skip([...sub, 'enabled'], 'unsupported', 'IOS has one shutdown for the main interface')
        if (main.vlanId !== undefined) skip([...sub, 'vlanId'], 'unsupported', 'IOS has no subinterface 0 to tag')
        if (renderMembership(main, sub)) renderAddresses(main, sub)
      }
      if (iface.enabled !== undefined) emit(iface.enabled ? ' no shutdown' : ' shutdown', [...at, 'enabled'])
    }

    for (const [index, sub] of subs) {
      if (index === '0') continue
      const subAt = [...at, 'subinterfaces', index]
      separator()
      emit(`interface ${name}.${index}`, ...(isEmpty(sub) ? [subAt] : []))
      if (sub.routedVlan !== undefined) skip([...subAt, 'routedVlan'], 'unsupported', 'IOS routes a VLAN on its own Vlan interface, not on a subinterface')
      if (sub.description !== undefined) emit(` description ${sub.description}`, [...subAt, 'description'])
      if (sub.vlanId !== undefined) emit(` encapsulation dot1Q ${sub.vlanId}`, [...subAt, 'vlanId'])
      if (renderMembership(sub, subAt)) renderAddresses(sub, subAt)
      if (sub.enabled !== undefined) emit(sub.enabled ? ' no shutdown' : ' shutdown', [...subAt, 'enabled'])
    }
  }

  /** A switch port, in the order `show running-config` gives it: the VLANs, then the mode. */
  function renderSwitching(iface: Interface, at: Segments) {
    const s = iface.switching!
    const sw = [...at, 'switching']
    if (iface.type === 'irb-or-svi') {
      skipAll(s, sw, 'a VLAN interface routes: IOS can\'t make it a switch port')
      return
    }
    emit(' switchport', ...(isEmpty(s) ? [sw] : []))
    const vlan = (value: number | undefined, leaf: string, line: string) => {
      if (value === undefined) return
      if (isVlanId(value)) emit(`${line} ${value}`, [...sw, leaf])
      else skip([...sw, leaf], 'unsupported', 'not a VLAN ID from 1 to 4094')
    }
    vlan(s.accessVlan, 'accessVlan', ' switchport access vlan')
    vlan(s.nativeVlan, 'nativeVlan', ' switchport trunk native vlan')
    if (s.allowedVlans !== undefined) {
      if (s.allowedVlans.every(isVlanRange)) emit(` switchport trunk allowed vlan ${s.allowedVlans.length ? s.allowedVlans.join(',') : 'none'}`, [...sw, 'allowedVlans'])
      else skip([...sw, 'allowedVlans'], 'unsupported', 'not a list of VLAN IDs and ranges from 1 to 4094')
    }
    if (s.mode !== undefined) {
      if (s.mode === 'access' || s.mode === 'trunk') emit(` switchport mode ${s.mode}`, [...sw, 'mode'])
      else skip([...sw, 'mode'], 'unsupported', 'not a switch port mode IOS has')
    }
  }

  /**
   * `vrf forwarding V`, before the addresses (on IOS it clears those before it). Whether the addresses can follow: in a
   * VRF the model doesn't have, they would land in another table, so they are left out with it.
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
      emit(` vrf forwarding ${vrf}`, field)
      return true
    }
    const reason = 'a VRF the model doesn\'t have'
    skip(field, 'unsupported', reason)
    for (const family of ['ipv4', 'ipv6'] as const) if (sub[family] !== undefined) skipAll(sub[family], [...at, family], `in a VRF IOS can't put the interface in (${reason}): left out rather than put in another table`)
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
      // Value-free (AGENTS.md): an address can share its value with a secret, such as a community. The field says where.
      diagnostics.push({ severity: 'warning', category: 'semantic', code: 'iosxe.primary-chosen', message: 'No primary address given: the first is written as the primary, the others as secondary.', field: fieldPath(...at, 'addresses') })
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
  for (const [name, instance] of instances) renderInstance(name, instance)
  emptyContainer(model.networkInstances, ['networkInstances'])

  /** The global table's settings and every instance's static routes (`ip route vrf V …`, after its definition). */
  function renderInstance(name: string, instance: NetworkInstance) {
    const at = ['networkInstances', name]
    const isDefault = name === 'default'
    if (isDefault) {
      if (instance.type !== undefined) skip([...at, 'type'], 'not-applicable', 'the global routing table')
      if (isEmpty(instance)) skip(at, 'not-applicable', 'the global routing table, with nothing in it')
      if (instance.routeDistinguisher !== undefined) skip([...at, 'routeDistinguisher'], 'unsupported', 'the global routing table has no route distinguisher')
      if (instance.routeTargets !== undefined) skipAll(instance.routeTargets, [...at, 'routeTargets'], 'the global routing table has no route targets')
    }
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
