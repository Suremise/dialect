// What a model must hold beyond its types: values in the forms model.ts documents, and references that resolve. The
// conformance kit runs modelProblems() on every model a plugin parses (its parse and round-trip checks), so a plugin
// that names a VRF it never declared, or writes a route distinguisher in a form no other plugin can read, fails there
// instead of in a conversion. Messages never quote the config (AGENTS.md, No secrets in diagnostics): a VRF can share
// its name with a secret, so they say what is wrong, and `field` says where.
import type { Device } from './model'
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
 *   `model.route-target`).
 */
export function modelProblems(device: Device): Diagnostic[] {
  const out: Diagnostic[] = []
  const problem = (code: string, message: string, field: string) => out.push({ severity: 'error', category: 'semantic', code: `model.${code}`, message, field })
  const instances = device.networkInstances
  for (const [name, ifc] of entries(device.interfaces)) {
    for (const [index, sub] of entries(ifc?.subinterfaces)) {
      const vrf = sub?.networkInstance
      if (vrf === undefined) continue
      const field = fieldPath('interfaces', name, 'subinterfaces', index, 'networkInstance')
      if (vrf === 'default') problem('default-network-instance', 'A subinterface in the default network instance leaves networkInstance out.', field)
      else if (typeof vrf !== 'string' || !instances || !Object.hasOwn(instances, vrf)) problem('unknown-network-instance', 'A subinterface names a network instance the model doesn\'t have.', field)
    }
  }
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
  }
  return out
}
