// What a model must hold beyond its types: values in the forms model.ts documents, and references that resolve. The
// conformance kit runs modelProblems() on every model a plugin parses (its parse and round-trip checks), so a plugin
// that names a VRF, VLAN, interface or BGP group it never declared, or writes a route distinguisher, VLAN ID or AS number
// in a form no other plugin can read, fails there instead of in a conversion. Messages never quote the config (AGENTS.md, No secrets in diagnostics): a VRF can share
// its name with a secret, so they say what is wrong, and `field` says where.
import type { BgpPeer, Device, Interface, Keyed } from './model'
import { fieldPath } from './paths'
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
 *   one of its instance's (`model.unknown-bgp-group`).
 */
export function modelProblems(device: Device): Diagnostic[] {
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
  }
  return out
}
