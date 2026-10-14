// IOS / IOS-XE text → the shared model, for the phase 1 areas: system (hostname, domain name), interfaces and
// subinterfaces with their addresses, static routes, NTP, logging and SNMP. Every statement of the tree gets a
// disposition: `mapped` when everything it says went into the model, `ignored-by-design` with why, or `unsupported`
// (its text kept in the tree). A statement is mapped only when every option on it is understood: one with an option
// the model can't hold (`ntp server 192.0.2.1 key 1`) is unsupported as a whole, never half-converted.
import { fieldPath, type Context, type Device, type Diagnostic, type ParseResult, type StatementDisposition, type SyslogSeverity } from '@dialect/core'
import { ipv4Prefix, ipv6Prefix, isIpv4, isIpv6, maskLength } from './addresses'
import { interfaceName, interfaceType, splitSubinterface } from './names'
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

/** Why `ip name-server` is unsupported: model 0.1 has nowhere to put it (proposed on card #19). */
export const NO_DNS_SERVERS = 'DNS name servers aren\'t in the shared model yet (model 0.1)'

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
  const subPath = (ctx: InterfaceContext) => ['interfaces', ctx.name, 'subinterfaces', ctx.sub]

  /** Drops what removing addresses left empty: the address map, the family, a main interface's subinterface 0. */
  const pruneIpv4 = (ctx: InterfaceContext) => {
    const sub = subPath(ctx)
    model.removeIfEmpty([...sub, 'ipv4', 'addresses'])
    model.removeIfEmpty([...sub, 'ipv4'])
    if (!ctx.isSub) {
      model.removeIfEmpty(sub)
      model.removeIfEmpty(['interfaces', ctx.name, 'subinterfaces'])
    }
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
      return mapped([model.set([...sub, 'ipv6', 'addresses', p.address, 'prefixLength'], p.length)])
    }
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

  /** `ip route …` / `ipv6 route …`: one next hop of a route. */
  const mapRoute = (node: IosNode, v6: boolean): StatementDisposition => {
    const w = node.words
    let i = 2
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
    if (!prefix) return unsupported()

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
      } else if (!ROUTE_KEYWORDS.has(lower) && hop.address === undefined && hop.interface === undefined && hop.drop === undefined && interfaceName(w, i)) {
        const n = interfaceName(w, i)!
        if (/^null0$/i.test(n.name)) hop.drop = 'discard'
        else hop.interface = n.name
        i += n.used
      } else return unsupported(`"${word}" isn't converted yet`)
    }
    if (hop.address === undefined && hop.interface === undefined && hop.drop === undefined) return unsupported('no next hop')

    const routeAt = ['networkInstances', instance, 'staticRoutes', prefix]
    const existing = model.get([...routeAt, 'description'])
    if (name !== undefined && existing !== undefined && existing !== name) return unsupported(`a second name for ${prefix}`)

    const fields: string[] = []
    if (instance !== 'default') fields.push(model.set(['networkInstances', instance, 'type'], 'vrf'))
    if (name !== undefined) fields.push(model.set([...routeAt, 'description'], name))
    const hops = model.object([...routeAt, 'nextHops'])
    const index = String(Object.keys(hops).length)
    for (const [k, v] of Object.entries(hop)) fields.push(model.set([...routeAt, 'nextHops', index, k], v))
    return mapped(fields)
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
      server.networkInstance = w[i + 1]
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
      server.networkInstance = w[i + 1]
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

  const mapSnmp = (node: IosNode): StatementDisposition => {
    const w = node.words
    const lw = w.map((x) => x.toLowerCase())
    if ((lw[1] === 'location' || lw[1] === 'contact') && w.length > 2) {
      claim(`snmp ${lw[1]}`, node)
      return mapped([model.set(['system', 'snmp', lw[1]], node.text.replace(/^\S+\s+\S+\s+/, ''))])
    }
    if (lw[1] === 'community' && (w.length === 3 || (w.length === 4 && (lw[3] === 'ro' || lw[3] === 'rw')))) {
      const at = ['system', 'snmp', 'communities', unquote(w[2])]
      claim(fieldPath(...at), node, () => model.remove(at))
      return mapped([w.length === 4 ? model.set([...at, 'access'], lw[3] === 'ro' ? 'read-only' : 'read-write') : model.set(at, {})])
    }
    if (lw[1] === 'community') return unsupported('a view or an access list on the community')
    return unsupported()
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

    let d: StatementDisposition = unsupported()
    if (node.children.length) d = unsupported()
    else if (lw[0] === 'hostname' && w.length === 2) {
      claim('hostname', node)
      d = mapped([model.set(['system', 'hostname'], w[1])])
    } else if (lw[0] === 'ip' && ((lw[1] === 'domain' && lw[2] === 'name' && w.length === 4) || (lw[1] === 'domain-name' && w.length === 3))) {
      claim('domain name', node)
      d = mapped([model.set(['system', 'domainName'], w[w.length - 1])])
    } else if (lw[0] === 'ip' && lw[1] === 'name-server') d = unsupported(NO_DNS_SERVERS)
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
