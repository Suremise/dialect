// The shared model → IOS-XR text, in the shape `show running-config` gives: one-space indents, each block closed by
// `!`. Every populated leaf of model 0.5.2 gets a disposition (routing policy in renderPolicy.ts): `rendered` with the line it went to, `unsupported` with why
// (IOS-XR can't say it, or this renderer can't yet), or `not-applicable` (IOS-XR implies it). Fields of a later model
// version are left without one, so the ledger reports them as unrendered rather than this renderer claiming them.
// Secrets the model only flags (an OSPF key, a BGP password) and an eBGP neighbor's missing route policy (RFC 8212) are
// needs-input items, written when answered (Context.inputs) and never made up.
import { fieldPath, isAsNumber, isRouteDistinguisher, populatedLeaves, type AddressFamily, type Bgp, type BgpAddressFamilyName, type BgpGroup, type BgpNeighbor, type Context, type Device, type Diagnostic, type FieldDisposition, type Interface, type NeedsInput, type NetworkInstance, type Ospf, type OspfAuthentication, type RenderResult, type StaticRoute, type Subinterface, type SyslogSeverity } from '@dialect/core'
import { isIpv4, isIpv6, lengthMask } from './addresses'
import { BUNDLE_ID, inRange, MTU, PORT, ROUTE_TAG, VLAN_ID } from './parse'
import { RPL_NAME } from './policy'
import { planFilters } from './renderFilters'
import { planRoutingPolicy } from './renderPolicy'

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
/** An OSPF process name IOS-XR takes: up to 32 letters, digits and `_.-`. */
const OSPF_TAG = /^[\w.-]{1,32}$/
/** The BGP address families phase 2 writes, in order. */
const FAMILIES = ['ipv4-unicast', 'ipv6-unicast'] as const satisfies readonly BgpAddressFamilyName[]
/** A neighbor group name IOS-XR takes. */
const GROUP_NAME = /^\S+$/
/** A bundle's number from its name (`Bundle-Ether1` is 1, from 1 to 65535), or null when it isn't one. */
const bundleId = (name: string): number | null => {
  const m = /^Bundle-Ether(\d{1,5})$/.exec(name)
  return m && inRange(m[1], BUNDLE_ID) ? Number(m[1]) : null
}
/** A value as JSON with its objects' keys in order: two values that say the same are the same string. */
const canonical = (value: unknown): string => JSON.stringify(value, (_key, v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v))

/** A neighbor group written for the whole router bgp: the group, where in the model it is, and its VRFs' copies. */
interface SharedGroup {
  readonly group: BgpGroup
  readonly at: Segments
  readonly copies: Segments[]
}

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
  // The routing policy, planned first: a VRF or a BGP peer names a route policy only when it is written.
  const policyPlan = planRoutingPolicy(model.routingPolicy, skip, skipAll)
  // The access lists (model 0.5.1), planned before the interfaces, which apply one only when it is written.
  const filterPlan = planFilters(model.filters, skip, skipAll)
  /**
   * How a route policy a VRF or peer names is written: by name when the policy is written, or when the model has no
   * policy of that name at all (a source that keeps policy names alone), with a warning; not when the model's policy
   * of that name can't be written.
   */
  const policyName = (name: string): 'written' | 'name-only' | 'not-written' =>
    policyPlan.policies.has(name) ? 'written' : model.routingPolicy?.policies && Object.hasOwn(model.routingPolicy.policies, name) ? 'not-written' : 'name-only'

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
      for (const leaf of ['importPolicies', 'exportPolicies'] as const) if (instance[leaf] !== undefined) skip([...at, leaf], 'unsupported', 'the global routing table has no VRF import or export policy')
      if (instance.vrfPolicyMode !== undefined) skip([...at, 'vrfPolicyMode'], 'not-applicable', 'the global routing table has no VRF policies')
      continue
    }
    // An instance with only routes (`router static vrf V` with no `vrf V`): its routes say it, under router static.
    if (instance.type === undefined && instance.routeDistinguisher === undefined && instance.routeTargets === undefined && instance.importPolicies === undefined && instance.exportPolicies === undefined && !isEmpty(instance)) continue
    renderVrf(name, instance, at)
  }

  function renderVrf(name: string, instance: NetworkInstance, at: Segments) {
    const fields: Segments[] = isEmpty(instance) ? [at] : []
    if (instance.type === 'vrf') fields.push([...at, 'type'])
    else if (instance.type !== undefined) skip([...at, 'type'], 'unsupported', 'IOS-XR\'s global table is "default": another instance is a VRF')
    // Its route distinguisher is BGP's on IOS-XR: written under router bgp.
    emit(`vrf ${name}`, ...fields)
    renderVrfFamilies(instance, at)
    close()
  }

  /**
   * A VRF's route targets and its own import and export policies (model 0.5.2): IOS-XR sets them per address family, and
   * the model's are the VRF's, so they go under both IPv4 and IPv6 unicast, the route targets in the block form. Each
   * list is one field (a leaf-list), marked on its first line. IOS-XR's policy filters what the route targets import or
   * export: a source whose policy replaces them (Junos) gets a warning.
   */
  function renderVrfFamilies(instance: NetworkInstance, vrfAt: Segments) {
    const targets = instance.routeTargets
    const at = [...vrfAt, 'routeTargets']
    const lists: [direction: 'import' | 'export', values: readonly string[]][] = []
    if (targets !== undefined) {
      emptyContainer(targets, at)
      for (const direction of ['import', 'export'] as const) {
        const values = targets[direction]
        if (values === undefined) continue
        if (!values.length) skip([...at, direction], 'not-applicable', 'an empty list: nothing to write')
        else if (!values.every(isRouteDistinguisher)) skip([...at, direction], 'unsupported', 'a route target not in the form ASN:nn, IP:nn or ASN4:nn')
        else lists.push([direction, values])
      }
    }
    const policies: [direction: 'import' | 'export', name: string][] = []
    for (const direction of ['import', 'export'] as const) {
      const list = instance[`${direction}Policies`]
      const field = [...vrfAt, `${direction}Policies`]
      if (list === undefined) continue
      const how = list.length === 1 ? policyName(list[0]) : undefined
      if (!list.length) skip(field, 'not-applicable', 'no policy: nothing to write')
      else if (list.length > 1) skip(field, 'unsupported', 'IOS-XR applies one route policy each way to a VRF: a chain of policies isn\'t written')
      else if (!RPL_NAME.test(list[0])) skip(field, 'unsupported', 'not a route policy name IOS-XR takes')
      else if (how === 'not-written') skip(field, 'unsupported', 'names a policy IOS-XR can\'t write')
      else policies.push([direction, list[0]])
    }
    const mode = instance.vrfPolicyMode
    if (mode !== undefined) {
      skip([...vrfAt, 'vrfPolicyMode'], 'not-applicable', 'the source platform\'s semantics: IOS-XR\'s VRF policy filters what the route targets import or export')
      if (mode === 'replaces-route-targets' && policies.length)
        diagnostics.push({ severity: 'warning', category: 'semantic', code: 'iosxr.vrf-policy-mode', message: 'The source\'s VRF import or export policy replaces the VRF\'s route targets (it matches or adds them itself), where IOS-XR\'s filters what the route targets import or export: check the route targets and the policy together.', field: fieldPath(...vrfAt, 'vrfPolicyMode') })
    }
    if (!lists.length && !policies.length) return
    for (const family of ['ipv4', 'ipv6']) {
      emit(` address-family ${family} unicast`)
      for (const [direction, name] of policies) {
        emit(`  ${direction} route-policy ${name}`, ...(family === 'ipv4' ? [[...vrfAt, `${direction}Policies`]] : []))
        if (family === 'ipv4' && policyName(name) === 'name-only')
          diagnostics.push({ severity: 'warning', category: 'semantic', code: 'iosxr.route-policy-name-only', message: 'A policy is written as a route policy by its name only: its body isn\'t in the model, so IOS-XR needs a route policy of that name.', field: fieldPath(...vrfAt, `${direction}Policies`) })
      }
      for (const [direction, values] of lists) {
        emit(`  ${direction} route-target`)
        values.forEach((v, i) => emit(`   ${v}`, ...(family === 'ipv4' && i === 0 ? [[...at, direction]] : [])))
        close('  ')
      }
      close(' ')
    }
  }

  // ---- access lists, before the interfaces that apply them

  for (const l of filterPlan.lines) {
    emit(l.text, ...l.fields)
    if (l.warning) diagnostics.push({ ...l.warning, span: { startLine: lines.length, startColumn: 1, endLine: lines.length, endColumn: l.text.length + 1 } })
  }

  // ---- interfaces

  /** Each bundle's first member link written (`bundle id N`), whose line carries the bundle's LACP mode. */
  const firstMembers = new Map<string, string>()
  for (const [name, iface] of Object.entries(model.interfaces ?? {})) {
    const aggregate = iface.aggregate
    if (aggregate !== undefined && bundleId(aggregate) !== null && bundleId(name) === null && iface.type !== 'aggregate' && !firstMembers.has(aggregate)) firstMembers.set(aggregate, name)
  }
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
    if (iface.mtu !== undefined) {
      if (inRange(iface.mtu, MTU)) emit(` mtu ${iface.mtu}`, [...at, 'mtu'])
      else skip([...at, 'mtu'], 'unsupported', `IOS-XR takes an MTU from ${MTU.min} to ${MTU.max}`)
    }
    renderLag(name, iface, at)
    if (main) {
      const sub = [...at, 'subinterfaces', '0']
      if (isEmpty(main)) skip(sub, 'not-applicable', 'IOS-XR has no subinterface 0 of its own: the main interface is it')
      if (main.description !== undefined) skip([...sub, 'description'], 'unsupported', 'IOS-XR has one description for the main interface')
      if (main.enabled !== undefined) skip([...sub, 'enabled'], 'unsupported', 'IOS-XR has one shutdown for the main interface')
      if (main.vlanId !== undefined) skip([...sub, 'vlanId'], 'unsupported', 'IOS-XR has no subinterface 0 to tag')
      if (renderMembership(main, sub)) renderAddresses(main, sub)
      renderAccessGroups(main, sub)
    }
    if (iface.enabled !== undefined) emit(iface.enabled ? ' no shutdown' : ' shutdown', [...at, 'enabled'])
    close()

    for (const [index, sub] of subs) {
      if (index === '0') continue
      const subAt = [...at, 'subinterfaces', index]
      emit(`interface ${name}.${index}`, ...(isEmpty(sub) ? [subAt] : []))
      if (sub.description !== undefined) emit(` description ${sub.description}`, [...subAt, 'description'])
      if (renderMembership(sub, subAt)) renderAddresses(sub, subAt)
      renderAccessGroups(sub, subAt)
      if (sub.vlanId !== undefined) {
        if (inRange(sub.vlanId, VLAN_ID)) emit(` encapsulation dot1q ${sub.vlanId}`, [...subAt, 'vlanId'])
        else skip([...subAt, 'vlanId'], 'unsupported', `IOS-XR takes a VLAN ID from ${VLAN_ID.min} to ${VLAN_ID.max}`)
      }
      if (sub.enabled !== undefined) emit(sub.enabled ? ' no shutdown' : ' shutdown', [...subAt, 'enabled'])
      close()
    }
  }

  /**
   * A member link's `bundle id N [mode active|passive|on]`, with its bundle's LACP mode (IOS-XR gives it on each member;
   * `static` is `mode on`, and no mode says nothing), and a bundle's `bundle minimum-active links N`.
   */
  function renderLag(name: string, iface: Interface, at: Segments) {
    if (iface.aggregate !== undefined) {
      const field = [...at, 'aggregate']
      const id = bundleId(iface.aggregate)
      if (id === null) skip(field, 'unsupported', 'IOS-XR names a bundle Bundle-EtherN, N from 1 to 65535: name it in the interface map')
      else if (bundleId(name) !== null || iface.type === 'aggregate') skip(field, 'unsupported', 'a bundle as a member link of another, which IOS-XR refuses')
      else {
        const lacp = model.interfaces?.[iface.aggregate]?.aggregation?.lacp
        const mode = lacp === 'static' ? 'on' : lacp === 'active' || lacp === 'passive' ? lacp : undefined
        const fields = [field, ...(mode !== undefined && firstMembers.get(iface.aggregate) === name ? [['interfaces', iface.aggregate, 'aggregation', 'lacp']] : [])]
        emit(` bundle id ${id}${mode !== undefined ? ` mode ${mode}` : ''}`, ...fields)
      }
    }
    const lag = iface.aggregation
    if (lag === undefined) return
    const a = [...at, 'aggregation']
    emptyContainer(lag, a)
    if (bundleId(name) === null) return skipAll(lag, a, 'IOS-XR names a bundle Bundle-EtherN, N from 1 to 65535: name it in the interface map')
    if (lag.lacp !== undefined) {
      if (lag.lacp !== 'active' && lag.lacp !== 'passive' && lag.lacp !== 'static') skip([...a, 'lacp'], 'unsupported', 'not an LACP mode')
      else if (!firstMembers.has(name)) skip([...a, 'lacp'], 'unsupported', 'IOS-XR gives the LACP mode on each member link (bundle id N mode …), and the bundle has none written')
    }
    if (lag.minLinks !== undefined) {
      if (Number.isInteger(lag.minLinks) && lag.minLinks >= 1 && lag.minLinks <= 64) emit(` bundle minimum-active links ${lag.minLinks}`, [...a, 'minLinks'])
      else skip([...a, 'minLinks'], 'unsupported', 'IOS-XR takes minimum active links from 1 to 64')
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

  /** A subinterface's filters (model 0.5.1): `ipv4|ipv6 access-group NAME ingress|egress`, for a list written. */
  function renderAccessGroups(sub: Subinterface, at: Segments) {
    const filters = sub.filters
    if (filters === undefined) return
    emptyContainer(filters, [...at, 'filters'])
    for (const family of ['ipv4', 'ipv6'] as const) {
      const directions = filters[family]
      if (directions === undefined) continue
      emptyContainer(directions, [...at, 'filters', family])
      for (const [direction, keyword] of [['input', 'ingress'], ['output', 'egress']] as const) {
        const name = directions[direction]
        if (name === undefined) continue
        const field = [...at, 'filters', family, direction]
        if (filterPlan.written[family].has(name)) emit(` ${family} access-group ${name} ${keyword}`, field)
        else skip(field, 'unsupported', 'applies a filter IOS-XR can\'t write as an access list')
      }
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
        if (inRange(hop.tag, ROUTE_TAG)) {
          parts.push(`tag ${hop.tag}`)
          fields.push([...h, 'tag'])
        } else skip([...h, 'tag'], 'unsupported', `IOS-XR takes a route tag from ${ROUTE_TAG.min} to ${ROUTE_TAG.max}`)
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

  // ---- Layer 2: not this phase on IOS-XR (l2vpn and bridge domains), apart from tagged subinterfaces

  emptyContainer(model.vlans, ['vlans'])
  for (const [id, vlan] of Object.entries(model.vlans ?? {})) skipAll(vlan, ['vlans', id], 'IOS-XR\'s Layer 2 (bridge domains) isn\'t written yet')
  for (const [name, iface] of Object.entries(model.interfaces ?? {})) {
    if (iface.switching) skipAll(iface.switching, ['interfaces', name, 'switching'], 'IOS-XR\'s Layer 2 (l2transport, bridge domains) isn\'t written yet')
    for (const [index, sub] of Object.entries(iface.subinterfaces ?? {})) {
      if (sub.routedVlan !== undefined) skip(['interfaces', name, 'subinterfaces', index, 'routedVlan'], 'unsupported', 'a routed VLAN interface is a BVI on IOS-XR, with Layer 2, which isn\'t written yet')
    }
  }

  // ---- OSPF

  /** The network instances whose OSPF the source enabled with `network` statements, for the warning. */
  const networkEnabled = new Set<string>()

  /** Each network instance's OSPF, under `router ospf P`: the global table's, then each VRF's under `vrf V`. */
  function renderOspf() {
    const byTag = new Map<string, [instance: string, o: Ospf][]>()
    for (const [instance, ni] of Object.entries(model.networkInstances ?? {}).sort(([a], [b]) => (a === 'default' ? -1 : b === 'default' ? 1 : 0))) {
      if (!ni.ospf) continue
      const tag = ni.ospf.processId ?? '1'
      const at = ['networkInstances', instance, 'ospf']
      if (!OSPF_TAG.test(tag)) {
        skipAll(ni.ospf, at, 'not a process name IOS-XR takes')
        continue
      }
      if (instance !== 'default' && model.networkInstances?.[instance]?.type !== 'vrf') {
        skipAll(ni.ospf, at, 'OSPF in an instance IOS-XR doesn\'t write as a VRF')
        continue
      }
      if (ni.ospf.processId === undefined) diagnostics.push({ severity: 'info', category: 'other', code: 'iosxr.ospf-process-name', message: 'The source gives OSPF no process name: IOS-XR needs one, and it is written as 1.', field: fieldPath(...at) })
      byTag.set(tag, [...(byTag.get(tag) ?? []), [instance, ni.ospf]])
    }
    for (const [tag, list] of byTag) {
      const global = list.find(([i]) => i === 'default')
      emit(`router ospf ${tag}`, ...(global ? ospfFields('default', global[1]) : []))
      if (global) renderOspfInstance('default', global[1], ' ')
      for (const [instance, o] of list) {
        if (instance === 'default') continue
        emit(` vrf ${instance}`, ...ospfFields(instance, o))
        renderOspfInstance(instance, o, '  ')
        close(' ')
      }
      close()
    }
    for (const instance of networkEnabled) {
      diagnostics.push({ severity: 'warning', category: 'semantic', code: 'iosxr.ospf-enabled-per-interface', message: 'The source enabled OSPF with network statements: IOS-XR lists each interface under its area, so an interface added later in the same range doesn\'t join OSPF by itself.', field: fieldPath('networkInstances', instance, 'ospf') })
    }
  }

  /** The fields a `router ospf` or `vrf` line says: the process name, or OSPF configured with nothing in it. */
  function ospfFields(instance: string, o: Ospf): Segments[] {
    const at = ['networkInstances', instance, 'ospf']
    return [...(o.processId !== undefined ? [[...at, 'processId']] : []), ...(isEmpty(o) ? [at] : [])]
  }

  function renderOspfInstance(instance: string, o: Ospf, indent: string) {
    const at = ['networkInstances', instance, 'ospf']
    if (o.routerId !== undefined) {
      if (isIpv4(o.routerId)) emit(`${indent}router-id ${o.routerId}`, [...at, 'routerId'])
      else skip([...at, 'routerId'], 'unsupported', 'not an IPv4 address')
    }
    emptyContainer(o.areas, [...at, 'areas'])
    /** Interfaces already in an area: IOS-XR puts one in one area of a process. */
    const seen = new Set<string>()
    for (const [area, a] of Object.entries(o.areas ?? {})) {
      const aAt = [...at, 'areas', area]
      if (!isIpv4(area)) {
        skipAll(a, aAt, 'not an area in dotted form')
        continue
      }
      emit(`${indent}area ${area}`, ...(isEmpty(a) ? [aAt] : []))
      const inner = `${indent} `
      if (a.authentication === 'key-chain') {
        // The key chain's name isn't in the model: asked for, as on an interface.
        const id = `iosxr.ospf-key:${fieldPath(...aAt)}`
        const chain = answer(id, /^\S{1,32}$/)
        if (chain !== undefined) emit(`${inner}authentication keychain ${chain}`, [...aAt, 'authentication'])
        else {
          skip([...aAt, 'authentication'], 'unsupported', 'needs the name of its key chain, which the model doesn\'t carry')
          needsInput.push({ id, kind: 'secret', message: 'OSPF authentication with a key chain for an area needs the key chain\'s name.', field: fieldPath(...aAt, 'authentication') })
        }
      } else if (a.authentication !== undefined) emit(`${inner}authentication${a.authentication === 'md5' ? ' message-digest' : ''}`, [...aAt, 'authentication'])
      if (a.type === 'normal') skip([...aAt, 'type'], 'not-applicable', 'an area is normal unless it is a stub or an NSSA')
      else if (a.type !== undefined && area === '0.0.0.0') skip([...aAt, 'type'], 'unsupported', 'the backbone area is never a stub or NSSA')
      else if (a.type !== undefined) emit(`${inner}${a.type}`, [...aAt, 'type'])
      emptyContainer(a.interfaces, [...aAt, 'interfaces'])
      for (const [ref, value] of Object.entries(a.interfaces ?? {})) {
        const iAt = [...aAt, 'interfaces', ref]
        const why = !interfaceExists(ref) ? 'names an interface the model doesn\'t have' : interfaceInstance(ref) !== instance ? 'OSPF in another network instance than its interface\'s' : seen.has(ref) ? 'a second OSPF area for the interface: IOS-XR puts one in one area' : undefined
        if (why) {
          skipAll(value, iAt, why)
          continue
        }
        seen.add(ref)
        if (value.enabledBy === 'network') networkEnabled.add(instance)
        emit(`${inner}interface ${ref}`, ...(isEmpty(value) ? [iAt] : []), ...(value.enabledBy !== undefined ? [[...iAt, 'enabledBy']] : []))
        const leaf = `${inner} `
        if (value.cost !== undefined) number(value.cost, `${leaf}cost`, [...iAt, 'cost'])
        if (value.networkType !== undefined) emit(`${leaf}network ${value.networkType}`, [...iAt, 'networkType'])
        if (value.passive === true) emit(`${leaf}passive enable`, [...iAt, 'passive'])
        else if (value.passive === false) skip([...iAt, 'passive'], 'not-applicable', 'not passive, as an interface is unless set')
        if (value.helloInterval !== undefined) number(value.helloInterval, `${leaf}hello-interval`, [...iAt, 'helloInterval'])
        if (value.deadInterval !== undefined) number(value.deadInterval, `${leaf}dead-interval`, [...iAt, 'deadInterval'])
        renderOspfAuthentication(value.authentication, a.authentication, iAt, leaf)
        close(inner)
      }
      close(indent)
    }
  }

  /** `<line> N` for an OSPF number IOS-XR takes from 1 to 65535. */
  function number(value: number, line: string, field: Segments) {
    if (inRange(value, { min: 1, max: 65535 })) emit(`${line} ${value}`, field)
    else skip(field, 'unsupported', 'not a number from 1 to 65535')
  }

  /**
   * An interface's OSPF authentication: its own type (the area's applies when it has none), and the key, which is never
   * carried: a needs-input item asks for it, and the answer is written. A key chain is named by the answer.
   */
  function renderOspfAuthentication(own: OspfAuthentication | undefined, area: OspfAuthentication | undefined, at: Segments, indent: string) {
    const kind = own ?? (area === 'key-chain' ? undefined : area)
    const field = [...at, 'authentication']
    if (kind === undefined) return
    const id = `iosxr.ospf-key:${fieldPath(...at)}`
    if (kind === 'key-chain') {
      const chain = answer(id, /^\S{1,32}$/)
      if (chain !== undefined) emit(`${indent}authentication keychain ${chain}`, field)
      else {
        skip(field, 'unsupported', 'needs the name of its key chain, which the model doesn\'t carry')
        needsInput.push({ id, kind: 'secret', message: 'OSPF authentication with a key chain on an interface needs the key chain\'s name.', field: fieldPath(...field) })
      }
      return
    }
    if (own !== undefined) emit(`${indent}authentication${own === 'md5' ? ' message-digest' : ''}`, field)
    const key = answer(id, kind === 'md5' ? /^(?:[1-9]\d?|1\d\d|2[0-4]\d|25[0-5])\s+\S{1,16}$/ : /^\S{1,8}$/)
    if (key === undefined) {
      needsInput.push({ id, kind: 'secret', message: kind === 'md5' ? 'OSPF MD5 authentication on an interface needs its key ID (1 to 255) and key, as "ID KEY": the key isn\'t carried.' : 'OSPF authentication on an interface needs its key (up to 8 characters): the key isn\'t carried.', field: fieldPath(...field) })
      return
    }
    if (kind === 'md5') {
      const [keyId, secret] = key.split(/\s+/)
      emit(`${indent}message-digest-key ${keyId} md5 clear ${secret}`)
    } else emit(`${indent}authentication-key clear ${key}`)
  }

  /** The user's answer to a needs-input item when IOS-XR takes it, else undefined (with a warning when it doesn't). */
  function answer(id: string, valid: RegExp): string | undefined {
    const given = context.inputs && Object.hasOwn(context.inputs, id) ? context.inputs[id].trim() : undefined
    if (given === undefined || valid.test(given)) return given
    // The answer may be a secret: not repeated.
    diagnostics.push({ severity: 'warning', category: 'other', code: 'iosxr.answer-not-taken', message: 'An answer to a needs-input item isn\'t one IOS-XR takes, so it isn\'t used.' })
    return undefined
  }

  /** Whether an interface reference names an interface of the model, or one of its subinterfaces. */
  function interfaceExists(ref: string): boolean {
    const interfaces = model.interfaces ?? {}
    if (Object.hasOwn(interfaces, ref)) return true
    const m = /^(.+)\.(\d+)$/.exec(ref)
    return !!m && Object.hasOwn(interfaces, m[1]) && Object.hasOwn(interfaces[m[1]].subinterfaces ?? {}, m[2])
  }

  /** The network instance an interface reference routes in. */
  function interfaceInstance(ref: string): string {
    const interfaces = model.interfaces ?? {}
    const m = /^(.+)\.(\d+)$/.exec(ref)
    const sub = Object.hasOwn(interfaces, ref) ? interfaces[ref].subinterfaces?.['0'] : m ? interfaces[m[1]]?.subinterfaces?.[m[2]] : undefined
    return sub?.networkInstance ?? 'default'
  }

  // ---- BGP

  /**
   * `router bgp ASN`: the global table's BGP, then each VRF's under `vrf V`, with the VRF's route distinguisher, which
   * IOS-XR sets there.
   */
  function renderBgp() {
    const sorted = Object.entries(model.networkInstances ?? {}).sort(([a], [b]) => (a === 'default' ? -1 : b === 'default' ? 1 : 0))
    const list = sorted.flatMap(([name, ni]): [string, Bgp][] => (ni.bgp ? [[name, ni.bgp]] : []))
    const local = list.find(([, b]) => b.localAs !== undefined)?.[1].localAs
    const distinguished = sorted.filter(([name, ni]) => name !== 'default' && ni.routeDistinguisher !== undefined)
    if (local === undefined || !isAsNumber(local)) {
      for (const [instance, b] of list) skipAll(b, ['networkInstances', instance, 'bgp'], 'BGP needs a local AS, which the model doesn\'t give')
      for (const [name] of distinguished) skip(['networkInstances', name, 'routeDistinguisher'], 'unsupported', 'IOS-XR sets a VRF\'s route distinguisher under router bgp, whose AS the model doesn\'t hold')
      return
    }
    if (!list.length && !distinguished.length) return
    const global = list.find(([i]) => i === 'default')?.[1]
    emit(`router bgp ${local}`, ...(global ? bgpFields('default', global, local) : []))
    const vrfs = new Set([...list.map(([i]) => i), ...distinguished.map(([i]) => i)].filter((i) => i !== 'default'))
    const groups = planGroups(list)
    if (global) renderBgpInstance('default', global, ' ', local, groups)
    else {
      // No BGP in the global table, but VRFs' groups written there: with the global families they carry, as above.
      const families = new Set([...groups.shared.values()].flatMap((s) => Object.keys(s.group.addressFamilies ?? {})))
      for (const family of FAMILIES) {
        if (!families.has(family)) continue
        emit(` address-family ${family.replace('-', ' ')}`)
        close(' ')
      }
      renderGroups(groups, ' ', local)
    }
    for (const instance of vrfs) {
      const ni = model.networkInstances![instance]
      const at = ['networkInstances', instance]
      if (ni.type !== 'vrf') {
        if (ni.bgp) skipAll(ni.bgp, [...at, 'bgp'], 'BGP in an instance IOS-XR doesn\'t write as a VRF')
        if (ni.routeDistinguisher !== undefined) skip([...at, 'routeDistinguisher'], 'unsupported', 'a route distinguisher for an instance IOS-XR doesn\'t write as a VRF')
        continue
      }
      emit(` vrf ${instance}`, ...(ni.bgp ? bgpFields(instance, ni.bgp, local) : []))
      if (ni.routeDistinguisher !== undefined) {
        if (isRouteDistinguisher(ni.routeDistinguisher)) emit(`  rd ${ni.routeDistinguisher}`, [...at, 'routeDistinguisher'])
        else skip([...at, 'routeDistinguisher'], 'unsupported', 'not a route distinguisher in the form ASN:nn, IP:nn or ASN4:nn')
      }
      if (ni.bgp) renderBgpInstance(instance, ni.bgp, '  ', local, groups)
      close(' ')
    }
    close()
  }

  /**
   * The neighbor groups written for the whole router bgp (#71): IOS-XR's belong to it, where the model's are per
   * network instance. The global table's are written; a VRF's group (a copy, as the parse makes one for a VRF neighbor
   * that uses a global group) is written with the global one of its name when it is the same, or, with no global one,
   * once for every VRF whose group of that name is the same, and only when a neighbor of the VRF uses it. Any other
   * VRF group is left out, with why (`unwritten`, by its path).
   */
  function planGroups(list: readonly [string, Bgp][]): { readonly shared: ReadonlyMap<string, SharedGroup>; readonly unwritten: ReadonlyMap<string, string> } {
    const shared = new Map<string, SharedGroup>()
    const unwritten = new Map<string, string>()
    const path = (instance: string, name: string) => ['networkInstances', instance, 'bgp', 'groups', name]
    for (const [name, group] of Object.entries(list.find(([i]) => i === 'default')?.[1].groups ?? {})) if (GROUP_NAME.test(name)) shared.set(name, { group, at: path('default', name), copies: [] })
    const inVrfs = new Map<string, [Segments, BgpGroup][]>()
    for (const [instance, b] of list) {
      if (instance === 'default' || model.networkInstances![instance].type !== 'vrf') continue
      for (const [name, group] of Object.entries(b.groups ?? {})) {
        const at = path(instance, name)
        if (!GROUP_NAME.test(name)) unwritten.set(fieldPath(...at), 'not a neighbor group name IOS-XR takes')
        else if (!Object.values(b.neighbors ?? {}).some((n) => n.group === name)) unwritten.set(fieldPath(...at), 'a group in a VRF that no neighbor of the VRF uses: IOS-XR\'s neighbor groups belong to the whole router bgp')
        else inVrfs.set(name, [...(inVrfs.get(name) ?? []), [at, group]])
      }
    }
    for (const [name, copies] of inVrfs) {
      const own = shared.get(name)
      if (own) {
        for (const [at, group] of copies) {
          if (canonical(group) === canonical(own.group)) own.copies.push(at)
          else unwritten.set(fieldPath(...at), 'a group in a VRF that differs from the global table\'s of its name: IOS-XR\'s neighbor groups belong to the whole router bgp')
        }
      } else if (copies.every(([, group]) => canonical(group) === canonical(copies[0][1]))) shared.set(name, { group: copies[0][1], at: copies[0][0], copies: copies.slice(1).map(([at]) => at) })
      else for (const [at] of copies) unwritten.set(fieldPath(...at), 'a group in a VRF that differs from another VRF\'s of its name: IOS-XR\'s neighbor groups belong to the whole router bgp')
    }
    return { shared, unwritten }
  }

  /** Each neighbor group of the plan, written once; its VRFs' copies are what it is (rendered on its lines, or not). */
  function renderGroups(groups: ReturnType<typeof planGroups>, indent: string, local: number) {
    for (const [name, { group, at, copies }] of groups.shared) {
      const asked = needsInput.length
      renderPeer(`neighbor-group ${name}`, group, at, indent, local)
      const prefix = fieldPath(...at)
      // A question about the neighbor group (its password) is one question, answered once, whose answer is every copy's: an
      // item for each copy, with the same id and the copy's field.
      const questions = needsInput.slice(asked).filter((item) => item.field !== undefined && (item.field === prefix || item.field.startsWith(`${prefix}.`)))
      for (const copy of copies) for (const item of questions) needsInput.push({ ...item, field: fieldPath(...copy) + item.field!.slice(prefix.length) })
      const under = Object.entries(dispositions).filter(([path]) => path === prefix || path.startsWith(`${prefix}.`) || path.startsWith(`${prefix}[`))
      for (const copy of copies) for (const [path, d] of under) dispositions[fieldPath(...copy) + path.slice(prefix.length)] = d
    }
  }

  /** The fields a `router bgp` or `vrf` line says: the local AS (the model's one AS), or BGP with nothing in it. */
  function bgpFields(instance: string, b: Bgp, local: number): Segments[] {
    const at = ['networkInstances', instance, 'bgp']
    if (b.localAs !== undefined && b.localAs !== local) skip([...at, 'localAs'], 'unsupported', 'a VRF\'s own local AS: IOS-XR\'s VRFs run under the one router bgp')
    return [...(b.localAs === local ? [[...at, 'localAs']] : []), ...(isEmpty(b) ? [at] : [])]
  }

  function renderBgpInstance(instance: string, b: Bgp, indent: string, local: number, groups: ReturnType<typeof planGroups>) {
    const at = ['networkInstances', instance, 'bgp']
    // The source platform's default for an eBGP peer with no policy: IOS-XR has its own (RFC 8212), warned on per neighbor.
    for (const side of ['import', 'export'] as const) if (b.ebgpDefaultPolicy?.[side] !== undefined) skip([...at, 'ebgpDefaultPolicy', side], 'not-applicable', 'the source platform\'s default, not configuration: IOS-XR\'s own is to exchange nothing (RFC 8212)')
    if (b.routerId !== undefined) {
      if (isIpv4(b.routerId)) emit(`${indent}bgp router-id ${b.routerId}`, [...at, 'routerId'])
      else skip([...at, 'routerId'], 'unsupported', 'not an IPv4 address')
    }
    // IOS-XR carries a family to a neighbor only when BGP has it too: each family a peer carries, and in the global
    // table each a neighbor group written there carries, a VRF's among them.
    const peers = [...Object.values(b.neighbors ?? {}), ...(instance === 'default' ? [...groups.shared.values()].map((s) => s.group) : Object.values(b.groups ?? {}))]
    const families = new Set(peers.flatMap((p) => Object.keys(p.addressFamilies ?? {})))
    for (const family of FAMILIES) {
      if (!families.has(family)) continue
      emit(`${indent}address-family ${family.replace('-', ' ')}`)
      close(indent)
    }
    emptyContainer(b.groups, [...at, 'groups'])
    emptyContainer(b.neighbors, [...at, 'neighbors'])
    /** A group of this instance that is written: a neighbor uses it there. */
    const written = (name: string) => b.groups !== undefined && Object.hasOwn(b.groups, name) && !groups.unwritten.has(fieldPath(...at, 'groups', name)) && GROUP_NAME.test(name)
    if (instance === 'default') {
      for (const [name, group] of Object.entries(b.groups ?? {})) if (!GROUP_NAME.test(name)) skipAll(group, [...at, 'groups', name], 'not a neighbor group name IOS-XR takes')
      renderGroups(groups, indent, local)
    } else for (const [name, group] of Object.entries(b.groups ?? {})) if (!written(name)) skipAll(group, [...at, 'groups', name], groups.unwritten.get(fieldPath(...at, 'groups', name))!)
    for (const [address, neighbor] of Object.entries(b.neighbors ?? {})) {
      const nAt = [...at, 'neighbors', address]
      if (!isIpv4(address) && !isIpv6(address)) {
        skipAll(neighbor, nAt, 'not a neighbor address')
        continue
      }
      const group = neighbor.group !== undefined && written(neighbor.group) ? b.groups![neighbor.group] : undefined
      renderPeer(`neighbor ${address}`, neighbor, nAt, indent, local, group)
    }
  }

  /** A neighbor or a neighbor group, with its families and their route policies. `group` is a neighbor's, when written. */
  function renderPeer(header: string, peer: BgpGroup & BgpNeighbor, at: Segments, indent: string, local: number, group?: BgpGroup) {
    const inner = `${indent} `
    const neighbor = header.startsWith('neighbor ')
    emit(`${indent}${header}`, ...(isEmpty(peer) ? [at] : []))
    if (peer.peerAs !== undefined) {
      if (isAsNumber(peer.peerAs)) emit(`${inner}remote-as ${peer.peerAs}`, [...at, 'peerAs'])
      else skip([...at, 'peerAs'], 'unsupported', 'not an AS number from 1 to 4294967295')
    }
    if (peer.type !== undefined) {
      // An internal group's peers are in the local AS: said with remote-as when nothing else says it.
      if (peer.type === 'internal' && peer.peerAs === undefined) emit(`${inner}remote-as ${local}`, [...at, 'type'])
      else skip([...at, 'type'], 'not-applicable', 'IOS-XR tells iBGP from eBGP by the remote AS')
    }
    if (peer.group !== undefined) {
      if (group) emit(`${inner}use neighbor-group ${peer.group}`, [...at, 'group'])
      else skip([...at, 'group'], 'unsupported', 'a group IOS-XR can\'t write as a neighbor group of the whole router bgp')
    }
    if (peer.description !== undefined) emit(`${inner}description ${peer.description}`, [...at, 'description'])
    if (peer.localAddress !== undefined) skip([...at, 'localAddress'], 'unsupported', 'IOS-XR sources a session from an interface (update-source), not an address')
    if (peer.updateSource !== undefined) emit(`${inner}update-source ${peer.updateSource}`, [...at, 'updateSource'])
    if (peer.multihop !== undefined) {
      const ttl = peer.multihop.ttl
      if (ttl === undefined) emit(`${inner}ebgp-multihop`, [...at, 'multihop'])
      else if (inRange(ttl, { min: 1, max: 255 })) emit(`${inner}ebgp-multihop ${ttl}`, [...at, 'multihop', 'ttl'])
      else skip([...at, 'multihop', 'ttl'], 'unsupported', 'not a TTL from 1 to 255')
    }
    if (peer.authentication === false) skip([...at, 'authentication'], 'not-applicable', 'no password: nothing to write')
    else if (peer.authentication) {
      // The password is never carried: a needs-input item asks for it, and the answer is written.
      const id = `iosxr.bgp-password:${fieldPath(...at)}`
      const password = answer(id, /^\S{1,80}$/)
      if (password !== undefined) emit(`${inner}password clear ${password}`, [...at, 'authentication'])
      else {
        skip([...at, 'authentication'], 'unsupported', 'needs the password, which isn\'t carried')
        needsInput.push({ id, kind: 'secret', message: 'A BGP session with a password needs the password, which isn\'t carried.', field: fieldPath(...at, 'authentication') })
      }
    }
    renderPeerFamilies(peer, at, inner, neighbor ? local : undefined, group)
    close(indent)
  }

  /**
   * A peer's address families, each with its route policies: IOS-XR applies them per family, one each way. A policy
   * given for the whole peer goes into each family it carries (its group's too), unless the family has its own. For an
   * eBGP neighbor (`local` given), IOS-XR exchanges no routes in a direction with no policy (RFC 8212): a needs-input
   * item asks for a policy's name, which is written where one is missing. None is made up.
   */
  function renderPeerFamilies(peer: BgpGroup & BgpNeighbor, at: Segments, indent: string, local?: number, group?: BgpGroup) {
    const own = peer.addressFamilies ?? {}
    emptyContainer(own, [...at, 'addressFamilies'])
    for (const family of Object.keys(own)) if (!(FAMILIES as readonly string[]).includes(family)) skipAll(own[family as BgpAddressFamilyName], [...at, 'addressFamilies', family], 'an address family this phase doesn\'t write')
    const inherited = (f: BgpAddressFamilyName) => group?.addressFamilies?.[f]
    const peerAs = peer.peerAs ?? group?.peerAs ?? (group?.type === 'internal' ? local : undefined)
    const ebgp = local !== undefined && peerAs !== undefined && peerAs !== local
    // A direction is missing when a family the neighbor carries has no route policy written that way: its own (the
    // family's, else the peer's), else its group's, which IOS-XR inherits where the neighbor writes none. A policy the
    // model names but IOS-XR can't write (its body can't be, or a chain) covers nothing: routes would stop there.
    const carried = FAMILIES.filter((f) => own[f] !== undefined || inherited(f) !== undefined)
    const written = (list: readonly string[] | undefined) => list !== undefined && list.length === 1 && RPL_NAME.test(list[0]) && policyName(list[0]) !== 'not-written'
    const covered = (f: BgpAddressFamilyName, field: 'importPolicies' | 'exportPolicies') => written(own[f]?.[field] ?? peer[field]) || written(inherited(f)?.[field] ?? group?.[field])
    const missing = ebgp ? (['importPolicies', 'exportPolicies'] as const).filter((field) => !carried.length || carried.some((f) => !covered(f, field))) : []
    const id = `iosxr.ebgp-policy:${fieldPath(...at)}`
    const given = missing.length ? answer(id, /^[\w.-]{1,64}$/) : undefined
    // The source exchanged these routes without a policy; IOS-XR won't.
    const source = model.networkInstances?.[String(at[1])]?.bgp?.ebgpDefaultPolicy
    if (missing.some((field) => source?.[field === 'importPolicies' ? 'import' : 'export'] === 'accept')) {
      diagnostics.push({ severity: 'warning', category: 'semantic', code: 'iosxr.ebgp-default-policy', message: 'The source accepts an eBGP neighbor\'s routes with no policy, where IOS-XR, following RFC 8212, exchanges none without one: the neighbor needs a route policy.', field: fieldPath(...at) })
    }
    if (missing.length && given === undefined) needsInput.push({ id, kind: 'other', message: 'An eBGP neighbor has no route policy one way or both: IOS-XR, following RFC 8212, exchanges no routes that way without one. Name an existing route policy to attach.', field: fieldPath(...at) })
    const families = FAMILIES.filter((f) => own[f] !== undefined || ((peer.importPolicies || peer.exportPolicies || (given !== undefined && carried.includes(f))) && inherited(f) !== undefined))
    const peerLevel: Record<'importPolicies' | 'exportPolicies', boolean> = { importPolicies: false, exportPolicies: false }
    let named = 0
    for (const family of families) {
      const af = own[family]
      const afAt = [...at, 'addressFamilies', family]
      emit(`${indent}address-family ${family.replace('-', ' ')}`, ...(af !== undefined && isEmpty(af) ? [afAt] : []))
      for (const [field, direction] of [['importPolicies', 'in'], ['exportPolicies', 'out']] as const) {
        const list = af?.[field] ?? peer[field]
        const where = af?.[field] !== undefined ? [...afAt, field] : [...at, field]
        // The answer for RFC 8212, where the family has no policy written that way of its own or its group's.
        if (given !== undefined && missing.includes(field) && !covered(family, field)) emit(`${indent} route-policy ${given} ${direction}`)
        if (list === undefined || !list.length) {
          if (list !== undefined) skip(where, 'not-applicable', 'no policy: nothing to write')
          continue
        }
        if (list.length > 1) skip(where, 'unsupported', 'IOS-XR applies one route policy each way here: a chain of policies isn\'t written')
        else if (!RPL_NAME.test(list[0])) skip(where, 'unsupported', 'not a route policy name IOS-XR takes')
        else if (policyName(list[0]) === 'not-written') skip(where, 'unsupported', 'names a policy IOS-XR can\'t write')
        else {
          emit(`${indent} route-policy ${list[0]} ${direction}`, ...(af?.[field] !== undefined || !peerLevel[field] ? [where] : []))
          if (af?.[field] === undefined) peerLevel[field] = true
          if (policyName(list[0]) === 'name-only') named++
        }
      }
      close(indent)
    }
    for (const field of ['importPolicies', 'exportPolicies'] as const) {
      if (peer[field] === undefined || peerLevel[field] || Object.hasOwn(dispositions, fieldPath(...at, field))) continue
      skip([...at, field], 'unsupported', families.length ? 'every family the peer carries has its own policy' : 'IOS-XR applies a route policy per address family, and the peer carries none')
    }
    if (named) diagnostics.push({ severity: 'warning', category: 'semantic', code: 'iosxr.route-policy-name-only', message: 'A policy is written as a route policy by its name only: its body isn\'t in the model, so IOS-XR needs a route policy of that name.', field: fieldPath(...at) })
    if (local !== undefined && !carried.length) diagnostics.push({ severity: 'warning', category: 'semantic', code: 'iosxr.bgp-no-address-family', message: 'A BGP neighbor has no address family: on IOS-XR it carries no routes until one is configured.', field: fieldPath(...at) })
  }

  // ---- routing policy: sets and route policies, before the protocols that apply them
  for (const l of policyPlan.lines) {
    emit(l.text, ...l.fields)
    if (l.warning) diagnostics.push({ ...l.warning, span: { startLine: lines.length, startColumn: 1, endLine: lines.length, endColumn: l.text.length + 1 } })
  }

  renderOspf()
  renderBgp()

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
          if (inRange(server.port, PORT)) {
            line += ` port ${server.port}`
            fields.push([...s, 'port'])
          } else skip([...s, 'port'], 'unsupported', `IOS-XR takes a port from ${PORT.min} to ${PORT.max}`)
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

  return { text: lines.length ? `${lines.join('\n')}\n` : '', dispositions, diagnostics, ...(needsInput.length ? { needsInput } : {}) }
}
