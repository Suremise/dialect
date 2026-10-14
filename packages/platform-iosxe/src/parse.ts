// IOS / IOS-XE text → the shared model, for the phase 1 areas: system (hostname, domain name, DNS), interfaces and
// subinterfaces with their addresses and VRF, VRFs (`vrf definition`, `ip vrf`) with their route distinguisher and
// route targets, static routes, NTP, logging and SNMP. Every statement of the tree gets a disposition: `mapped` when
// everything it says went into the model, `ignored-by-design` with why, or `unsupported` (its text kept in the tree). A
// statement is mapped only when every option on it is understood: one with an option the model can't hold
// (`ntp server 192.0.2.1 key 1`) is unsupported as a whole, never half-converted. `vrf forwarding` clears the addresses
// before it, as on the device.
import { fieldPath, isRouteDistinguisher, type Context, type Device, type Diagnostic, type ParseResult, type StatementDisposition, type SyslogSeverity } from '@dialect/core'
import { ipv4Prefix, ipv6Prefix, isIpv4, isIpv6, maskLength } from './addresses'
import { interfaceName, interfaceType, isInterfaceName, splitSubinterface } from './names'
import { BANNER_TYPES, parseTree, unquote, type IosNode } from './tree'

type Obj = { [key: string]: unknown }
type Segments = readonly string[]

/** The model's syslog severities by IOS's names and numbers (`logging trap notifications`, `logging trap 5`). */
export const SEVERITIES: Readonly<Record<string, SyslogSeverity>> = {
  emergencies: 'emergency',
  alerts: 'alert',
  critical: 'critical',
  errors: 'error',
  warnings: 'warning',
  notifications: 'notice',
  informational: 'informational',
  debugging: 'debug'
}
const SEVERITY_NUMBERS = Object.values(SEVERITIES)


const isObject = (v: unknown): v is Obj => typeof v === 'object' && v !== null
/** A key's own value: never one inherited from Object.prototype (a community named `constructor`). */
const ownValue = (o: Obj, key: string): unknown => (Object.hasOwn(o, key) ? o[key] : undefined)
/**
 * Sets an own, enumerable property, as JSON.parse would: plain assignment of `__proto__` would set the object's
 * prototype instead (or, through an inherited object, write to Object.prototype itself).
 */
const putOwn = (o: Obj, key: string, value: unknown) => Object.defineProperty(o, key, { value, enumerable: true, writable: true, configurable: true })

/**
 * Builds the model as plain objects, by path, and names each field as the core does (fieldPath). Keys come from the
 * configuration (community names, VRF and server names), so every access is to own properties only.
 */
class ModelBuilder {
  readonly root: Obj = {}

  /** The object at `segments`, created (with its parents) if missing. */
  object(segments: Segments): Obj {
    let at = this.root
    for (const s of segments) {
      let next = ownValue(at, s)
      if (!isObject(next)) putOwn(at, s, (next = {}))
      at = next as Obj
    }
    return at
  }

  get(segments: Segments): unknown {
    let at: unknown = this.root
    for (const s of segments) {
      if (!isObject(at)) return undefined
      at = ownValue(at, s)
    }
    return at
  }

  /** Sets a leaf; returns its field path. */
  set(segments: Segments, value: unknown): string {
    putOwn(this.object(segments.slice(0, -1)), segments[segments.length - 1], value)
    return fieldPath(...segments)
  }

  remove(segments: Segments): void {
    const parent = this.get(segments.slice(0, -1))
    const key = segments[segments.length - 1]
    if (isObject(parent) && Object.hasOwn(parent, key)) delete parent[key]
  }

  /** Removes the object at `segments` when nothing is left in it. */
  removeIfEmpty(segments: Segments): void {
    const value = this.get(segments)
    if (isObject(value) && !Object.keys(value).length) this.remove(segments)
  }
}

const mapped = (fields: string[]): StatementDisposition => ({ kind: 'mapped', fields })
const unsupported = (reason?: string): StatementDisposition => (reason ? { kind: 'unsupported', reason } : { kind: 'unsupported' })
const ignored = (reason: string): StatementDisposition => ({ kind: 'ignored-by-design', reason })

const INTEGER = /^\d+$/
/**
 * A VRF named on a statement, or undefined for the global table: IOS writes the global table with no `vrf`, so
 * `vrf default` is the same thing written out, and the model leaves it out the same way (a render can't bring it back).
 */
const vrfName = (name: string): string | undefined => (name === 'default' ? undefined : name)
const HOST = /^[A-Za-z0-9][\w.-]*$/
/** Words on a route that aren't an interface name. */
const ROUTE_KEYWORDS = new Set(['tag', 'name', 'permanent', 'track', 'global', 'dhcp', 'multicast', 'vrf'])

/** Where a subinterface's addresses go: `0` for the main interface. */
interface InterfaceContext {
  readonly name: string
  readonly sub: string
  readonly isSub: boolean
}

/** Parses IOS / IOS-XE `text` into the model, with a disposition for every statement of its tree. */
export function parse(text: string, _context: Context): ParseResult {
  const { nodes, diagnostics: treeDiagnostics } = parseTree(text)
  const diagnostics: Diagnostic[] = [...treeDiagnostics]
  const model = new ModelBuilder()
  const dispositions: Record<string, StatementDisposition> = {}
  const set = (node: IosNode, disposition: StatementDisposition) => {
    dispositions[node.id] = disposition
  }
  const line = (node: IosNode) => node.span.startLine
  const linesText = (lines: number[]) => `line${lines.length > 1 ? 's' : ''} ${lines.join(', ')}`

  /** The statement that last set a single-valued setting, by key: a later one supersedes it, as on the device. */
  const owners = new Map<string, IosNode>()
  const claim = (key: string, node: IosNode, onSupersede?: () => void) => {
    const previous = owners.get(key)
    if (previous && previous !== node) {
      onSupersede?.()
      set(previous, ignored(`superseded by line ${node.span.startLine}`))
    }
    owners.set(key, node)
  }

  // Applied once every statement is read: they depend on others, wherever those are in the text.
  const deferred: (() => void)[] = []

  const ensureInterface = (name: string): string[] => {
    const fields: string[] = []
    model.object(['interfaces', name])
    const type = interfaceType(name)
    if (type) fields.push(model.set(['interfaces', name, 'type'], type))
    return fields
  }

  // ---- interfaces

  /** Per subinterface (`name|sub`): the statements of its current IPv4 addresses, primary and secondary. */
  type AddressStatement = { readonly node: IosNode; readonly address: string }
  const addressing = new Map<string, { readonly ctx: InterfaceContext; primary?: AddressStatement; secondaries: AddressStatement[] }>()
  const addressingOf = (ctx: InterfaceContext) => {
    const key = `${ctx.name}|${ctx.sub}`
    const state = addressing.get(key) ?? { ctx, secondaries: [] }
    addressing.set(key, state)
    return state
  }
  /** Per subinterface (`name|sub`): the statements of its current IPv6 addresses. */
  const ipv6Addressing = new Map<string, AddressStatement[]>()
  const subPath = (ctx: InterfaceContext) => ['interfaces', ctx.name, 'subinterfaces', ctx.sub]

  /** Drops what removing addresses left empty: the address map, the family, a main interface's subinterface 0. */
  const pruneFamily = (ctx: InterfaceContext, family: 'ipv4' | 'ipv6') => {
    const sub = subPath(ctx)
    model.removeIfEmpty([...sub, family, 'addresses'])
    model.removeIfEmpty([...sub, family])
    if (!ctx.isSub) pruneMain(ctx)
  }
  const pruneIpv4 = (ctx: InterfaceContext) => pruneFamily(ctx, 'ipv4')
  /** A main interface's subinterface 0 left with nothing in it: dropped, with the map it was in when that is empty too. */
  const pruneMain = (ctx: InterfaceContext) => {
    model.removeIfEmpty(subPath(ctx))
    model.removeIfEmpty(['interfaces', ctx.name, 'subinterfaces'])
  }

  /**
   * Removes every address of the subinterface (IPv4 and IPv6) configured before now, each statement marked with
   * `disposition`; the statements' lines, in order.
   */
  const clearAddresses = (ctx: InterfaceContext, disposition: StatementDisposition, families: readonly ('ipv4' | 'ipv6')[] = ['ipv4', 'ipv6']): number[] => {
    const key = `${ctx.name}|${ctx.sub}`
    const v4 = addressing.get(key)
    const removed: [AddressStatement, 'ipv4' | 'ipv6'][] = [
      ...(v4 && families.includes('ipv4') ? [...(v4.primary ? [v4.primary] : []), ...v4.secondaries] : []).map((a) => [a, 'ipv4'] as [AddressStatement, 'ipv4']),
      ...(families.includes('ipv6') ? (ipv6Addressing.get(key) ?? []) : []).map((a) => [a, 'ipv6'] as [AddressStatement, 'ipv6'])
    ]
    for (const [a, family] of removed) {
      model.remove([...subPath(ctx), family, 'addresses', a.address])
      set(a.node, disposition)
    }
    for (const family of families) {
      if (family === 'ipv4') addressing.delete(key)
      else ipv6Addressing.delete(key)
      pruneFamily(ctx, family)
    }
    return removed.map(([a]) => line(a.node)).sort((a, b) => a - b)
  }

  /** Per subinterface (`name|sub`): the VRF it is in and the statement that put it there. */
  const membership = new Map<string, { readonly ctx: InterfaceContext; readonly vrf: string; readonly node?: IosNode }>()

  /**
   * `vrf forwarding V` / `ip vrf forwarding V` and their `no` forms: the subinterface's `networkInstance` (subinterface
   * `0` for a main interface). Moving an interface to another VRF, or back to the global table, clears its IPv4 and
   * IPv6 addresses, as on the device, so only the addresses after it stay.
   */
  const mapVrfForwarding = (node: IosNode, ctx: InterfaceContext, remove: boolean, legacy: boolean): StatementDisposition => {
    const w = node.words.slice((remove ? 1 : 0) + (legacy ? 1 : 0))
    if (w.length > 3 || (!remove && w.length !== 3)) return unsupported()
    const key = `${ctx.name}|${ctx.sub}`
    const current: { vrf: string; node?: IosNode } = membership.get(key) ?? { vrf: 'default' }
    const target = remove ? 'default' : w[2]
    const at = [...subPath(ctx), 'networkInstance']
    // IOS names no global table: a VRF called `default` would be another VRF, which the model can't tell apart.
    if (!remove && target === 'default') return unsupported('a VRF named like the global table')
    if (remove && w[2] !== undefined && w[2] !== current.vrf) return ignored('not in that VRF: nothing to convert')
    if (target === current.vrf) return ignored(remove ? 'already in the global table: nothing to convert' : `already in that VRF${current.node ? ` (line ${line(current.node)})` : ''}`)
    const lines = clearAddresses(ctx, ignored(`removed by line ${line(node)}, which moves the interface to another VRF`))
    const cleared = lines.length ? `, clearing the addresses on ${linesText(lines)}` : ''
    if (current.node) set(current.node, ignored(`undone by line ${line(node)}`))
    if (remove) {
      membership.set(key, { ctx, vrf: 'default' })
      model.remove(at)
      if (!ctx.isSub) pruneMain(ctx)
      return ignored(`returns the interface to the global table${cleared}: nothing to convert`)
    }
    membership.set(key, { ctx, vrf: target, node })
    return mapped([model.set(at, target)])
  }

  const mapInterfaceChild = (node: IosNode, ctx: InterfaceContext): StatementDisposition => {
    const w = node.words
    const lw = w.map((x) => x.toLowerCase())
    const iface = ['interfaces', ctx.name]
    const sub = [...iface, 'subinterfaces', ctx.sub]
    const own = ctx.isSub ? sub : iface

    if (lw[0] === 'description' && w.length > 1) {
      const path = [...own, 'description']
      claim(fieldPath(...path), node)
      return mapped([model.set(path, node.text.replace(/^\S+\s+/, ''))])
    }
    if (lw[0] === 'no' && lw[1] === 'description' && w.length === 2) {
      const path = [...own, 'description']
      const previous = owners.get(fieldPath(...path))
      if (!previous) return ignored('no description to remove: nothing to convert')
      owners.delete(fieldPath(...path))
      model.remove(path)
      set(previous, ignored(`removed by line ${line(node)}`))
      return ignored(`removes the description on line ${line(previous)}: nothing to convert`)
    }
    if (/^shut(?:d(?:o(?:w(?:n)?)?)?)?$/.test(lw[0]) && w.length === 1) {
      claim(fieldPath(...own, 'enabled'), node)
      return mapped([model.set([...own, 'enabled'], false)])
    }
    if (lw[0] === 'no' && w.length === 2 && /^shut(?:d(?:o(?:w(?:n)?)?)?)?$/.test(lw[1])) {
      claim(fieldPath(...own, 'enabled'), node)
      return mapped([model.set([...own, 'enabled'], true)])
    }
    if (lw[0] === 'exit' && w.length === 1) return ignored('ends the interface\'s configuration mode')
    if (lw[0] === 'mtu' && w.length === 2 && INTEGER.test(w[1])) {
      if (ctx.isSub) return unsupported('the model has no MTU for a subinterface: use "ip mtu"')
      claim(fieldPath(...iface, 'mtu'), node)
      return mapped([model.set([...iface, 'mtu'], Number(w[1]))])
    }
    if (lw[0] === 'encapsulation' && lw[1] === 'dot1q' && w.length === 3 && INTEGER.test(w[2])) {
      if (!ctx.isSub) return unsupported('encapsulation dot1Q on a main interface')
      claim(fieldPath(...sub, 'vlanId'), node)
      return mapped([model.set([...sub, 'vlanId'], Number(w[2])), model.set([...iface, 'vlanTagging'], true)])
    }
    if (lw[0] === 'ip' && lw[1] === 'address' && w.length >= 3) return mapIpv4Address(node, ctx, sub)
    if (lw[0] === 'no' && lw[1] === 'ip' && lw[2] === 'address' && w.length === 3) return removeIpv4Addresses(node, ctx)
    if (lw[0] === 'ipv6' && lw[1] === 'address' && w.length === 3) {
      const p = ipv6Prefix(w[2])
      if (!p) return unsupported()
      const key = `${ctx.name}|${ctx.sub}`
      ipv6Addressing.set(key, [...(ipv6Addressing.get(key) ?? []), { node, address: p.address }])
      return mapped([model.set([...sub, 'ipv6', 'addresses', p.address, 'prefixLength'], p.length)])
    }
    if (lw[0] === 'vrf' && lw[1] === 'forwarding') return mapVrfForwarding(node, ctx, false, false)
    if (lw[0] === 'ip' && lw[1] === 'vrf' && lw[2] === 'forwarding') return mapVrfForwarding(node, ctx, false, true)
    if (lw[0] === 'no' && lw[1] === 'vrf' && lw[2] === 'forwarding') return mapVrfForwarding(node, ctx, true, false)
    if (lw[0] === 'no' && lw[1] === 'ip' && lw[2] === 'vrf' && lw[3] === 'forwarding') return mapVrfForwarding(node, ctx, true, true)
    if ((lw[0] === 'ip' || lw[0] === 'ipv6') && lw[1] === 'mtu' && w.length === 3 && INTEGER.test(w[2])) {
      const path = [...sub, lw[0] === 'ip' ? 'ipv4' : 'ipv6', 'mtu']
      claim(fieldPath(...path), node)
      return mapped([model.set(path, Number(w[2]))])
    }
    return unsupported()
  }

  const mapIpv4Address = (node: IosNode, ctx: InterfaceContext, sub: Segments): StatementDisposition => {
    const w = node.words
    const secondary = w[w.length - 1].toLowerCase() === 'secondary'
    const args = w.slice(2, secondary ? -1 : undefined)
    const prefix = args.length === 2 ? ipv4Prefix(args[0], args[1]) : args.length === 1 ? ipv4Prefix(args[0]) : null
    if (!prefix) return unsupported(args.length === 2 && isIpv4(args[0]) && maskLength(args[1]) === null ? 'not a contiguous mask' : undefined)
    const [address, length] = prefix.split('/')
    const state = addressingOf(ctx)
    if (secondary) state.secondaries.push({ node, address })
    else {
      // A second primary replaces the first, as on the device.
      if (state.primary && state.primary.node !== node) {
        if (state.primary.address !== address) model.remove([...sub, 'ipv4', 'addresses', state.primary.address])
        set(state.primary.node, ignored(`replaced by line ${node.span.startLine}`))
      }
      state.primary = { node, address }
    }
    return mapped([model.set([...sub, 'ipv4', 'addresses', address, 'prefixLength'], Number(length))])
  }

  /** `no ip address`: removes every IPv4 address before it on the interface, as on the device. */
  const removeIpv4Addresses = (node: IosNode, ctx: InterfaceContext): StatementDisposition => {
    const state = addressing.get(`${ctx.name}|${ctx.sub}`)
    const removed = state ? [...(state.primary ? [state.primary] : []), ...state.secondaries] : []
    if (!removed.length) return ignored('says the interface has no IPv4 address: nothing to convert')
    for (const r of removed) {
      model.remove([...subPath(ctx), 'ipv4', 'addresses', r.address])
      set(r.node, ignored(`removed by "no ip address" on line ${node.span.startLine}`))
    }
    addressing.delete(`${ctx.name}|${ctx.sub}`)
    pruneIpv4(ctx)
    const lines = removed.map((r) => r.node.span.startLine).sort((a, b) => a - b)
    return ignored(`removes the IPv4 addresses before it (line${lines.length > 1 ? 's' : ''} ${lines.join(', ')}): nothing to convert`)
  }

  const mapInterface = (node: IosNode): void => {
    const w = node.words
    const n = interfaceName(w, 1)
    if (!n || 1 + n.used !== w.length) {
      unsupportedTree(node)
      return
    }
    const split = splitSubinterface(n.name)
    const ctx: InterfaceContext = split ? { name: split.parent, sub: split.index, isSub: true } : { name: n.name, sub: '0', isSub: false }
    const fields = ensureInterface(ctx.name)
    if (split) model.object(['interfaces', ctx.name, 'subinterfaces', ctx.sub])
    set(node, mapped(fields))
    for (const child of node.children) {
      if (child.kind !== 'statement' || child.children.length) unsupportedTree(child)
      else set(child, mapInterfaceChild(child, ctx))
    }
  }

  // ---- static routes

  /** The `ip route vrf V …` statements of each VRF, with their prefix and family, so removing the VRF (or one of its families) removes them. */
  const routeStatements = new Map<string, { readonly node: IosNode; readonly prefix: string; readonly family: 'ipv4' | 'ipv6' }[]>()

  /** One next hop of a route, by the statement that configured it. */
  type RouteHop = { readonly node: IosNode; readonly hop: Obj; readonly name?: string }
  /** Each route's next hops (`instance|prefix`), in order, so `no ip route` can remove some and the rest keep theirs. */
  const routeHops = new Map<string, { readonly instance: string; readonly prefix: string; readonly v6: boolean; hops: RouteHop[] }>()
  const hopKey = (hop: Obj) => `${hop.interface ?? ''}|${hop.address ?? ''}|${hop.drop ?? ''}`

  /** The words of an `ip route` / `ipv6 route` from `i` (`vrf V`, the prefix): the route and its next hop, or why not. */
  const readRoute = (w: readonly string[], i: number, v6: boolean): { instance: string; prefix: string; hop: Obj; name?: string } | { reason?: string } => {
    let instance = 'default'
    if (w[i]?.toLowerCase() === 'vrf' && w[i + 1]) {
      instance = w[i + 1]
      i += 2
    }
    let prefix: string | null = null
    if (v6) {
      const p = w[i] ? ipv6Prefix(w[i]) : null
      prefix = p && `${p.address}/${p.length}`
      i++
    } else if (w[i]?.includes('/')) {
      prefix = ipv4Prefix(w[i])
      i++
    } else {
      prefix = w[i + 1] ? ipv4Prefix(w[i], w[i + 1]) : null
      i += 2
    }
    if (!prefix) return {}

    const hop: Obj = {}
    let name: string | undefined
    while (i < w.length) {
      const word = w[i]
      const lower = word.toLowerCase()
      if (lower === 'tag' && INTEGER.test(w[i + 1] ?? '') && hop.tag === undefined) {
        hop.tag = Number(w[i + 1])
        i += 2
      } else if (lower === 'name' && w[i + 1] !== undefined && name === undefined) {
        name = unquote(w[i + 1])
        i += 2
      } else if ((v6 ? isIpv6(word) : isIpv4(word)) && hop.address === undefined && hop.preference === undefined) {
        hop.address = v6 ? word.toLowerCase() : word
        i++
      } else if (INTEGER.test(word) && hop.preference === undefined && (hop.address !== undefined || hop.interface !== undefined || hop.drop !== undefined) && Number(word) >= 1 && Number(word) <= 255) {
        hop.preference = Number(word)
        i++
      } else if (!ROUTE_KEYWORDS.has(lower) && hop.address === undefined && hop.interface === undefined && hop.drop === undefined && isInterfaceName(interfaceName(w, i)?.name ?? '')) {
        // Only a real interface name: a malformed address or a stray word isn't one.
        const n = interfaceName(w, i)!
        if (/^null0$/i.test(n.name)) hop.drop = 'discard'
        else hop.interface = n.name
        i += n.used
      } else return { reason: `"${word}" isn't converted yet` }
    }
    return { instance, prefix, hop, ...(name !== undefined ? { name } : {}) }
  }

  /** The model fields of a route's next hops, in order: written (again) from its statements, each mapped to its own. */
  const writeRoute = (route: { readonly instance: string; readonly prefix: string; hops: RouteHop[] }) => {
    const routeAt = ['networkInstances', route.instance, 'staticRoutes', route.prefix]
    model.remove(routeAt)
    route.hops.forEach((h, index) => {
      const fields: string[] = []
      if (route.instance !== 'default') fields.push(model.set(['networkInstances', route.instance, 'type'], 'vrf'))
      if (h.name !== undefined) fields.push(model.set([...routeAt, 'description'], h.name))
      for (const [k, v] of Object.entries(h.hop)) fields.push(model.set([...routeAt, 'nextHops', String(index), k], v))
      set(h.node, mapped(fields))
    })
    if (!route.hops.length) {
      model.removeIfEmpty(['networkInstances', route.instance, 'staticRoutes'])
      if (route.instance === 'default') model.removeIfEmpty(['networkInstances', 'default'])
      model.removeIfEmpty(['networkInstances'])
    }
  }

  /** `ip route …` / `ipv6 route …`: one next hop of a route. */
  const mapRoute = (node: IosNode, v6: boolean): StatementDisposition => {
    const r = readRoute(node.words, 2, v6)
    if (!('prefix' in r)) return unsupported(r.reason)
    const { instance, prefix, hop, name } = r
    if (hop.address === undefined && hop.interface === undefined && hop.drop === undefined) return unsupported('no next hop')

    const routeAt = ['networkInstances', instance, 'staticRoutes', prefix]
    const existing = model.get([...routeAt, 'description'])
    if (name !== undefined && existing !== undefined && existing !== name) return unsupported(`a second name for ${prefix}`)

    if (instance !== 'default') routeStatements.set(instance, [...(routeStatements.get(instance) ?? []), { node, prefix, family: v6 ? 'ipv6' : 'ipv4' }])
    const key = `${instance}|${prefix}`
    const route = routeHops.get(key) ?? { instance, prefix, v6, hops: [] }
    routeHops.set(key, route)
    route.hops.push({ node, hop, ...(name !== undefined ? { name } : {}) })
    const fields: string[] = []
    if (instance !== 'default') fields.push(model.set(['networkInstances', instance, 'type'], 'vrf'))
    if (name !== undefined) fields.push(model.set([...routeAt, 'description'], name))
    const index = String(route.hops.length - 1)
    for (const [k, v] of Object.entries(hop)) fields.push(model.set([...routeAt, 'nextHops', index, k], v))
    return mapped(fields)
  }

  /**
   * `no ip route [vrf V] P [next hop]` / `no ipv6 route …`: removes that next hop of the route in that VRF (or the global
   * table), or every one when it names none; the others keep their order.
   */
  const removeRoute = (node: IosNode, v6: boolean): StatementDisposition => {
    const r = readRoute(node.words, 3, v6)
    if (!('prefix' in r)) return unsupported(r.reason)
    const route = routeHops.get(`${r.instance}|${r.prefix}`)
    const any = r.hop.address === undefined && r.hop.interface === undefined && r.hop.drop === undefined
    const removed = route?.hops.filter((h) => any || hopKey(h.hop) === hopKey(r.hop)) ?? []
    if (!route || !removed.length) return ignored('no such route: nothing to convert')
    for (const h of removed) set(h.node, ignored(`removed by line ${line(node)}`))
    route.hops = route.hops.filter((h) => !removed.includes(h))
    if (!route.hops.length) routeHops.delete(`${r.instance}|${r.prefix}`)
    writeRoute(route)
    const statements = routeStatements.get(r.instance)
    if (statements) routeStatements.set(r.instance, statements.filter((st) => !removed.some((h) => h.node === st.node)))
    return ignored(`removes the route on ${linesText(removed.map((h) => line(h.node)))}: nothing to convert`)
  }

  // ---- VRFs

  /** A `route-target import|export|both V` statement, with the directions it still sets (`no route-target` can take one). */
  type RouteTarget = { readonly node: IosNode; directions: ('import' | 'export')[]; readonly value: string }
  /**
   * Each VRF's definition statements, so removing it can remove them, and its route targets: VRF-wide, and per address
   * family (`ipv4`, `ipv6`), with the families seen. Each scope (the VRF, a family) keeps the first statement in it about
   * them not converted, so removing a family takes its own with it. The route targets are a whole, so one left out in a
   * scope still there leaves them all out.
   */
  type Scope = { unconverted?: IosNode }
  type Family = Scope & { readonly statements: IosNode[]; readonly targets: RouteTarget[] }
  type VrfState = Scope & { readonly definitions: IosNode[]; readonly common: RouteTarget[]; readonly families: Map<'ipv4' | 'ipv6', Family> }
  const vrfs = new Map<string, VrfState>()
  const vrfState = (instance: string): VrfState => {
    const state = vrfs.get(instance) ?? { definitions: [], common: [], families: new Map() }
    vrfs.set(instance, state)
    return state
  }

  /** `route-target …` and `no route-target …`, VRF-wide or in an address family: on `targets`. */
  const mapRouteTarget = (node: IosNode, scope: Scope, targets: RouteTarget[]): void => {
    const w = node.words
    const lw = w.map((x) => x.toLowerCase())
    const remove = lw[0] === 'no'
    const d = lw[remove ? 2 : 1]
    const value = w[remove ? 3 : 2]
    if (w.length !== (remove ? 4 : 3) || (d !== 'import' && d !== 'export' && d !== 'both') || !isRouteDistinguisher(value)) {
      set(node, unsupported(remove ? undefined : 'not a route target in the form ASN:nn or IP:nn'))
      scope.unconverted ??= node
      return
    }
    const directions: ('import' | 'export')[] = d === 'both' ? ['import', 'export'] : [d]
    if (!remove) {
      targets.push({ node, directions, value })
      return set(node, mapped([]))
    }
    const removed = targets.filter((t) => t.value === value && t.directions.some((x) => directions.includes(x)))
    for (const t of removed) {
      t.directions = t.directions.filter((x) => !directions.includes(x))
      if (!t.directions.length) set(t.node, ignored(`removed by line ${line(node)}`))
    }
    targets.splice(0, targets.length, ...targets.filter((t) => t.directions.length))
    set(node, ignored(removed.length ? `removes the route target on ${linesText(removed.map((t) => line(t.node)))}: nothing to convert` : 'no such route target: nothing to convert'))
  }

  /**
   * `vrf definition V` (and the older `ip vrf V`): the VRF, its route distinguisher and route targets, VRF-wide or in
   * `address-family ipv4|ipv6`. IOS sets route targets per address family; the model holds one set for the VRF, so they
   * map once every family's agree (once every statement is read).
   */
  const mapVrfDefinition = (node: IosNode, legacy: boolean): void => {
    const w = node.words
    if (w.length !== 3 || w[2] === 'default') return unsupportedTree(node)
    const instance = w[2]
    const state = vrfState(instance)
    state.definitions.push(node)
    set(node, mapped([model.set(['networkInstances', instance, 'type'], 'vrf')]))
    const rd = ['networkInstances', instance, 'routeDistinguisher']
    for (const child of node.children) {
      const cw = child.words
      const lw = cw.map((x) => x.toLowerCase())
      const leaf = child.kind === 'statement' && !child.children.length
      if (child.kind === 'comment') set(child, ignored('a comment'))
      else if (leaf && lw[0] === 'rd' && cw.length === 2) {
        claim(`vrf ${instance} rd`, child, () => model.remove(rd))
        set(child, isRouteDistinguisher(cw[1]) ? mapped([model.set(rd, cw[1])]) : unsupported('not a route distinguisher in the form ASN:nn or IP:nn'))
      } else if (leaf && lw[0] === 'no' && lw[1] === 'rd' && cw.length <= 3) {
        const previous = owners.get(`vrf ${instance} rd`)
        owners.delete(`vrf ${instance} rd`)
        model.remove(rd)
        if (previous) set(previous, ignored(`removed by line ${line(child)}`))
        set(child, ignored(previous ? `removes the route distinguisher on line ${line(previous)}: nothing to convert` : 'no route distinguisher to remove: nothing to convert'))
      } else if (leaf && (lw[0] === 'route-target' || (lw[0] === 'no' && lw[1] === 'route-target'))) mapRouteTarget(child, state, state.common)
      else if (!legacy && leaf && lw[0] === 'no' && lw[1] === 'address-family' && (lw[2] === 'ipv4' || lw[2] === 'ipv6') && (cw.length === 3 || (cw.length === 4 && lw[3] === 'unicast'))) set(child, removeFamily(child, instance, lw[2]))
      else if (!legacy && child.kind === 'statement' && lw[0] === 'address-family' && (lw[1] === 'ipv4' || lw[1] === 'ipv6') && (cw.length === 2 || (cw.length === 3 && lw[2] === 'unicast'))) {
        const family = state.families.get(lw[1]) ?? { statements: [], targets: [] }
        state.families.set(lw[1], family)
        family.statements.push(child)
        const targets = family.targets
        set(child, ignored('an address family of the VRF: the model\'s VRFs carry every family, and a render writes the ones its addresses and routes need'))
        for (const c of child.children) {
          const clw = c.words.map((x) => x.toLowerCase())
          if (c.kind === 'comment') set(c, ignored('a comment'))
          else if (c.kind === 'statement' && !c.children.length && (clw[0] === 'route-target' || (clw[0] === 'no' && clw[1] === 'route-target'))) mapRouteTarget(c, family, targets)
          else if (c.kind === 'statement' && !c.children.length && clw[0] === 'exit-address-family' && c.words.length === 1) set(c, ignored('ends the address family'))
          else {
            // An import or export map, a route limit: it may change what the route targets do.
            unsupportedTree(c)
            family.unconverted ??= c
          }
        }
      } else if (leaf && lw[0] === 'exit-address-family' && cw.length === 1) set(child, ignored('ends the address family'))
      else {
        unsupportedTree(child)
        // An import or export map, or anything else not converted beside them, may change what the route targets do: they
        // are left out whole. Only a description can't.
        if (!(leaf && lw[0] === 'description')) state.unconverted ??= child
      }
    }
  }

  /**
   * `no address-family ipv4|ipv6` in a VRF definition: the family's statements and route targets go. The VRF's
   * interface addresses and routes in that family, before it, are left out: what the device keeps of them isn't
   * something the model should guess.
   */
  const removeFamily = (node: IosNode, instance: string, name: 'ipv4' | 'ipv6'): StatementDisposition => {
    const state = vrfs.get(instance)
    const family = state?.families.get(name)
    if (!state || !family) return ignored('no such address family: nothing to convert')
    const removed = ignored(`removed by line ${line(node)}`)
    const inside = (n: IosNode): IosNode[] => n.children.flatMap((c) => (c.kind === 'comment' ? [] : [c, ...inside(c)]))
    for (const n of [...family.statements, ...family.statements.flatMap(inside)]) set(n, removed)
    state.families.delete(name)
    const leftOut = unsupported(`in an address family of its VRF that line ${line(node)} removes: left out`)
    for (const m of membership.values()) if (m.vrf === instance) clearAddresses(m.ctx, leftOut, [name])
    const routes = routeStatements.get(instance) ?? []
    for (const [key, route] of routeHops) if (route.instance === instance && route.v6 === (name === 'ipv6')) routeHops.delete(key)
    for (const r of routes.filter((route) => route.family === name)) {
      set(r.node, leftOut)
      model.remove(['networkInstances', instance, 'staticRoutes', r.prefix])
    }
    model.removeIfEmpty(['networkInstances', instance, 'staticRoutes'])
    routeStatements.set(instance, routes.filter((r) => r.family !== name))
    return ignored(`removes the address family on ${linesText(family.statements.map(line))}: nothing to convert`)
  }

  /** `no vrf definition V` / `no ip vrf V`: the VRF and everything in it, its routes, and its interfaces' membership and addresses. */
  const removeVrfDefinition = (node: IosNode): StatementDisposition => {
    const w = node.words.slice(1)
    if (w.length !== 3) return unsupported()
    const instance = w[2]
    const definitions = vrfs.get(instance)?.definitions ?? []
    const routes = (routeStatements.get(instance) ?? []).map((r) => r.node)
    const members = [...membership.values()].filter((m) => m.vrf === instance)
    if (!definitions.length && !routes.length && !members.length) return ignored('no such VRF: nothing to convert')
    const why = ignored(`removed by line ${line(node)}`)
    const inside = (n: IosNode): IosNode[] => n.children.flatMap((c) => (c.kind === 'comment' ? [] : [c, ...inside(c)]))
    for (const n of [...definitions, ...definitions.flatMap(inside), ...routes]) set(n, why)
    // On the device, the VRF's interfaces lose their membership and their addresses with it.
    const lines = [...definitions, ...routes].map(line)
    for (const m of members) {
      lines.push(...clearAddresses(m.ctx, why))
      if (m.node) {
        set(m.node, why)
        lines.push(line(m.node))
      }
      membership.set(`${m.ctx.name}|${m.ctx.sub}`, { ctx: m.ctx, vrf: 'default' })
      model.remove([...subPath(m.ctx), 'networkInstance'])
      if (!m.ctx.isSub) pruneMain(m.ctx)
    }
    owners.delete(`vrf ${instance} rd`)
    vrfs.delete(instance)
    routeStatements.delete(instance)
    for (const [key, route] of routeHops) if (route.instance === instance) routeHops.delete(key)
    model.remove(['networkInstances', instance])
    model.removeIfEmpty(['networkInstances'])
    return ignored(`removes the VRF, its routes and its interfaces' membership and addresses (${linesText(lines.sort((a, b) => a - b))}): nothing to convert`)
  }

  // ---- DNS

  /** `ip name-server [vrf V] A [B …]`: one statement can name several servers, in order. */
  const mapNameServers = (node: IosNode): StatementDisposition => {
    const w = node.words
    let i = 2
    let vrf: string | undefined
    if (w[i]?.toLowerCase() === 'vrf' && w[i + 1]) {
      vrf = vrfName(w[i + 1])
      i += 2
    }
    const addresses = w.slice(i)
    if (!addresses.length) return unsupported()
    const bad = addresses.find((a) => !isIpv4(a) && !isIpv6(a))
    if (bad !== undefined) return unsupported(`"${bad}" isn't converted yet`)
    const keys = addresses.map((a) => (isIpv6(a) ? a.toLowerCase() : a))
    // The model keys servers by address alone: the same server in another VRF has nowhere to go.
    for (const key of keys) {
      const existing = model.get(['system', 'dns', 'servers', key])
      if (existing !== undefined && (existing as Obj).networkInstance !== vrf) return unsupported(`${key} is already a name server in another VRF`)
    }
    const fields = keys.map((key) => (vrf === undefined ? model.set(['system', 'dns', 'servers', key], model.get(['system', 'dns', 'servers', key]) ?? {}) : model.set(['system', 'dns', 'servers', key, 'networkInstance'], vrf)))
    for (const key of keys) nameServerStatements.set(key, [...(nameServerStatements.get(key) ?? []), node])
    nameServerFields.set(node, { keys, fields })
    return mapped(fields)
  }

  /** The statements that added each name server, by address, and what each one mapped, so `no ip name-server` can remove them. */
  const nameServerStatements = new Map<string, IosNode[]>()
  const nameServerFields = new Map<IosNode, { keys: string[]; fields: string[] }>()

  /** `no ip name-server [vrf V] A [B …]`: removes those servers in that VRF (no VRF: the global table) only. */
  const removeNameServers = (node: IosNode): StatementDisposition => {
    const w = node.words
    let i = 3
    let vrf: string | undefined
    if (w[i]?.toLowerCase() === 'vrf' && w[i + 1]) {
      vrf = vrfName(w[i + 1])
      i += 2
    }
    const keys = w.slice(i).map((a) => (isIpv6(a) ? a.toLowerCase() : a))
    if (!keys.length || !keys.every((a) => isIpv4(a) || isIpv6(a))) return unsupported()
    const lines: number[] = []
    for (const key of keys) {
      const existing = model.get(['system', 'dns', 'servers', key])
      if (existing === undefined || (existing as Obj).networkInstance !== vrf) continue
      for (const added of nameServerStatements.get(key) ?? []) {
        const entry = nameServerFields.get(added)!
        const at = fieldPath('system', 'dns', 'servers', key)
        entry.keys = entry.keys.filter((k) => k !== key)
        entry.fields = entry.fields.filter((f) => f !== at && !f.startsWith(`${at}.`))
        set(added, entry.keys.length ? mapped(entry.fields) : ignored(`removed by line ${line(node)}`))
        lines.push(line(added))
      }
      nameServerStatements.delete(key)
      model.remove(['system', 'dns', 'servers', key])
      for (const at of [['system', 'dns', 'servers'], ['system', 'dns'], ['system']]) model.removeIfEmpty(at)
    }
    return ignored(lines.length ? `removes name servers configured on ${linesText([...new Set(lines)].sort((a, b) => a - b))}: nothing to convert` : 'no such name server in that VRF: nothing to convert')
  }

  /** `ip domain list X` / `ip domain-list X`: one search domain, appended in order. */
  const mapDomainList = (node: IosNode): StatementDisposition => {
    const w = node.words
    const args = w.slice(w[1].toLowerCase() === 'domain' ? 3 : 2)
    if (args.length !== 1) return unsupported()
    const search = (model.get(['system', 'dns', 'search']) as string[] | undefined) ?? []
    if (search.includes(args[0])) return ignored('already in the search list')
    return mapped([model.set(['system', 'dns', 'search'], [...search, args[0]])])
  }

  // ---- NTP, logging, SNMP

  const mapNtp = (node: IosNode): StatementDisposition => {
    const w = node.words
    const lw = w.map((x) => x.toLowerCase())
    if ((lw[1] === 'source' || lw[1] === 'source-interface') && w.length >= 3) {
      const n = interfaceName(w, 2)
      if (!n || 2 + n.used !== w.length) return unsupported()
      claim('ntp source', node)
      return mapped([model.set(['system', 'ntp', 'sourceInterface'], n.name)])
    }
    if (lw[1] !== 'server') return unsupported()
    let i = 2
    const server: Obj = {}
    if (lw[i] === 'vrf' && w[i + 1]) {
      const vrf = vrfName(w[i + 1])
      if (vrf !== undefined) server.networkInstance = vrf
      i += 2
    }
    const address = w[i++]
    if (!address || !(isIpv4(address) || isIpv6(address) || HOST.test(address))) return unsupported()
    while (i < w.length) {
      if (lw[i] === 'prefer' && server.prefer === undefined) {
        server.prefer = true
        i++
      } else if (lw[i] === 'version' && /^[1-4]$/.test(w[i + 1] ?? '') && server.version === undefined) {
        server.version = Number(w[i + 1])
        i += 2
      } else return unsupported(`"${w[i]}" isn't converted yet`)
    }
    const key = isIpv6(address) ? address.toLowerCase() : address
    const at = ['system', 'ntp', 'servers', key]
    claim(fieldPath(...at), node, () => model.remove(at))
    if (!Object.keys(server).length) return mapped([model.set(at, {})])
    return mapped(Object.entries(server).map(([k, v]) => model.set([...at, k], v)))
  }

  const loggingServers = () => Object.keys((model.get(['system', 'logging', 'remoteServers']) as Obj | undefined) ?? {})

  const mapLogging = (node: IosNode): StatementDisposition => {
    const w = node.words
    const lw = w.map((x) => x.toLowerCase())
    if (lw[1] === 'source-interface' && w.length >= 3) {
      const n = interfaceName(w, 2)
      if (!n || 2 + n.used !== w.length) return unsupported()
      claim('logging source', node)
      return mapped([model.set(['system', 'logging', 'sourceInterface'], n.name)])
    }
    if ((lw[1] === 'trap' || lw[1] === 'facility') && w.length === 3) {
      const value = lw[1] === 'trap' ? (Object.hasOwn(SEVERITIES, lw[2]) ? SEVERITIES[lw[2]] : /^[0-7]$/.test(lw[2]) ? SEVERITY_NUMBERS[Number(lw[2])] : undefined) : /^[a-z][a-z0-9]*$/.test(lw[2]) ? lw[2] : undefined
      if (!value) return unsupported()
      const field = lw[1] === 'trap' ? 'severity' : 'facility'
      claim(`logging ${field}`, node)
      // IOS sets one trap level and one facility for every host: the model keeps them per host.
      deferred.push(() => {
        if (owners.get(`logging ${field}`) !== node) return
        const servers = loggingServers()
        set(node, servers.length ? mapped(servers.map((s) => model.set(['system', 'logging', 'remoteServers', s, field], value))) : unsupported(`no syslog host to apply it to`))
      })
      return mapped([])
    }
    let i: number
    if (lw[1] === 'host' && w[2] && (isIpv4(w[2]) || isIpv6(w[2]) || (HOST.test(w[2]) && !['ipv4', 'ipv6', 'vrf', 'transport'].includes(lw[2])))) i = 2
    else if (w[1] && isIpv4(w[1]) && w.length === 2) i = 1
    else return unsupported()
    const address = isIpv6(w[i]) ? w[i].toLowerCase() : w[i]
    i++
    const server: Obj = {}
    if (lw[i] === 'vrf' && w[i + 1]) {
      const vrf = vrfName(w[i + 1])
      if (vrf !== undefined) server.networkInstance = vrf
      i += 2
    }
    if (lw[i] === 'transport' && lw[i + 1] === 'udp') {
      i += 2
      if (lw[i] === 'port' && INTEGER.test(w[i + 1] ?? '')) {
        server.port = Number(w[i + 1])
        i += 2
      }
    }
    if (i < w.length) return unsupported(`"${w.slice(i).join(' ')}" isn't converted yet`)
    const at = ['system', 'logging', 'remoteServers', address]
    claim(fieldPath(...at), node, () => model.remove(at))
    if (!Object.keys(server).length) return mapped([model.set(at, {})])
    return mapped(Object.entries(server).map(([k, v]) => model.set([...at, k], v)))
  }

  /**
   * Every statement about each SNMP community, by name (a Map: names are any string), and the first one not converted:
   * it may limit or change the community (an access list, a view), so the community is then left out whole.
   */
  const communities = new Map<string, { nodes: IosNode[]; unconverted?: IosNode }>()

  // Community names are secrets: no reason here repeats a word of the statement.
  const mapSnmp = (node: IosNode): StatementDisposition => {
    const w = node.words
    const lw = w.map((x) => x.toLowerCase())
    if ((lw[1] === 'location' || lw[1] === 'contact') && w.length > 2) {
      claim(`snmp ${lw[1]}`, node)
      return mapped([model.set(['system', 'snmp', lw[1]], node.text.replace(/^\S+\s+\S+\s+/, ''))])
    }
    if (lw[1] !== 'community' || w.length < 3) return unsupported()
    const name = unquote(w[2])
    const state = communities.get(name) ?? { nodes: [] }
    communities.set(name, state)
    state.nodes.push(node)
    if (w.length === 3 || (w.length === 4 && (lw[3] === 'ro' || lw[3] === 'rw'))) {
      const at = ['system', 'snmp', 'communities', name]
      claim(fieldPath(...at), node, () => model.remove(at))
      return mapped([w.length === 4 ? model.set([...at, 'access'], lw[3] === 'ro' ? 'read-only' : 'read-write') : model.set(at, {})])
    }
    state.unconverted ??= node
    return unsupported('a view or an access list on the community')
  }

  /** `no snmp-server community X`: removes the community, and every statement about it before (its access list too). */
  const removeCommunity = (node: IosNode): StatementDisposition => {
    const name = unquote(node.words[3])
    const at = ['system', 'snmp', 'communities', name]
    const state = communities.get(name)
    if (!state) return ignored('no such community: nothing to convert')
    communities.delete(name)
    owners.delete(fieldPath(...at))
    model.remove(at)
    for (const up of [['system', 'snmp', 'communities'], ['system', 'snmp'], ['system']]) model.removeIfEmpty(up)
    for (const n of state.nodes) set(n, ignored(`removed by line ${line(node)}`))
    return ignored(`removes the community configured on ${linesText(state.nodes.map(line))}: nothing to convert`)
  }

  // ---- the top level

  const mapTop = (node: IosNode): void => {
    if (node.kind === 'comment') return set(node, ignored('a comment'))
    const lines = node.span.endLine - node.span.startLine + 1
    if (node.kind === 'banner') return set(node, unsupported(`a ${BANNER_TYPES.has(node.words[1]?.toLowerCase()) ? node.words[1].toLowerCase() : 'motd'} banner, ${lines} line${lines === 1 ? '' : 's'}, kept verbatim`))
    if (node.kind === 'certificate-chain') return set(node, unsupported(`certificate chain ${node.words[4] ?? ''}, ${lines} lines, kept verbatim`))

    const w = node.words
    const lw = w.map((x) => x.toLowerCase())
    if (lw[0] === 'interface') return mapInterface(node)
    if (lw[0] === 'vrf' && lw[1] === 'definition') return mapVrfDefinition(node, false)
    if (lw[0] === 'ip' && lw[1] === 'vrf' && w.length === 3) return mapVrfDefinition(node, true)
    if (lw[0] === 'no' && lw[1] === 'vrf' && lw[2] === 'definition' && !node.children.length) return set(node, removeVrfDefinition(node))
    if (lw[0] === 'no' && lw[1] === 'ip' && lw[2] === 'vrf' && !node.children.length) return set(node, removeVrfDefinition(node))

    let d: StatementDisposition = unsupported()
    if (node.children.length) d = unsupported()
    else if (lw[0] === 'hostname' && w.length === 2) {
      claim('hostname', node)
      d = mapped([model.set(['system', 'hostname'], w[1])])
    } else if (lw[0] === 'ip' && ((lw[1] === 'domain' && lw[2] === 'name' && w.length === 4) || (lw[1] === 'domain-name' && w.length === 3))) {
      claim('domain name', node)
      d = mapped([model.set(['system', 'domainName'], w[w.length - 1])])
    } else if (lw[0] === 'ip' && lw[1] === 'name-server') d = mapNameServers(node)
    else if (lw[0] === 'no' && lw[1] === 'ip' && lw[2] === 'name-server') d = removeNameServers(node)
    else if (lw[0] === 'no' && (lw[1] === 'ip' || lw[1] === 'ipv6') && lw[2] === 'route') d = removeRoute(node, lw[1] === 'ipv6')
    else if (lw[0] === 'no' && lw[1] === 'snmp-server' && lw[2] === 'community' && w.length === 4) d = removeCommunity(node)
    else if (lw[0] === 'ip' && ((lw[1] === 'domain' && lw[2] === 'list') || lw[1] === 'domain-list')) d = mapDomainList(node)
    else if (lw[0] === 'ip' && lw[1] === 'route') d = mapRoute(node, false)
    else if (lw[0] === 'ipv6' && lw[1] === 'route') d = mapRoute(node, true)
    else if (lw[0] === 'ntp') d = mapNtp(node)
    else if (lw[0] === 'logging') d = mapLogging(node)
    else if (lw[0] === 'snmp-server') d = mapSnmp(node)
    else if (lw[0] === 'end' && w.length === 1) d = ignored('the end of the configuration')
    else if (lw[0] === 'version' && w.length === 2) d = ignored('the software version the configuration was written by')
    else if (node.text === 'Building configuration...' || /^Current configuration : \d+ bytes$/.test(node.text)) d = ignored('show running-config\'s header')
    set(node, d)
    for (const child of node.children) unsupportedTree(child)
  }

  /** A statement nothing maps, and everything inside it. */
  const unsupportedTree = (node: IosNode): void => {
    set(node, node.kind === 'comment' ? ignored('a comment') : unsupported())
    for (const child of node.children) unsupportedTree(child)
  }

  for (const node of nodes) mapTop(node)
  for (const run of deferred) run()

  // A community with a statement not converted anywhere in the text (an access list, a view) is left out whole: mapped
  // without it, it would answer clients, or allow access, the source doesn't.
  for (const [name, state] of communities) {
    if (!state.unconverted) continue
    model.remove(['system', 'snmp', 'communities', name])
    for (const up of [['system', 'snmp', 'communities'], ['system', 'snmp'], ['system']]) model.removeIfEmpty(up)
    for (const n of state.nodes) if (dispositions[n.id]?.kind === 'mapped') set(n, unsupported(`left out whole: line ${line(state.unconverted)} about the same community isn't converted, and may limit or change it`))
  }

  // A VRF's route targets: one set in the model, so every address family's (each with the VRF-wide ones) must agree as
  // sets (a family with none disagrees with one with some), and none may be left out.
  for (const [instance, state] of vrfs) {
    const own = [...state.families.values()].map((f) => f.targets)
    const all = [...state.common, ...own.flat()]
    if (!all.length || model.get(['networkInstances', instance]) === undefined) continue
    // IOS's inheritance: a family with route targets of its own uses only those; one with none uses the VRF-wide ones.
    const families = own.length ? own.map((targets) => (targets.length ? targets : state.common)) : [state.common]
    const inherited = !own.length || own.some((targets) => !targets.length)
    const directionsOf = (targets: RouteTarget[]) => new Set(targets.flatMap((t) => t.directions))
    // A family that overrides one direction but not the other: whether it keeps the VRF-wide targets of the other isn't
    // certain, so none are guessed.
    const partial = state.common.length > 0 && own.some((targets) => targets.length > 0 && [...directionsOf(state.common)].some((d) => !directionsOf(targets).has(d)))
    const lists = families.map((targets) => ({
      import: [...new Set(targets.filter((t) => t.directions.includes('import')).map((t) => t.value))],
      export: [...new Set(targets.filter((t) => t.directions.includes('export')).map((t) => t.value))]
    }))
    const sorted = (values: string[]) => JSON.stringify([...values].sort())
    const same = lists.every((l) => sorted(l.import) === sorted(lists[0].import) && sorted(l.export) === sorted(lists[0].export))
    // The first statement not converted in a scope still there: the VRF's, or a family's not removed.
    const blocker = [state.unconverted, ...[...state.families.values()].map((f) => f.unconverted)].filter((n) => n !== undefined).sort((a, b) => line(a) - line(b))[0]
    if (blocker || partial || !same) {
      const why = blocker
        ? `left out whole: line ${line(blocker)} about the VRF's route targets isn't converted`
        : partial
          ? 'an address family overrides the VRF-wide route targets in one direction only, and what it keeps of the other isn\'t certain'
          : 'route targets that differ between IPv4 and IPv6: the model holds one set for the VRF'
      for (const t of all) set(t.node, unsupported(why))
      continue
    }
    const at = ['networkInstances', instance, 'routeTargets']
    for (const direction of ['import', 'export'] as const) if (lists[0][direction].length) model.set([...at, direction], lists[0][direction])
    for (const t of own.flat()) set(t.node, mapped(t.directions.map((d) => fieldPath(...at, d))))
    for (const t of state.common) set(t.node, inherited ? mapped(t.directions.map((d) => fieldPath(...at, d))) : ignored('overridden by the address families\' own route targets'))
  }

  // A VRF only routes name (`ip route vrf V …` with no `vrf definition V` or `ip vrf V`): the model holds it with its
  // routes, and nothing else (no route distinguisher or targets, nothing invented). Only the parse can tell it had no
  // definition, so the warning is the parse's; a render writes a definition with the address families its routes need.
  // Value-free: a VRF can share its name with a secret, so the field says which.
  for (const [instance, statements] of routeStatements) {
    if (vrfs.get(instance)?.definitions.length || model.get(['networkInstances', instance]) === undefined) continue
    if (!statements.length) {
      // Its routes were all removed: nothing names it any more.
      model.remove(['networkInstances', instance])
      model.removeIfEmpty(['networkInstances'])
      continue
    }
    diagnostics.push({ severity: 'warning', category: 'semantic', code: 'iosxe.vrf-created', message: 'A VRF only routes name has no definition in the text: it is kept for its routes, with no route distinguisher or route targets, and a render writes a definition for it.', field: fieldPath('networkInstances', instance), statement: statements[0].node.id })
  }

  // A subinterface in a VRF the text doesn't define (with `vrf definition` or `ip vrf`: a route naming it isn't one)
  // would name a VRF the device doesn't have: its membership and its addresses, which would otherwise land in the
  // global table, are left out.
  for (const { ctx, vrf, node } of membership.values()) {
    if (!node || vrfs.get(vrf)?.definitions.length) continue
    model.remove([...subPath(ctx), 'networkInstance'])
    set(node, unsupported('names a VRF the configuration doesn\'t define'))
    clearAddresses(ctx, unsupported(`an address in the VRF of line ${line(node)}, which the configuration doesn't define`))
    if (!ctx.isSub) pruneMain(ctx)
  }

  for (const state of addressing.values()) {
    if (!state.secondaries.length) continue
    if (!state.primary) {
      // The model can mark an address primary but not secondary: without a primary, a secondary would come back as one.
      for (const s of state.secondaries) {
        model.remove([...subPath(state.ctx), 'ipv4', 'addresses', s.address])
        set(s.node, unsupported('a secondary address with no primary address: the model can\'t say an address is secondary'))
      }
      pruneIpv4(state.ctx)
      continue
    }
    // A primary address is marked only beside secondaries: alone, it is simply the address.
    const path = model.set([...subPath(state.ctx), 'ipv4', 'addresses', state.primary.address, 'primary'], true)
    const d = dispositions[state.primary.node.id]
    if (d.kind === 'mapped') dispositions[state.primary.node.id] = mapped([...d.fields, path])
  }

  return { tree: nodes, model: model.root as Device, dispositions, diagnostics }
}
