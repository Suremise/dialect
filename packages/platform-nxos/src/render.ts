// The shared model → NX-OS text, with model 0.5's routing policy (renderPolicy.ts). Every populated leaf of model 0.4
// and of 0.5's routing policy gets a disposition: `rendered` with the line it went to, `unsupported` with why (NX-OS can't say it, or this renderer can't yet), or
// `not-applicable` (NX-OS implies it). Fields of a later model version are left without one, so the ledger reports them
// as unrendered rather than this renderer claiming them. The text says everything it relies on: each `feature` a
// written statement needs, and `switchport` or `no switchport` on every Ethernet and port-channel interface, so the
// result doesn't depend on the switch's defaults. Secrets the model only flags (an OSPF key, a BGP password) are
// needs-input items, written when answered (Context.inputs) and never made up.
import { fieldPath, isAsNumber, isRouteDistinguisher, isVlanId, populatedLeaves, type AddressFamily, type Bgp, type BgpAddressFamilyName, type BgpGroup, type BgpNeighbor, type BgpPeer, type Context, type Device, type Diagnostic, type FieldDisposition, type Interface, type NeedsInput, type NetworkInstance, type Ospf, type OspfAuthentication, type OspfInterface, type RenderResult, type RouteTargets, type StaticRoute, type Subinterface, type Switching } from '@dialect/core'
import { isIpv4, isIpv6 } from './addresses'
import { featuresFor, OSPF_FEATURE, VPN_FEATURE } from './features'
import { isSwitchable } from './names'
import { planFilters } from './renderAcl'
import { planRoutingPolicy } from './renderPolicy'
import { SEVERITY_LEVELS, SNMP_GROUPS } from './parse'
import { vlanEntries } from './vlans'

type Segments = readonly (string | number)[]

/** A word NX-OS reads back as one: quoted when it has a space in it. */
const word = (s: string) => (/\s/.test(s) ? `"${s}"` : s)
/** A VLAN name NX-OS takes: up to 32 characters, no space. */
const VLAN_NAME = /^\S{1,32}$/
/** An OSPF process tag NX-OS takes: up to 20 letters, digits and `_.-`. */
const OSPF_TAG = /^[\w.-]{1,20}$/
/** The BGP address families phase 2 writes, in order. */
const FAMILIES = ['ipv4-unicast', 'ipv6-unicast'] as const satisfies readonly BgpAddressFamilyName[]

export function render(model: Device, context: Context): RenderResult {
  const lines: string[] = []
  const dispositions: Record<string, FieldDisposition> = {}
  const diagnostics: Diagnostic[] = []
  const needsInput: NeedsInput[] = []

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
  if (Object.values(model.networkInstances ?? {}).some((instance) => instance.bgp !== undefined)) features.add(VPN_FEATURE)
  if (Object.values(model.networkInstances ?? {}).some((instance) => instance.ospf !== undefined)) features.add(OSPF_FEATURE)
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

  // ---- VLANs: before the interfaces that use them

  emptyContainer(model.vlans, ['vlans'])
  for (const [id, vlan] of Object.entries(model.vlans ?? {}).sort(([a], [b]) => Number(a) - Number(b))) {
    const at = ['vlans', id]
    if (!/^\d+$/.test(id) || !isVlanId(Number(id))) {
      skipAll(vlan, at, 'not a VLAN ID from 1 to 4094')
      continue
    }
    separator()
    emit(`vlan ${id}`, ...(isEmpty(vlan) ? [at] : []))
    if (vlan.name !== undefined) {
      if (VLAN_NAME.test(vlan.name)) emit(`  name ${vlan.name}`, [...at, 'name'])
      else skip([...at, 'name'], 'unsupported', 'not a VLAN name NX-OS takes: up to 32 characters, with no space')
    }
    if (vlan.description !== undefined) skip([...at, 'description'], 'unsupported', 'NX-OS VLANs have a name but no description')
  }

  // ---- interfaces, with each one's OSPF

  /** The network instances whose OSPF the source enabled with `network` statements, for the warning. */
  const networkEnabled = new Set<string>()
  const ospf = ospfInterfaces()
  // Access lists are planned first, as an interface applies one only when it is written (renderAcl.ts).
  const aclPlan = planFilters(model.filters, skip, skipAll)
  for (const [name, iface] of Object.entries(model.interfaces ?? {})) renderInterface(name, iface)
  emptyContainer(model.interfaces, ['interfaces'])
  // An OSPF interface whose interface wasn't written, with why when it is known.
  for (const entries of ospf.values()) for (const e of entries) if (!e.done) skipAll(e.value, e.at, e.why ?? 'OSPF on an interface that isn\'t written')

  function renderInterface(name: string, iface: Interface) {
    const at = ['interfaces', name]
    const subs = Object.entries(iface.subinterfaces ?? {})
    // An SVI (irb-or-svi) is named Vlan and its VLAN ID on NX-OS, and routes for that VLAN.
    const svi = iface.type === 'irb-or-svi' ? (/^vlan(\d+)$/i.exec(name) ?? [])[1] : undefined
    if (iface.type === 'irb-or-svi' && svi === undefined) {
      skipAll(iface, at, 'a routed VLAN interface, which NX-OS names Vlan and its VLAN ID: written only under such a name')
      diagnostics.push({ severity: 'warning', category: 'semantic', code: 'nxos.svi-name', message: 'A routed VLAN interface is written only when the interface map names it Vlan and its VLAN ID, as NX-OS does.', field: fieldPath(...at) })
      return
    }
    // The subinterface whose Layer 3 is the interface's own: 0, or on an SVI the one that routes for its VLAN.
    const own = svi === undefined ? '0' : [...subs].sort(([a], [b]) => (a === '0' ? -1 : b === '0' ? 1 : 0)).find(([, s]) => s.routedVlan === Number(svi))?.[0]
    const main = own === undefined ? undefined : iface.subinterfaces?.[own]
    if (iface.type !== undefined) skip([...at, 'type'], 'not-applicable', 'NX-OS gives an interface\'s type by its name')
    if (iface.vlanTagging !== undefined) skip([...at, 'vlanTagging'], 'not-applicable', 'NX-OS tags each subinterface (encapsulation dot1q)')
    emptyContainer(iface.subinterfaces, [...at, 'subinterfaces'])

    // A routed port: an address, a VRF or OSPF on it, or subinterfaces (which need a routed parent).
    const routed = subs.some(([index, s]) => index !== '0' || s.ipv4 !== undefined || s.ipv6 !== undefined || s.networkInstance !== undefined) || ospf.has(`${name}|0`)
    separator()
    emit(`interface ${name}`, ...(isEmpty(iface) ? [at] : []), ...(svi !== undefined && own !== undefined ? [[...at, 'subinterfaces', own, 'routedVlan']] : []))
    if (iface.description !== undefined) emit(`  description ${iface.description}`, [...at, 'description'])
    if (isSwitchable(name)) emit(routed ? '  no switchport' : '  switchport')
    if (iface.switching !== undefined) renderSwitching(name, iface.switching, routed)
    if (iface.mtu !== undefined) emit(`  mtu ${iface.mtu}`, [...at, 'mtu'])
    const isMgmt = /^mgmt0$/i.test(name)
    // mgmt0 is always in the management VRF: said, as NX-OS shows it, whether the model says so or not.
    if (isMgmt && main?.networkInstance === undefined) emit('  vrf member management')
    if (main && own !== undefined) {
      const sub = [...at, 'subinterfaces', own]
      if (isEmpty(main)) skip(sub, 'not-applicable', 'NX-OS has no subinterface 0 of its own: the main interface is it')
      if (main.description !== undefined) skip([...sub, 'description'], 'unsupported', 'NX-OS has one description for the main interface')
      if (main.enabled !== undefined) skip([...sub, 'enabled'], 'unsupported', 'NX-OS has one shutdown for the main interface')
      if (main.vlanId !== undefined) skip([...sub, 'vlanId'], 'unsupported', `NX-OS has no subinterface ${svi === undefined ? '0' : 'on a Vlan interface'} to tag`)
      if (main.routedVlan !== undefined && svi === undefined) skip([...sub, 'routedVlan'], 'unsupported', 'only a Vlan interface routes for a VLAN on NX-OS')
      if (renderMembership(main, sub, isMgmt)) {
        renderAddresses(main, sub)
        renderOspfInterface(name, own, main)
      }
      renderAttachments(main, sub, isSwitchable(name) && !routed)
    } else if (own === '0') renderOspfInterface(name, own, {})
    if (iface.enabled !== undefined) emit(iface.enabled ? '  no shutdown' : '  shutdown', [...at, 'enabled'])

    for (const [index, sub] of subs) {
      if (index === own) continue
      const subAt = [...at, 'subinterfaces', index]
      if (svi !== undefined) {
        skipAll(sub, subAt, `NX-OS's Vlan interface has no subinterfaces: it routes for the VLAN its name gives`)
        continue
      }
      separator()
      emit(`interface ${name}.${index}`, ...(isEmpty(sub) ? [subAt] : []))
      if (sub.description !== undefined) emit(`  description ${sub.description}`, [...subAt, 'description'])
      if (sub.vlanId !== undefined) emit(`  encapsulation dot1q ${sub.vlanId}`, [...subAt, 'vlanId'])
      if (sub.routedVlan !== undefined) skip([...subAt, 'routedVlan'], 'unsupported', 'only a Vlan interface routes for a VLAN on NX-OS')
      if (renderMembership(sub, subAt, false)) {
        renderAddresses(sub, subAt)
        renderOspfInterface(name, index, sub)
      }
      renderAttachments(sub, subAt, false)
      if (sub.enabled !== undefined) emit(sub.enabled ? '  no shutdown' : '  shutdown', [...subAt, 'enabled'])
    }
  }

  /**
   * A subinterface's access lists (model 0.5.1), each way and family, when the access list is written: on a switch
   * port, its port forms (`ip port access-group`, `ipv6 port traffic-filter`), which filter what comes in only.
   */
  function renderAttachments(sub: Subinterface, at: Segments, port: boolean) {
    const filters = sub.filters
    if (!filters) return
    emptyContainer(filters, [...at, 'filters'])
    for (const family of ['ipv4', 'ipv6'] as const) {
      const directions = filters[family]
      if (!directions) continue
      emptyContainer(directions, [...at, 'filters', family])
      for (const [direction, way] of [['input', 'in'], ['output', 'out']] as const) {
        const name = directions[direction]
        if (name === undefined) continue
        const field = [...at, 'filters', family, direction]
        if (!aclPlan.written[family].has(name)) skip(field, 'unsupported', 'names an access list NX-OS can\'t write')
        else if (port && direction === 'output') skip(field, 'unsupported', 'a switch port\'s access list filters what comes in only on NX-OS')
        else emit(`  ${family === 'ipv4' ? 'ip' : 'ipv6'}${port ? ' port' : ''} ${family === 'ipv4' ? 'access-group' : 'traffic-filter'} ${name} ${way}`, field)
      }
    }
  }

  /** A switch port's settings, after its `switchport` line. A routed port, or one NX-OS can't switch, has none. */
  function renderSwitching(name: string, switching: Switching, routed: boolean) {
    const at = ['interfaces', name, 'switching']
    if (!isSwitchable(name) || routed) {
      skipAll(switching, at, isSwitchable(name) ? 'a routed port (it has IP configuration) isn\'t a switch port on NX-OS' : 'only an Ethernet or port-channel interface is a switch port on NX-OS')
      return
    }
    if (isEmpty(switching)) skip(at, 'not-applicable', 'a switch port with nothing set: written as switchport')
    if (switching.mode !== undefined) emit(`  switchport mode ${switching.mode}`, [...at, 'mode'])
    for (const [field, line] of [['accessVlan', 'switchport access vlan'], ['nativeVlan', 'switchport trunk native vlan']] as const) {
      const id = switching[field]
      if (id === undefined) continue
      if (isVlanId(id)) emit(`  ${line} ${id}`, [...at, field])
      else skip([...at, field], 'unsupported', 'not a VLAN ID from 1 to 4094')
    }
    const allowed = switching.allowedVlans
    if (allowed !== undefined) {
      if (!allowed.length) emit('  switchport trunk allowed vlan none', [...at, 'allowedVlans'])
      else if (vlanEntries(allowed.join(','))?.join(',') === allowed.join(',')) emit(`  switchport trunk allowed vlan ${allowed.join(',')}`, [...at, 'allowedVlans'])
      else skip([...at, 'allowedVlans'], 'unsupported', 'not a list of VLAN IDs and ranges from 1 to 4094')
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

  // ---- OSPF

  /** An OSPF interface of the model, by the interface it names; `done` once written, `why` when it can't be. */
  type OspfEntry = { readonly instance: string; readonly tag: string; readonly area: string; readonly value: OspfInterface; readonly at: Segments; done?: boolean; why?: string }

  /** The process tag NX-OS writes for an instance's OSPF: its own, or `1` when the source has none (Junos). */
  function ospfTag(o: Ospf): string {
    return o.processId ?? '1'
  }

  /** Every OSPF interface, by `name|subinterface` of the interface it names (a reference as model.ts says). */
  function ospfInterfaces(): Map<string, OspfEntry[]> {
    const out = new Map<string, OspfEntry[]>()
    const interfaces = model.interfaces ?? {}
    for (const [instance, ni] of Object.entries(model.networkInstances ?? {})) {
      if (!ni.ospf) continue
      for (const [area, a] of Object.entries(ni.ospf.areas ?? {})) {
        for (const [ref, value] of Object.entries(a.interfaces ?? {})) {
          const at = ['networkInstances', instance, 'ospf', 'areas', area, 'interfaces', ref]
          const m = /^(.+)\.(\d+)$/.exec(ref)
          const key = Object.hasOwn(interfaces, ref) ? `${ref}|0` : m && Object.hasOwn(interfaces, m[1]) ? `${m[1]}|${m[2]}` : undefined
          const entry: OspfEntry = { instance, tag: ospfTag(ni.ospf), area, value, at, ...(key ? {} : { why: 'names an interface the model doesn\'t have' }) }
          if (key) out.set(key, [...(out.get(key) ?? []), entry])
          else skipAll(value, at, entry.why!)
        }
      }
    }
    return out
  }

  /** `ip router ospf TAG area A` and the interface's OSPF settings, after its addresses. */
  function renderOspfInterface(name: string, index: string, sub: Subinterface) {
    const entries = ospf.get(`${name}|${index}`) ?? []
    let written: OspfEntry | undefined
    for (const e of entries) {
      const tag = e.tag
      if (e.instance !== (sub.networkInstance ?? (/^mgmt0$/i.test(name) && index === '0' ? 'management' : 'default'))) e.why = 'OSPF in another network instance than its interface\'s'
      else if (!OSPF_TAG.test(tag)) e.why = 'not a process tag NX-OS takes'
      else if (!isIpv4(e.area)) e.why = 'not an area in dotted form'
      else if (written) e.why = 'a second OSPF area or process for the interface: NX-OS enables one per interface'
      if (e.why) continue
      written = e
      e.done = true
      const at = e.at
      const v = e.value
      emit(`  ip router ospf ${tag} area ${e.area}`, ...(isEmpty(v) ? [at] : []), ...(v.enabledBy !== undefined ? [[...at, 'enabledBy']] : []))
      if (v.enabledBy === 'network') networkEnabled.add(e.instance)
      if (v.cost !== undefined) number(v.cost, 'ip ospf cost', [...at, 'cost'])
      if (v.networkType !== undefined) emit(`  ip ospf network ${v.networkType}`, [...at, 'networkType'])
      if (v.passive === true) emit('  ip ospf passive-interface', [...at, 'passive'])
      else if (v.passive === false) skip([...at, 'passive'], 'not-applicable', 'not passive, as an interface is unless set')
      if (v.helloInterval !== undefined) number(v.helloInterval, 'ip ospf hello-interval', [...at, 'helloInterval'])
      if (v.deadInterval !== undefined) number(v.deadInterval, 'ip ospf dead-interval', [...at, 'deadInterval'])
      const areaAuth = model.networkInstances?.[e.instance]?.ospf?.areas?.[e.area]?.authentication
      renderOspfAuthentication(v.authentication, areaAuth, at)
    }
  }

  /** `<line> N` for an OSPF number NX-OS takes from 1 to 65535. */
  function number(value: number, line: string, field: Segments) {
    if (Number.isInteger(value) && value >= 1 && value <= 65535) emit(`  ${line} ${value}`, field)
    else skip(field, 'unsupported', 'not a number from 1 to 65535')
  }

  /**
   * An interface's OSPF authentication: its own type (the area's applies when it has none), and the key, which is never
   * carried: a needs-input item asks for it, and the answer is written. A key chain is named by the answer.
   */
  function renderOspfAuthentication(own: OspfAuthentication | undefined, area: OspfAuthentication | undefined, at: Segments) {
    const kind = own ?? (area === 'key-chain' ? undefined : area)
    const field = [...at, 'authentication']
    if (kind === undefined) return
    const id = `nxos.ospf-key:${fieldPath(...at)}`
    if (kind === 'key-chain') {
      const chain = answer(id, /^\S{1,63}$/)
      if (chain !== undefined) emit(`  ip ospf authentication key-chain ${chain}`, field)
      else {
        skip(field, 'unsupported', 'needs the name of its key chain, which the model doesn\'t carry')
        needsInput.push({ id, kind: 'secret', message: 'OSPF authentication with a key chain on an interface needs the key chain\'s name.', field: fieldPath(...field) })
      }
      return
    }
    if (own !== undefined) emit(own === 'md5' ? '  ip ospf authentication message-digest' : '  ip ospf authentication', field)
    const key = answer(id, kind === 'md5' ? /^(?:[1-9]\d?|1\d\d|2[0-4]\d|25[0-5])\s+\S{1,16}$/ : /^\S{1,8}$/)
    if (key === undefined) {
      needsInput.push({ id, kind: 'secret', message: kind === 'md5' ? 'OSPF MD5 authentication on an interface needs its key ID (1 to 255) and key, as "ID KEY": the key isn\'t carried.' : 'OSPF authentication on an interface needs its key (up to 8 characters): the key isn\'t carried.', field: fieldPath(...field) })
      return
    }
    if (kind === 'md5') {
      const [keyId, secret] = key.split(/\s+/)
      emit(`  ip ospf message-digest-key ${keyId} md5 0 ${secret}`)
    } else emit(`  ip ospf authentication-key 0 ${key}`)
  }

  /** The user's answer to a needs-input item when NX-OS takes it, else undefined (with a warning when it doesn't). */
  function answer(id: string, valid: RegExp): string | undefined {
    const given = context.inputs && Object.hasOwn(context.inputs, id) ? context.inputs[id].trim() : undefined
    if (given === undefined || valid.test(given)) return given
    // The answer may be a secret: not repeated.
    diagnostics.push({ severity: 'warning', category: 'other', code: 'nxos.answer-not-taken', message: 'An answer to a needs-input item isn\'t one NX-OS takes, so it isn\'t used.' })
    return undefined
  }

  /** Each `router ospf TAG`: the global table's settings, then each VRF's under `vrf V`. */
  function renderOspfProcesses() {
    const byTag = new Map<string, [instance: string, o: Ospf][]>()
    for (const [instance, ni] of Object.entries(model.networkInstances ?? {}).sort(([a], [b]) => (a === 'default' ? -1 : b === 'default' ? 1 : 0))) {
      if (!ni.ospf) continue
      const tag = ospfTag(ni.ospf)
      const at = ['networkInstances', instance, 'ospf']
      if (!OSPF_TAG.test(tag)) {
        skipAll(ni.ospf, at, 'not a process tag NX-OS takes')
        continue
      }
      if (ni.ospf.processId === undefined) diagnostics.push({ severity: 'info', category: 'other', code: 'nxos.ospf-process-tag', message: 'The source gives OSPF no process tag: NX-OS needs one, and it is written as 1.', field: fieldPath(...at) })
      byTag.set(tag, [...(byTag.get(tag) ?? []), [instance, ni.ospf]])
    }
    for (const [tag, list] of byTag) {
      separator()
      const global = list.find(([i]) => i === 'default')
      emit(`router ospf ${tag}`, ...(global ? ospfFields(global[1]) : []))
      if (global) renderOspfSettings('default', global[1], '  ')
      for (const [instance, o] of list) {
        if (instance === 'default') continue
        emit(`  vrf ${instance}`, ...ospfFields(o, instance))
        renderOspfSettings(instance, o, '    ')
      }
    }
    for (const instance of networkEnabled) {
      diagnostics.push({ severity: 'warning', category: 'semantic', code: 'nxos.ospf-enabled-per-interface', message: 'The source enabled OSPF with network statements: NX-OS enables it on each interface, so an interface added later in the same range doesn\'t join OSPF by itself.', field: fieldPath('networkInstances', instance, 'ospf') })
    }
  }

  /** The fields a `router ospf` or `vrf` line says: the process tag, or OSPF configured with nothing in it. */
  function ospfFields(o: Ospf, instance = 'default'): Segments[] {
    const at = ['networkInstances', instance, 'ospf']
    return [...(o.processId !== undefined ? [[...at, 'processId']] : []), ...(isEmpty(o) ? [at] : [])]
  }

  function renderOspfSettings(instance: string, o: Ospf, indent: string) {
    const at = ['networkInstances', instance, 'ospf']
    if (o.routerId !== undefined) {
      if (isIpv4(o.routerId)) emit(`${indent}router-id ${o.routerId}`, [...at, 'routerId'])
      else skip([...at, 'routerId'], 'unsupported', 'not an IPv4 address')
    }
    emptyContainer(o.areas, [...at, 'areas'])
    for (const [area, a] of Object.entries(o.areas ?? {})) {
      const aAt = [...at, 'areas', area]
      if (!isIpv4(area)) {
        skipAll({ ...a, interfaces: undefined }, aAt, 'not an area in dotted form')
        continue
      }
      if (isEmpty(a)) skip(aAt, 'not-applicable', 'an area with nothing in it: NX-OS has an area where an interface or a setting puts one')
      emptyContainer(a.interfaces, [...aAt, 'interfaces'])
      if (a.type === 'normal') skip([...aAt, 'type'], 'not-applicable', 'an area is normal unless it is a stub or an NSSA')
      else if (a.type !== undefined && area === '0.0.0.0') skip([...aAt, 'type'], 'unsupported', 'the backbone area is never a stub or NSSA')
      else if (a.type !== undefined) emit(`${indent}area ${area} ${a.type}`, [...aAt, 'type'])
      if (a.authentication === 'key-chain') skip([...aAt, 'authentication'], 'unsupported', 'NX-OS names a key chain on each interface, not for an area')
      else if (a.authentication !== undefined) emit(`${indent}area ${area} authentication${a.authentication === 'md5' ? ' message-digest' : ''}`, [...aAt, 'authentication'])
    }
  }

  // ---- BGP

  /** `router bgp ASN`, the global table's BGP, then each VRF's under `vrf V`. NX-OS runs one BGP process. */
  function renderBgp() {
    const list = Object.entries(model.networkInstances ?? {})
      .flatMap(([name, ni]): [string, Bgp][] => (ni.bgp ? [[name, ni.bgp]] : []))
      .sort(([a], [b]) => (a === 'default' ? -1 : b === 'default' ? 1 : 0))
    if (!list.length) return
    const local = list.find(([, b]) => b.localAs !== undefined)?.[1].localAs
    if (local === undefined || !isAsNumber(local)) {
      for (const [instance, b] of list) skipAll(b, ['networkInstances', instance, 'bgp'], 'BGP needs a local AS, which the model doesn\'t give')
      return
    }
    separator()
    const global = list.find(([i]) => i === 'default')?.[1]
    emit(`router bgp ${local}`, ...(global ? bgpFields('default', global, local) : []))
    for (const [instance, b] of list) {
      const at = ['networkInstances', instance, 'bgp']
      const indent = instance === 'default' ? '  ' : '    '
      // The source platform's default for an eBGP peer with no policy: NX-OS has its own (it accepts), warned on per neighbor.
      for (const side of ['import', 'export'] as const) if (b.ebgpDefaultPolicy?.[side] !== undefined) skip([...at, 'ebgpDefaultPolicy', side], 'not-applicable', 'the source platform\'s default, not configuration: NX-OS\'s own is to exchange every route')
      if (instance !== 'default') emit(`  vrf ${instance}`, ...bgpFields(instance, b, local))
      if (b.routerId !== undefined) {
        if (isIpv4(b.routerId)) emit(`${indent}router-id ${b.routerId}`, [...at, 'routerId'])
        else skip([...at, 'routerId'], 'unsupported', 'not an IPv4 address')
      }
      // NX-OS carries a family to a neighbor only when the process has it too: each family a peer carries.
      const families = new Set(Object.values({ ...b.groups, ...b.neighbors }).flatMap((p) => Object.keys(p.addressFamilies ?? {})))
      for (const family of FAMILIES) if (families.has(family)) emit(`${indent}address-family ${family.replace('-', ' ')}`)
      emptyContainer(b.groups, [...at, 'groups'])
      emptyContainer(b.neighbors, [...at, 'neighbors'])
      for (const [name, group] of Object.entries(b.groups ?? {})) {
        if (instance !== 'default') skipAll(group, [...at, 'groups', name], 'a group in a VRF: NX-OS\'s peer templates belong to the whole process')
        else if (!/^\S+$/.test(name)) skipAll(group, [...at, 'groups', name], 'not a template name NX-OS takes')
        else renderPeer(`template peer ${name}`, group, [...at, 'groups', name], indent, local)
      }
      for (const [address, neighbor] of Object.entries(b.neighbors ?? {})) {
        const nAt = [...at, 'neighbors', address]
        if (!isIpv4(address) && !isIpv6(address)) {
          skipAll(neighbor, nAt, 'not a neighbor address')
          continue
        }
        const group = neighbor.group !== undefined && instance === 'default' && b.groups && Object.hasOwn(b.groups, neighbor.group) && /^\S+$/.test(neighbor.group) ? b.groups[neighbor.group] : undefined
        renderPeer(`neighbor ${address}`, neighbor, nAt, indent, local, group)
        bgpWarnings(neighbor, nAt, local, group)
      }
    }
  }

  /** The fields a `router bgp` or `vrf` line says: the local AS (NX-OS's is the process's), or BGP with nothing in it. */
  function bgpFields(instance: string, b: Bgp, local: number): Segments[] {
    const at = ['networkInstances', instance, 'bgp']
    if (b.localAs !== undefined && b.localAs !== local) skip([...at, 'localAs'], 'unsupported', 'a VRF\'s own local AS: NX-OS runs one BGP process, with one AS')
    return [...(b.localAs === local ? [[...at, 'localAs']] : []), ...(isEmpty(b) ? [at] : [])]
  }

  /** A neighbor or a template, with its families and their route maps. `group` is a neighbor's template, when written. */
  function renderPeer(header: string, peer: BgpGroup & BgpNeighbor, at: Segments, indent: string, local: number, group?: BgpGroup) {
    const inner = `${indent}  `
    emit(`${indent}${header}`, ...(isEmpty(peer) ? [at] : []))
    if (peer.group !== undefined) {
      if (group) emit(`${inner}inherit peer ${peer.group}`, [...at, 'group'])
      else skip([...at, 'group'], 'unsupported', 'a group NX-OS can\'t write as a template of the global table')
    }
    if (peer.peerAs !== undefined) {
      if (isAsNumber(peer.peerAs)) emit(`${inner}remote-as ${peer.peerAs}`, [...at, 'peerAs'])
      else skip([...at, 'peerAs'], 'unsupported', 'not an AS number from 1 to 4294967295')
    }
    if (peer.type !== undefined) {
      // An internal group's peers are in the local AS: said with remote-as when nothing else says it.
      if (peer.type === 'internal' && peer.peerAs === undefined) emit(`${inner}remote-as ${local}`, [...at, 'type'])
      else skip([...at, 'type'], 'not-applicable', 'NX-OS tells iBGP from eBGP by the remote AS')
    }
    if (peer.description !== undefined) emit(`${inner}description ${peer.description}`, [...at, 'description'])
    if (peer.localAddress !== undefined) skip([...at, 'localAddress'], 'unsupported', 'NX-OS sources a session from an interface (update-source), not an address')
    if (peer.updateSource !== undefined) emit(`${inner}update-source ${peer.updateSource}`, [...at, 'updateSource'])
    if (peer.multihop !== undefined) {
      const ttl = peer.multihop.ttl
      if (ttl === undefined) skip([...at, 'multihop'], 'unsupported', 'NX-OS\'s ebgp-multihop needs a TTL, which the source doesn\'t give')
      else if (Number.isInteger(ttl) && ttl >= 2 && ttl <= 255) emit(`${inner}ebgp-multihop ${ttl}`, [...at, 'multihop', 'ttl'])
      else skip([...at, 'multihop', 'ttl'], 'unsupported', 'not a TTL from 2 to 255')
    }
    if (peer.authentication === false) skip([...at, 'authentication'], 'not-applicable', 'no password: nothing to write')
    else if (peer.authentication) {
      // The password is never carried: a needs-input item asks for it, and the answer is written.
      const id = `nxos.bgp-password:${fieldPath(...at)}`
      const password = answer(id, /^\S{1,80}$/)
      if (password !== undefined) emit(`${inner}password 0 ${password}`, [...at, 'authentication'])
      else {
        skip([...at, 'authentication'], 'unsupported', 'needs the password, which isn\'t carried')
        needsInput.push({ id, kind: 'secret', message: 'A BGP session with a password needs the password, which isn\'t carried.', field: fieldPath(...at, 'authentication') })
      }
    }
    renderPeerFamilies(peer, at, inner, group)
  }

  /**
   * A peer's address families, each with its route maps: NX-OS applies them per family, one each way. A policy given for
   * the whole peer goes into each family it carries (its template's too), unless the family has its own.
   */
  function renderPeerFamilies(peer: BgpPeer, at: Segments, indent: string, group?: BgpGroup) {
    const known = (name: string) => model.routingPolicy?.policies !== undefined && Object.hasOwn(model.routingPolicy.policies, name)
    const own = peer.addressFamilies ?? {}
    emptyContainer(own, [...at, 'addressFamilies'])
    for (const family of Object.keys(own)) if (!(FAMILIES as readonly string[]).includes(family)) skipAll(own[family as BgpAddressFamilyName], [...at, 'addressFamilies', family], 'an address family NX-OS\'s phase 2 rendering doesn\'t write')
    const families = FAMILIES.filter((f) => own[f] !== undefined || ((peer.importPolicies || peer.exportPolicies) && group?.addressFamilies?.[f] !== undefined))
    const peerLevel: Record<'importPolicies' | 'exportPolicies', boolean> = { importPolicies: false, exportPolicies: false }
    let maps = 0
    for (const family of families) {
      const af = own[family]
      const afAt = [...at, 'addressFamilies', family]
      emit(`${indent}address-family ${family.replace('-', ' ')}`, ...(af !== undefined && isEmpty(af) ? [afAt] : []))
      for (const [field, direction] of [['importPolicies', 'in'], ['exportPolicies', 'out']] as const) {
        const list = af?.[field] ?? peer[field]
        const where = af?.[field] !== undefined ? [...afAt, field] : [...at, field]
        if (list === undefined) continue
        if (!list.length) skip(where, 'not-applicable', 'no policy: nothing to write')
        else if (list.length > 1) skip(where, 'unsupported', 'NX-OS applies one route map each way: a chain of policies isn\'t written')
        else if (!/^\S{1,63}$/.test(list[0])) skip(where, 'unsupported', 'not a route map name NX-OS takes')
        // A policy of the model is named only when it is written; one the model doesn't have (from a source that keeps
        // policy names alone, before model 0.5.0) is named alone, with a warning.
        else if (known(list[0]) && !policyPlan.policies.has(list[0])) skip(where, 'unsupported', 'names a policy NX-OS can\'t write as a route map')
        else {
          emit(`${indent}  route-map ${list[0]} ${direction}`, ...(af?.[field] !== undefined || !peerLevel[field] ? [where] : []))
          if (af?.[field] === undefined) peerLevel[field] = true
          if (!known(list[0])) maps++
        }
      }
    }
    for (const field of ['importPolicies', 'exportPolicies'] as const) {
      if (peer[field] === undefined || peerLevel[field] || Object.hasOwn(dispositions, fieldPath(...at, field))) continue
      skip([...at, field], 'unsupported', families.length ? 'every family the peer carries has its own policy' : 'NX-OS applies a route map per address family, and the peer carries none')
    }
    if (maps) diagnostics.push({ severity: 'warning', category: 'semantic', code: 'nxos.route-map-name-only', message: 'A policy is written as a route map by its name only: the model has no body for it, so NX-OS needs a route map of that name.', field: fieldPath(...at) })
  }

  /**
   * The semantic warnings a neighbor raises: an eBGP neighbor with no policy one way, where the source dropped those
   * routes (its `ebgpDefaultPolicy` is `reject` that way, IOS-XR's RFC 8212) and NX-OS exchanges them all; and no family.
   */
  function bgpWarnings(neighbor: BgpNeighbor, at: Segments, local: number, group?: BgpGroup) {
    const peerAs = neighbor.peerAs ?? group?.peerAs ?? (group?.type === 'internal' ? local : undefined)
    const source = model.networkInstances?.[String(at[1])]?.bgp?.ebgpDefaultPolicy
    // Each family it carries (its own or its group's) by its effective policy: the family's own, else the neighbor's,
    // else the group's family's, else the group's. With no family, the neighbor's or the group's.
    const families = [...new Set([...Object.keys(neighbor.addressFamilies ?? {}), ...Object.keys(group?.addressFamilies ?? {})])] as BgpAddressFamilyName[]
    const missing = (field: 'importPolicies' | 'exportPolicies') => {
      const effective = (f?: BgpAddressFamilyName) => (f ? neighbor.addressFamilies?.[f]?.[field] : undefined) ?? neighbor[field] ?? (f ? group?.addressFamilies?.[f]?.[field] : undefined) ?? group?.[field]
      return families.length ? families.some((f) => !effective(f)?.length) : !effective()?.length
    }
    const dropped = (['import', 'export'] as const).some((side) => source?.[side] === 'reject' && missing(side === 'import' ? 'importPolicies' : 'exportPolicies'))
    if (peerAs !== undefined && peerAs !== local && dropped) {
      diagnostics.push({ severity: 'warning', category: 'semantic', code: 'nxos.ebgp-default-policy', message: 'The source drops an eBGP neighbor\'s routes with no policy (RFC 8212), where NX-OS exchanges them all: the neighbor needs a route map to do as the source did.', field: fieldPath(...at) })
    }
    if (!Object.keys(neighbor.addressFamilies ?? {}).length && !Object.keys(group?.addressFamilies ?? {}).length) {
      diagnostics.push({ severity: 'warning', category: 'semantic', code: 'nxos.bgp-no-address-family', message: 'A BGP neighbor has no address family: on NX-OS it carries no routes until one is configured.', field: fieldPath(...at) })
    }
  }

  // Routing policy is planned first, as BGP writes a route map only when its policy is written (renderPolicy.ts).
  const policyPlan = planRoutingPolicy(model.routingPolicy, skip, skipAll)
  renderOspfProcesses()
  renderBgp()
  if (policyPlan.lines.length) separator()
  for (const l of policyPlan.lines) {
    // Each route map sequence is a block of its own, as NX-OS shows them.
    if (l.text.startsWith('route-map ')) separator()
    emit(l.text, ...l.fields)
    const n = lines.length
    if (l.warning) diagnostics.push({ ...l.warning, span: { startLine: n, startColumn: 1, endLine: n, endColumn: l.text.length + 1 } })
  }
  // Access lists, each a block of its own.
  for (const l of aclPlan.lines) {
    if (!l.text.startsWith(' ')) separator()
    emit(l.text, ...l.fields)
    const n = lines.length
    if (l.warning) diagnostics.push({ ...l.warning, span: { startLine: n, startColumn: 1, endLine: n, endColumn: l.text.length + 1 } })
  }

  return { text: `${lines.join('\n')}\n`, dispositions, diagnostics, ...(needsInput.length ? { needsInput } : {}) }
}
