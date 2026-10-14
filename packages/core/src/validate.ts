// What a model must hold beyond its types: values in the forms model.ts documents, and references that resolve. The
// conformance kit runs modelProblems() on every model a plugin parses (its parse and round-trip checks), so a plugin
// that names a VRF, VLAN, interface or BGP group it never declared, or writes a route distinguisher, VLAN ID or AS number
// in a form no other plugin can read, fails there instead of in a conversion. Messages never quote the config (AGENTS.md, No secrets in diagnostics): a VRF can share
// its name with a secret, so they say what is wrong, and `field` says where.
import type { BgpPeer, CommunityType, Device, Filters, Interface, Keyed, PrefixMatch, RoutingPolicy } from './model'
import { fieldPath, type PathSegment } from './paths'
import type { Diagnostic } from './results'

const UINT16 = 0xffff
const UINT32 = 0xffffffff

/** A decimal number with no sign, no leading zero and no more than `max`, or null. */
function number(text: string, max: number): number | null {
  if (!/^(0|[1-9]\d{0,9})$/.test(text)) return null
  const n = Number(text)
  return n <= max ? n : null
}

const isIpv4 = (text: string) => {
  const parts = text.split('.')
  return parts.length === 4 && parts.every((p) => number(p, 255) !== null)
}

/** An IPv4 address's 32 bits, as a string of `0` and `1`, or null. */
function ipv4Bits(text: string): string | null {
  return isIpv4(text) ? text.split('.').map((p) => Number(p).toString(2).padStart(8, '0')).join('') : null
}

/** An IPv6 address's 128 bits (with `::` and a final dotted IPv4 part), as a string of `0` and `1`, or null. */
function ipv6Bits(text: string): string | null {
  const halves = text.split('::')
  if (halves.length > 2) return null
  const groups = (part: string) => (part === '' ? [] : part.split(':'))
  const head = groups(halves[0])
  const tail = halves.length === 2 ? groups(halves[1]) : []
  const last = halves.length === 2 ? tail : head
  // A dotted IPv4 address may end it, as two groups.
  if (last.length && last[last.length - 1].includes('.')) {
    const v4 = ipv4Bits(last.pop()!)
    if (v4 === null) return null
    last.push(parseInt(v4.slice(0, 16), 2).toString(16), parseInt(v4.slice(16), 2).toString(16))
  }
  if (![...head, ...tail].every((g) => /^[0-9A-Fa-f]{1,4}$/.test(g))) return null
  const missing = 8 - head.length - tail.length
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null
  return [...head, ...Array<string>(missing).fill('0'), ...tail].map((g) => parseInt(g, 16).toString(2).padStart(16, '0')).join('')
}

/** Whether `value` is an IPv4 or IPv6 address. */
export function isIpAddress(value: unknown): boolean {
  return typeof value === 'string' && (isIpv4(value) || ipv6Bits(value) !== null)
}

/** A prefix in CIDR form with no host bits set (`10.0.0.0/8`, `2001:db8::/32`): its family and length, or null. */
export function parsePrefix(value: unknown): { family: 'ipv4' | 'ipv6'; length: number } | null {
  if (typeof value !== 'string') return null
  const slash = value.lastIndexOf('/')
  if (slash < 0) return null
  const address = value.slice(0, slash)
  const family = address.includes(':') ? 'ipv6' : 'ipv4'
  const bits = family === 'ipv4' ? ipv4Bits(address) : ipv6Bits(address)
  const length = number(value.slice(slash + 1), family === 'ipv4' ? 32 : 128)
  if (bits === null || length === null || bits.slice(length).includes('1')) return null
  return { family, length }
}

/** The well-known communities, by the model's names for them. */
const WELL_KNOWN_COMMUNITIES: ReadonlySet<string> = new Set(['no-export', 'no-advertise', 'no-export-subconfed', 'graceful-shutdown', 'blackhole', 'accept-own', 'no-peer', 'llgr-stale', 'no-llgr'])

/**
 * Which kind of community `value` is in the model's forms (model.ts, CommunitySet): `standard` (`65000:100`, a
 * well-known name), `extended` (`target:65000:100`, `origin:192.0.2.1:100`) or `large` (`large:65000:1:2`); null when
 * it is none of them.
 */
export function communityType(value: unknown): CommunityType | null {
  if (typeof value !== 'string') return null
  if (WELL_KNOWN_COMMUNITIES.has(value)) return 'standard'
  const parts = value.split(':')
  if (parts.length === 2 && parts.every((p) => number(p, UINT16) !== null)) return 'standard'
  if ((parts[0] === 'target' || parts[0] === 'origin') && isRouteDistinguisher(value.slice(parts[0].length + 1))) return 'extended'
  if (parts.length === 4 && parts[0] === 'large' && parts.slice(1).every((p) => number(p, UINT32) !== null)) return 'large'
  return null
}

/** Whether `key` is a position in an ordered collection: a decimal number with no sign or leading zero, up to 4294967294. */
export function isPositionKey(key: string): boolean {
  return number(key, UINT32 - 1) !== null
}

const isDialect = (value: unknown) => value === 'junos' || value === 'cisco'

const isUint32 = (value: unknown) => Number.isInteger(value) && (value as number) >= 0 && (value as number) <= UINT32

/** Whether a prefix match's lengths fit its prefix and agree with its form (model.ts, PrefixMatch). */
function lengthsAgree(match: PrefixMatch, length: number, bits: number): { range: boolean; form: boolean } {
  const { minLength: min, maxLength: max, form } = match
  const range = Number.isInteger(min) && Number.isInteger(max) && length <= min && min <= max && max <= bits
  if (!range || form === undefined) return { range, form: true }
  const agrees: Record<string, boolean> = {
    exact: min === length && max === length,
    orlonger: min === length && max === bits,
    longer: min === length + 1 && max === bits,
    upto: min === length,
    'prefix-length-range': true,
    ge: min > length && max === bits,
    le: min === length,
    'ge-le': min > length
  }
  return { range, form: Object.hasOwn(agrees, form) && agrees[form] }
}

/** Whether `value` is a VLAN ID: an integer from 1 to 4094. */
export function isVlanId(value: unknown): boolean {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 4094
}

/** Whether `value` is an AS number in plain form: an integer from 1 to 4294967295. */
export function isAsNumber(value: unknown): boolean {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= UINT32
}

/** A VLAN ID written as the model keys VLANs (`"10"`), or null. */
const vlanKey = (text: string): number | null => {
  const n = number(text, 4094)
  return n !== null && n >= 1 ? n : null
}

/** An entry of a trunk's allowed VLANs (`"10"`, `"20-30"`) as its first and last VLAN, or null when it isn't one. */
function vlanRange(value: unknown): [number, number] | null {
  if (typeof value !== 'string') return null
  const m = /^(\d+)(?:-(\d+))?$/.exec(value)
  const first = m ? vlanKey(m[1]) : null
  const last = m?.[2] !== undefined ? vlanKey(m[2]) : first
  if (first === null || last === null || (m?.[2] !== undefined && first >= last)) return null
  return [first, last]
}

/**
 * Whether an interface reference (`name` or `name.<subinterface>`, model.ts) names an interface of the model: a key, or
 * a key and one of its subinterfaces. Own keys only.
 */
function resolves(ref: unknown, interfaces: Keyed<Interface> | undefined): boolean {
  if (typeof ref !== 'string' || !interfaces) return false
  if (Object.hasOwn(interfaces, ref)) return true
  const m = /^(.+)\.(\d+)$/.exec(ref)
  if (!m || !Object.hasOwn(interfaces, m[1])) return false
  const subs = interfaces[m[1]]?.subinterfaces
  return typeof subs === 'object' && subs !== null && Object.hasOwn(subs, m[2])
}

/**
 * Whether `value` is a route distinguisher or route target in one of the model's three forms: `ASN:nn` (an AS up to
 * 65535 and a number up to 4294967295), `IP:nn` (an IPv4 address and a number up to 65535) or `ASN4:nn` (an AS from
 * 65536 to 4294967295, in plain form, and a number up to 65535).
 */
export function isRouteDistinguisher(value: unknown): boolean {
  if (typeof value !== 'string') return false
  const colon = value.lastIndexOf(':')
  if (colon <= 0) return false
  const admin = value.slice(0, colon)
  const assigned = value.slice(colon + 1)
  if (isIpv4(admin)) return number(assigned, UINT16) !== null
  const asn = number(admin, UINT32)
  if (asn === null) return false
  return number(assigned, asn > UINT16 ? UINT16 : UINT32) !== null
}

const entries = <T>(map: Readonly<Record<string, T>> | undefined): [string, T][] => (map ? Object.entries(map) : [])

/**
 * What is wrong with `device` beyond its types, as error diagnostics (code `model.…`, `field` the path), in model
 * order; empty when nothing is:
 * - a subinterface's `networkInstance` names no network instance of the model (`model.unknown-network-instance`), or
 *   names `default`, which is said by leaving it out (`model.default-network-instance`);
 * - a route distinguisher or route target isn't in one of the model's forms (`model.route-distinguisher`,
 *   `model.route-target`);
 * - since 0.4.0: a VLAN key, access, native or routed VLAN isn't a VLAN ID (`model.vlan-id`), a trunk's allowed VLAN
 *   isn't an ID or a range (`model.vlan-range`), and an access, native, routed or single allowed VLAN names no VLAN of
 *   the model (`model.unknown-vlan`); an `irb-or-svi` interface routes for no VLAN (`model.irb-without-vlan`), or a
 *   subinterface of another type routes for one (`model.routed-vlan-interface`);
 * - since 0.4.0: an OSPF or BGP router ID isn't an IPv4 address (`model.router-id`), an OSPF area isn't in dotted form
 *   (`model.ospf-area`), an OSPF interface or a BGP update source names no interface of the model
 *   (`model.unknown-interface`), a local or peer AS isn't one (`model.as-number`), and a BGP neighbor's group isn't
 *   one of its instance's (`model.unknown-bgp-group`);
 * - since 0.5.0, routing policy (routingPolicyProblems()): positions, prefixes and their lengths, communities, regex
 *   dialects and numbers in the model's forms, and every prefix list, community set and AS-path set a term names, and
 *   with `policyReferences` (the default), every policy a BGP peer or family names, exists;
 * - since 0.5.1, filters (filterProblems()): their terms in the model's forms, and every filter a subinterface applies
 *   exists in its family (`model.unknown-filter`).
 */
export function modelProblems(device: Device, { policyReferences = true }: ModelProblemsOptions = {}): Diagnostic[] {
  const out: Diagnostic[] = []
  const problem = (code: string, message: string, field: string) => out.push({ severity: 'error', category: 'semantic', code: `model.${code}`, message, field })
  const instances = device.networkInstances
  const vlans = device.vlans
  /** A VLAN a field names: a VLAN ID (`model.vlan-id`) the model has (`model.unknown-vlan`). */
  const vlan = (id: unknown, field: string, what: string) => {
    if (!isVlanId(id)) problem('vlan-id', `${what} isn't a VLAN ID from 1 to 4094.`, field)
    else if (!vlans || !Object.hasOwn(vlans, String(id))) problem('unknown-vlan', `${what} names a VLAN the model doesn't have.`, field)
  }
  for (const [name, ifc] of entries(device.interfaces)) {
    let routes = false
    for (const [index, sub] of entries(ifc?.subinterfaces)) {
      const vrf = sub?.networkInstance
      const at = (leaf: string) => fieldPath('interfaces', name, 'subinterfaces', index, leaf)
      if (vrf === 'default') problem('default-network-instance', 'A subinterface in the default network instance leaves networkInstance out.', at('networkInstance'))
      else if (vrf !== undefined && (typeof vrf !== 'string' || !instances || !Object.hasOwn(instances, vrf))) problem('unknown-network-instance', 'A subinterface names a network instance the model doesn\'t have.', at('networkInstance'))
      // Since 0.5.1: each filter applied is one of the model's, of the same family.
      for (const family of ['ipv4', 'ipv6'] as const)
        for (const direction of ['input', 'output'] as const) {
          const filter = sub?.filters?.[family]?.[direction]
          const declared = device.filters?.[family]
          if (filter !== undefined && (typeof filter !== 'string' || !declared || !Object.hasOwn(declared, filter)))
            problem('unknown-filter', 'A subinterface applies a filter the model doesn\'t have in that family.', fieldPath('interfaces', name, 'subinterfaces', index, 'filters', family, direction))
        }
      if (sub?.routedVlan === undefined) continue
      routes = true
      if (ifc.type !== 'irb-or-svi') problem('routed-vlan-interface', 'A subinterface routes for a VLAN, but its interface isn\'t of type irb-or-svi.', at('routedVlan'))
      vlan(sub.routedVlan, at('routedVlan'), 'A routed VLAN')
    }
    if (ifc?.type === 'irb-or-svi' && !routes) problem('irb-without-vlan', 'An irb-or-svi interface routes for no VLAN: none of its subinterfaces has a routedVlan.', fieldPath('interfaces', name, 'type'))
    const switching = ifc?.switching
    if (!switching) continue
    const at = (leaf: string) => fieldPath('interfaces', name, 'switching', leaf)
    if (switching.accessVlan !== undefined) vlan(switching.accessVlan, at('accessVlan'), 'An access VLAN')
    if (switching.nativeVlan !== undefined) vlan(switching.nativeVlan, at('nativeVlan'), 'A native VLAN')
    if (switching.allowedVlans !== undefined) {
      const ranges = (Array.isArray(switching.allowedVlans) ? switching.allowedVlans : [switching.allowedVlans]).map(vlanRange)
      // A leaf-list is one leaf (paths.ts): each problem is reported on the list, once.
      if (ranges.some((r) => r === null)) problem('vlan-range', 'A trunk\'s allowed VLAN isn\'t a VLAN ID or a range of them (first-last) from 1 to 4094.', at('allowedVlans'))
      else if (ranges.some((r) => r![0] === r![1] && (!vlans || !Object.hasOwn(vlans, String(r![0]))))) problem('unknown-vlan', 'A trunk\'s allowed VLAN names a VLAN the model doesn\'t have.', at('allowedVlans'))
    }
  }
  for (const [key] of entries(vlans)) if (vlanKey(key) === null) problem('vlan-id', 'A VLAN is keyed by something other than its VLAN ID from 1 to 4094.', fieldPath('vlans', key))
  for (const [name, instance] of entries(instances)) {
    if (instance?.routeDistinguisher !== undefined && !isRouteDistinguisher(instance.routeDistinguisher))
      problem('route-distinguisher', 'A route distinguisher isn\'t in the form ASN:nn, IP:nn or ASN4:nn.', fieldPath('networkInstances', name, 'routeDistinguisher'))
    // Each list in the source's order (import, export): own entries only, as everywhere in the core.
    for (const [direction, targets] of entries<unknown>(instance?.routeTargets as Readonly<Record<string, unknown>> | undefined)) {
      if (targets === undefined) continue
      // A leaf-list is one leaf (paths.ts): the problem is reported on the list, once.
      if (!(Array.isArray(targets) ? targets : [targets]).every(isRouteDistinguisher))
        problem('route-target', 'A route target isn\'t in the form ASN:nn, IP:nn or ASN4:nn.', fieldPath('networkInstances', name, 'routeTargets', direction))
    }
    const routerId = (value: unknown, ...path: string[]) => {
      if (value !== undefined && (typeof value !== 'string' || !isIpv4(value))) problem('router-id', 'A router ID isn\'t an IPv4 address.', fieldPath('networkInstances', name, ...path))
    }
    const ospf = instance?.ospf
    routerId(ospf?.routerId, 'ospf', 'routerId')
    for (const [area, a] of entries(ospf?.areas)) {
      if (!isIpv4(area)) problem('ospf-area', 'An OSPF area isn\'t in dotted form (0.0.0.0).', fieldPath('networkInstances', name, 'ospf', 'areas', area))
      for (const [ref] of entries(a?.interfaces))
        if (!resolves(ref, device.interfaces)) problem('unknown-interface', 'An OSPF interface names an interface the model doesn\'t have.', fieldPath('networkInstances', name, 'ospf', 'areas', area, 'interfaces', ref))
    }
    const bgp = instance?.bgp
    routerId(bgp?.routerId, 'bgp', 'routerId')
    if (bgp?.localAs !== undefined && !isAsNumber(bgp.localAs)) problem('as-number', 'A local AS isn\'t an AS number from 1 to 4294967295.', fieldPath('networkInstances', name, 'bgp', 'localAs'))
    const peer = (p: BgpPeer | undefined, ...path: string[]) => {
      if (p?.peerAs !== undefined && !isAsNumber(p.peerAs)) problem('as-number', 'A peer AS isn\'t an AS number from 1 to 4294967295.', fieldPath('networkInstances', name, 'bgp', ...path, 'peerAs'))
      if (p?.updateSource !== undefined && !resolves(p.updateSource, device.interfaces)) problem('unknown-interface', 'A BGP update source names an interface the model doesn\'t have.', fieldPath('networkInstances', name, 'bgp', ...path, 'updateSource'))
    }
    for (const [group, g] of entries(bgp?.groups)) peer(g, 'groups', group)
    for (const [address, n] of entries(bgp?.neighbors)) {
      peer(n, 'neighbors', address)
      const group = n?.group
      if (group !== undefined && (typeof group !== 'string' || !bgp?.groups || !Object.hasOwn(bgp.groups, group)))
        problem('unknown-bgp-group', 'A BGP neighbor is in a group its instance doesn\'t have.', fieldPath('networkInstances', name, 'bgp', 'neighbors', address, 'group'))
    }
    if (!policyReferences) continue
    // Since 0.5.0: each policy a peer or one of its families names is one of the model's.
    const policies = device.routingPolicy?.policies
    const named = (list: unknown, path: readonly PathSegment[]) => {
      if (list !== undefined && !(Array.isArray(list) ? list : [list]).every((p) => typeof p === 'string' && policies !== undefined && Object.hasOwn(policies, p)))
        problem('unknown-policy', 'A BGP peer names a policy the model doesn\'t have.', fieldPath('networkInstances', name, 'bgp', ...path))
    }
    const peerPolicies = (p: BgpPeer | undefined, ...path: string[]) => {
      named(p?.importPolicies, [...path, 'importPolicies'])
      named(p?.exportPolicies, [...path, 'exportPolicies'])
      for (const [family, f] of entries<{ importPolicies?: unknown; exportPolicies?: unknown } | undefined>(p?.addressFamilies as Readonly<Record<string, never>> | undefined)) {
        named(f?.importPolicies, [...path, 'addressFamilies', family, 'importPolicies'])
        named(f?.exportPolicies, [...path, 'addressFamilies', family, 'exportPolicies'])
      }
    }
    for (const [group, g] of entries(bgp?.groups)) peerPolicies(g, 'groups', group)
    for (const [address, n] of entries(bgp?.neighbors)) peerPolicies(n, 'neighbors', address)
  }
  out.push(...routingPolicyProblems(device.routingPolicy))
  out.push(...filterProblems(device.filters, device.routingPolicy))
  return out
}

/** A port range (model.ts, PortRange): `"22"` or `"1024-65535"`, first below last, from 0 to 65535. */
export function isPortRange(value: unknown): boolean {
  if (typeof value !== 'string') return false
  const m = /^([^-]+)(?:-([^-]+))?$/.exec(value)
  const first = m ? number(m[1], UINT16) : null
  const last = m?.[2] !== undefined ? number(m[2], UINT16) : first
  return first !== null && last !== null && (m?.[2] === undefined || first < last)
}

const TCP_FLAGS: ReadonlySet<unknown> = new Set(['fin', 'syn', 'rst', 'psh', 'ack', 'urg', 'ece', 'cwr'])

/**
 * What is wrong with a model's filters (since 0.5.1), as modelProblems() reports it:
 * - a filter's `implicitAction` is missing or isn't `discard` or `deny` (`model.implicit-action`); a term's key isn't a
 *   position (`model.position`), and its action is missing or isn't one of the model's (`model.filter-action`);
 * - a prefix isn't in CIDR form with no host bits set, of the filter's family (`model.prefix`); a prefix list isn't one
 *   of the model's in that family (`model.unknown-prefix-list`);
 * - a protocol isn't from 0 to 255, an ICMP type or code from 0 to 255, a DSCP value from 0 to 63 (`model.number`); a
 *   port isn't a port or a range of them (`model.port-range`); a TCP flag isn't one of the model's
 *   (`model.tcp-flags`); a fragment match isn't `initial` or `non-initial` (`model.fragment`).
 * A leaf-list's problem is reported on the list, once.
 */
export function filterProblems(filters: Filters | undefined, policy?: RoutingPolicy): Diagnostic[] {
  const out: Diagnostic[] = []
  if (!filters) return out
  const problem = (code: string, message: string, ...path: PathSegment[]) => out.push({ severity: 'error', category: 'semantic', code: `model.${code}`, message, field: fieldPath('filters', ...path) })
  const list = (value: unknown): unknown[] => (value === undefined ? [] : Array.isArray(value) ? value : [value])
  const inRange = (max: number) => (v: unknown) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= max
  for (const family of ['ipv4', 'ipv6'] as const)
    for (const [name, filter] of entries(filters[family])) {
      const at = [family, name]
      if (filter?.implicitAction !== 'discard' && filter?.implicitAction !== 'deny') problem('implicit-action', 'A filter doesn\'t say what happens to a packet no term decides (discard or deny).', ...at, 'implicitAction')
      for (const [key] of entries(filter?.terms)) if (!isPositionKey(key)) problem('position', 'A filter term is keyed by something other than its position, a number from 0 to 4294967294.', ...at, 'terms', key)
      for (const [key, term] of entries(filter?.terms)) {
        const t = [...at, 'terms', key]
        if (!['accept', 'discard', 'reject', 'next-term'].includes(term?.actions?.action as string)) problem('filter-action', 'A filter term\'s action is missing, or isn\'t accept, discard, reject or next-term.', ...t, 'actions', 'action')
        const m = term?.matches
        for (const leaf of ['sourcePrefixes', 'destinationPrefixes', 'prefixes'] as const)
          if (!list(m?.[leaf]).every((p) => parsePrefix(p)?.family === family)) problem('prefix', `A prefix isn't in CIDR form with no host bits set, or isn't an ${family === 'ipv4' ? 'IPv4' : 'IPv6'} prefix in an ${family === 'ipv4' ? 'IPv4' : 'IPv6'} filter.`, ...t, 'matches', leaf)
        const lists = policy?.prefixLists?.[family]
        for (const leaf of ['sourcePrefixLists', 'destinationPrefixLists', 'prefixLists'] as const)
          if (!list(m?.[leaf]).every((n) => typeof n === 'string' && lists !== undefined && Object.hasOwn(lists, n))) problem('unknown-prefix-list', 'A filter term names a prefix list the model doesn\'t have in its family.', ...t, 'matches', leaf)
        if (!list(m?.protocols).every(inRange(255))) problem('number', 'A protocol isn\'t a number from 0 to 255.', ...t, 'matches', 'protocols')
        for (const leaf of ['sourcePorts', 'destinationPorts', 'ports'] as const)
          if (!list(m?.[leaf]).every(isPortRange)) problem('port-range', 'A port isn\'t a port or a range of them (first-last), from 0 to 65535.', ...t, 'matches', leaf)
        for (const leaf of ['icmpTypes', 'icmpCodes'] as const) if (!list(m?.[leaf]).every(inRange(255))) problem('number', `An ICMP ${leaf === 'icmpTypes' ? 'type' : 'code'} isn't a number from 0 to 255.`, ...t, 'matches', leaf)
        if (!list(m?.dscp).every(inRange(63))) problem('number', 'A DSCP value isn\'t a number from 0 to 63.', ...t, 'matches', 'dscp')
        for (const leaf of ['set', 'clear'] as const) if (!list(m?.tcpFlags?.[leaf]).every((f) => TCP_FLAGS.has(f))) problem('tcp-flags', 'A TCP flag isn\'t one of fin, syn, rst, psh, ack, urg, ece and cwr.', ...t, 'matches', 'tcpFlags', leaf)
        if (m?.fragment !== undefined && m.fragment !== 'initial' && m.fragment !== 'non-initial') problem('fragment', 'A fragment match isn\'t initial or non-initial.', ...t, 'matches', 'fragment')
      }
    }
  return out
}

export interface ModelProblemsOptions {
  /**
   * Whether a BGP peer's import and export policies must name policies of the model (since 0.5.0; true by default).
   * The conformance kit turns it off for a plugin that doesn't parse routing policy, which keeps policy names without
   * their bodies, as phase 2 did.
   */
  readonly policyReferences?: boolean
}

/**
 * What is wrong with a model's routing policy (since 0.5.0), as modelProblems() reports it:
 * - a term's, prefix list entry's, route filter's or set entry's key isn't a position (`model.position`);
 * - a prefix isn't in CIDR form with no host bits set, or is in a list of the other family (`model.prefix`), and its
 *   lengths aren't from the prefix's length to the family's longest, or disagree with its form (`model.prefix-length`);
 * - an entry's action isn't `permit` or `deny` (`model.action`), a policy's fall-through is missing or isn't
 *   `next-policy` or `reject` (`model.fall-through`), a term's flow isn't one of the model's (`model.flow`);
 * - a community isn't in one of the model's forms (`model.community`); a community set with a regex says no `type`,
 *   names one the model doesn't have, or has a member of another kind (`model.community-type`); a set with a regex, or
 *   an AS-path set with an entry, says no dialect, or a set names one the model doesn't have (`model.regex-dialect`);
 * - a local preference, MED or tag isn't from 0 to 4294967295 (`model.number`), a prepended AS isn't an AS number
 *   (`model.as-number`), a next hop or neighbor isn't an IP address (`model.ip-address`);
 * - a term or action names a prefix list, community set or AS-path set the model doesn't have
 *   (`model.unknown-prefix-list`, `model.unknown-community-set`, `model.unknown-as-path-set`).
 * A leaf-list's problem is reported on the list, once.
 */
export function routingPolicyProblems(policy: RoutingPolicy | undefined): Diagnostic[] {
  const out: Diagnostic[] = []
  if (!policy) return out
  const problem = (code: string, message: string, ...path: PathSegment[]) => out.push({ severity: 'error', category: 'semantic', code: `model.${code}`, message, field: fieldPath('routingPolicy', ...path) })
  const list = (value: unknown): unknown[] => (value === undefined ? [] : Array.isArray(value) ? value : [value])
  const positions = (map: Keyed<unknown> | undefined, what: string, ...path: PathSegment[]) => {
    for (const [key] of entries(map)) if (!isPositionKey(key)) problem('position', `${what} is keyed by something other than its position, a number from 0 to 4294967294.`, ...path, key)
  }
  /** A prefix match: its prefix (of `family`, when it is a list's) and its lengths. */
  const prefixMatch = (match: PrefixMatch | undefined, family: 'ipv4' | 'ipv6' | undefined, ...path: PathSegment[]) => {
    const prefix = parsePrefix(match?.prefix)
    if (!match || !prefix || (family !== undefined && prefix.family !== family)) {
      problem('prefix', `A prefix isn't in CIDR form with no host bits set${family ? `, or isn't an ${family === 'ipv4' ? 'IPv4' : 'IPv6'} prefix in an ${family === 'ipv4' ? 'IPv4' : 'IPv6'} list` : ''}.`, ...path, 'prefix')
      return
    }
    const { range, form } = lengthsAgree(match, prefix.length, prefix.family === 'ipv4' ? 32 : 128)
    if (!range) problem('prefix-length', 'A prefix match\'s lengths aren\'t from the prefix\'s own length to 32 (IPv4) or 128 (IPv6), the least first.', ...path, 'minLength')
    else if (!form) problem('prefix-length', 'A prefix match\'s lengths don\'t agree with the form it was written in.', ...path, 'form')
  }

  /** An entry's action: `permit` or `deny`, always given. */
  const action = (value: unknown, ...path: PathSegment[]) => {
    if (value !== 'permit' && value !== 'deny') problem('action', 'An entry\'s action isn\'t permit or deny.', ...path, 'action')
  }
  for (const family of ['ipv4', 'ipv6'] as const)
    for (const [name, l] of entries(policy.prefixLists?.[family])) {
      positions(l?.entries, 'A prefix list entry', 'prefixLists', family, name, 'entries')
      for (const [key, e] of entries(l?.entries)) {
        action(e?.action, 'prefixLists', family, name, 'entries', key)
        prefixMatch(e, family, 'prefixLists', family, name, 'entries', key)
      }
    }
  for (const [name, set] of entries(policy.communitySets)) {
    positions(set?.entries, 'A community set entry', 'communitySets', name, 'entries')
    const type = set?.type
    if (type !== undefined && type !== 'standard' && type !== 'extended' && type !== 'large') problem('community-type', 'A community set\'s type isn\'t standard, extended or large.', 'communitySets', name, 'type')
    let regex = false
    for (const [key, e] of entries(set?.entries)) {
      action(e?.action, 'communitySets', name, 'entries', key)
      const members = list(e?.members).map(communityType)
      if (members.some((m) => m === null)) problem('community', 'A community isn\'t in one of the model\'s forms (65000:100, a well-known name, target:…, origin:…, large:…).', 'communitySets', name, 'entries', key, 'members')
      else if (type !== undefined && members.some((m) => m !== type)) problem('community-type', 'A community set has a member of another kind than its type.', 'communitySets', name, 'entries', key, 'members')
      regex ||= list(e?.regexes).length > 0
    }
    // A regex can't say which kind of community it matches (`.*` matches any): the set says.
    if (regex && type === undefined) problem('community-type', 'A community set has a regex but says no type: standard, extended or large.', 'communitySets', name, 'type')
    if (set?.regexDialect !== undefined ? !isDialect(set.regexDialect) : regex) problem('regex-dialect', 'A community set has a regex but says no dialect, or names one the model doesn\'t have.', 'communitySets', name, 'regexDialect')
  }
  for (const [name, set] of entries(policy.asPathSets)) {
    positions(set?.entries, 'An AS-path set entry', 'asPathSets', name, 'entries')
    for (const [key, e] of entries(set?.entries)) action(e?.action, 'asPathSets', name, 'entries', key)
    if (set?.regexDialect !== undefined ? !isDialect(set.regexDialect) : entries(set?.entries).length > 0) problem('regex-dialect', 'An AS-path set has regexes but says no dialect, or names one the model doesn\'t have.', 'asPathSets', name, 'regexDialect')
  }

  /** Whether every name in `names` is a key of `map`. */
  const resolve = (names: unknown, map: Keyed<unknown> | undefined) => list(names).every((n) => typeof n === 'string' && map !== undefined && Object.hasOwn(map, n))
  for (const [name, p] of entries(policy.policies)) {
    // Always given: the same undecided route goes on to the next policy on Junos, and is rejected on Cisco.
    if (p?.fallThrough !== 'next-policy' && p?.fallThrough !== 'reject') problem('fall-through', 'A policy doesn\'t say what happens to a route no term decides (next-policy or reject).', 'policies', name, 'fallThrough')
    positions(p?.terms, 'A policy term', 'policies', name, 'terms')
    for (const [key, term] of entries(p?.terms)) {
      const at = ['policies', name, 'terms', key]
      const m = term?.matches
      for (const family of ['ipv4', 'ipv6'] as const)
        if (!resolve(m?.prefixLists?.[family], policy.prefixLists?.[family])) problem('unknown-prefix-list', 'A policy term names a prefix list the model doesn\'t have.', ...at, 'matches', 'prefixLists', family)
      positions(m?.routeFilters, 'A route filter', ...at, 'matches', 'routeFilters')
      for (const [i, f] of entries(m?.routeFilters)) prefixMatch(f, undefined, ...at, 'matches', 'routeFilters', i)
      if (!resolve(m?.communitySets, policy.communitySets)) problem('unknown-community-set', 'A policy term names a community set the model doesn\'t have.', ...at, 'matches', 'communitySets')
      if (!resolve(m?.asPathSets, policy.asPathSets)) problem('unknown-as-path-set', 'A policy term names an AS-path set the model doesn\'t have.', ...at, 'matches', 'asPathSets')
      if (!list(m?.neighbors).every(isIpAddress)) problem('ip-address', 'A policy term\'s neighbor isn\'t an IP address.', ...at, 'matches', 'neighbors')
      if (!list(m?.tags).every(isUint32)) problem('number', 'A tag isn\'t a number from 0 to 4294967295.', ...at, 'matches', 'tags')
      const a = term?.actions
      if (a?.flow !== undefined && !['accept', 'reject', 'next-term', 'next-policy'].includes(a.flow)) problem('flow', 'A policy term\'s flow isn\'t accept, reject, next-term or next-policy.', ...at, 'actions', 'flow')
      for (const leaf of ['localPreference', 'med', 'tag'] as const)
        if (a?.[leaf] !== undefined && !isUint32(a[leaf])) problem('number', `A policy term's ${leaf === 'med' ? 'MED' : leaf === 'tag' ? 'tag' : 'local preference'} isn't a number from 0 to 4294967295.`, ...at, 'actions', leaf)
      if (!list(a?.asPathPrepend).every(isAsNumber)) problem('as-number', 'A prepended AS isn\'t an AS number from 1 to 4294967295.', ...at, 'actions', 'asPathPrepend')
      if (a?.nextHop !== undefined && !isIpAddress(a.nextHop)) problem('ip-address', 'A policy term\'s next hop isn\'t an IP address.', ...at, 'actions', 'nextHop')
      for (const leaf of ['communityAdd', 'communitySet', 'communityDelete'] as const) {
        if (!list(a?.[leaf]?.values).every((v) => communityType(v) !== null)) problem('community', 'A community isn\'t in one of the model\'s forms (65000:100, a well-known name, target:…, origin:…, large:…).', ...at, 'actions', leaf, 'values')
        if (!resolve(a?.[leaf]?.sets, policy.communitySets)) problem('unknown-community-set', 'A policy term names a community set the model doesn\'t have.', ...at, 'actions', leaf, 'sets')
      }
    }
  }
  return out
}
