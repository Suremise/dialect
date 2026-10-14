// Junos text → the shared model, for the phase 1 areas: system (host name, domain name, DNS), interfaces with their
// units, families and addresses, static routes (routing instances' too), NTP, syslog and SNMP.
//
// The text is read into statements (statements.ts), groups and interface ranges are expanded (expand.ts), and each
// statement is mapped on its own, as a `set` command says it. A statement is `mapped` only when everything it says went
// into the model; one the model can't hold (`ntp server 192.0.2.1 key 1`, `family ethernet-switching`) is
// `unsupported`, never half-converted. A later single-valued setting supersedes an earlier one (`ignored-by-design`,
// "superseded by line N"), as loading the commands in order would. An SNMP community is converted whole or not at all:
// without one of its settings (a client list by name, `clients … restrict`), it could answer clients it shouldn't.
//
// Reasons and diagnostics never quote the configuration: a value can be a secret (an SNMP community, a key), so they
// name what a statement is and where.
import type { Context, Device, ParseResult, StatementDisposition, SyntaxNode, SyslogSeverity } from '@dialect/core'
import { addressKey, isIpv4, isIpv6, parsePrefix, prefixKey } from './addresses'
import { expand, type Expanded } from './expand'
import { ModelBuilder, type Segments } from './model'
import { interfaceType, NOT_INTERFACES } from './names'
import { readConfig, startsWith } from './statements'

type Mutable = { kind: 'mapped'; fields: string[] } | Exclude<StatementDisposition, { kind: 'mapped' }>

const mapped = (fields: string[]): Mutable => ({ kind: 'mapped', fields })
const ignored = (reason: string): Mutable => ({ kind: 'ignored-by-design', reason })
const unsupported = (reason?: string): Mutable => (reason ? { kind: 'unsupported', reason } : { kind: 'unsupported' })

/** The model's syslog severities by Junos's names; `any` is every severity, so down to debug. `none` has no match. */
export const SEVERITIES: Readonly<Record<string, SyslogSeverity>> = {
  emergency: 'emergency',
  alert: 'alert',
  critical: 'critical',
  error: 'error',
  warning: 'warning',
  notice: 'notice',
  info: 'informational',
  any: 'debug'
}

const INTEGER = /^\d+$/
const HOST = /^[A-Za-z0-9][\w.-]*$/
const isInteger = (s: string | undefined, max = 2 ** 32 - 1): s is string => s !== undefined && INTEGER.test(s) && Number(s) <= max
/** A next hop that isn't an address: an interface with its unit (`ge-0/0/0.0`), or one without (`st0`). */
const isInterfaceName = (s: string): boolean => /^[a-z][\w-]*\d[\w/:.-]*$/i.test(s) && !isIpv4(s) && !isIpv6(s)

/** What top-level areas this mapper doesn't convert are, when that's worth saying. */
const LATER: Readonly<Record<string, string>> = {
  security: 'SRX security (zones, policies, NAT) comes later',
  applications: 'SRX applications come later, with security policies',
  protocols: 'routing protocols come later',
  'policy-options': 'routing policy comes later',
  firewall: 'firewall filters come later',
  vlans: 'VLANs come later',
  'class-of-service': 'class of service comes later'
}

/** Per static route: its next hops by what says them, and the route-wide settings that apply to every hop. */
interface RouteState {
  readonly at: Segments
  readonly hops: Map<string, string>
  /** Per hop index, the settings it has its own value for (a qualified next hop's preference). */
  readonly own: Map<string, Set<string>>
  /** Route-wide `preference`, `metric` and `tag`: the statement that set it last, and its value. */
  readonly level: Map<string, { readonly index: number; readonly value: number }>
}

/** Parses Junos `text`, hierarchical or set form, into the model, with a disposition for every statement. */
export function parse(text: string, _context: Context): ParseResult {
  const read = readConfig(text)
  const expansion = expand(read.statements)
  const statements = expansion.statements
  const model = new ModelBuilder()
  const results: Mutable[] = []

  /**
   * Fields a statement fills only because what it configures sits inside them (an interface's type, the unit it is
   * in): a statement left with only these, once its own setting is superseded, is superseded.
   */
  const incidental = new Set<string>()
  /** Which statement last set each single-valued setting: a later one supersedes it, as on the device. */
  const owners = new Map<string, number>()
  const claim = (key: string, index: number) => {
    const previous = owners.get(key)
    owners.set(key, index)
    if (previous === undefined || previous === index) return
    const result = results[previous]
    if (result?.kind !== 'mapped') return
    result.fields = result.fields.filter((f) => f !== key)
    if (result.fields.every((f) => incidental.has(f))) results[previous] = ignored(`superseded by line ${statements[index].line}`)
  }
  /** Sets a single-valued leaf for statement `index`, superseding whatever set it before. */
  const put = (index: number, segments: Segments, value: unknown): string => {
    const path = model.set(segments, value)
    claim(path, index)
    return path
  }

  // ---- system

  const mapSystem = (w: readonly string[], i: number): Mutable => {
    const [, k, ...r] = w
    if (k === 'host-name' && r.length === 1) return mapped([put(i, ['system', 'hostname'], r[0])])
    if (k === 'domain-name' && r.length === 1) return mapped([put(i, ['system', 'domainName'], r[0])])
    if (k === 'domain-search' && r.length === 1) {
      const search = (model.get(['system', 'dns', 'search']) as string[] | undefined) ?? []
      if (search.includes(r[0])) return ignored('already in the search list')
      return mapped([model.set(['system', 'dns', 'search'], [...search, r[0]])])
    }
    if (k === 'name-server' && r.length >= 1) {
      if (!isIpv4(r[0]) && !isIpv6(r[0])) return unsupported('a name server that is not an address')
      const at = ['system', 'dns', 'servers', addressKey(r[0])]
      if (r.length === 1) return mapped([model.ensure(at)])
      if (r.length === 3 && r[1] === 'routing-instance') return mapped([put(i, [...at, 'networkInstance'], r[2])])
      return unsupported()
    }
    if (k === 'ntp') return mapNtp(r, i)
    if (k === 'syslog') return mapSyslog(r, i)
    return unsupported()
  }

  const mapNtp = (r: readonly string[], i: number): Mutable => {
    if (r[0] !== 'server' || r.length < 2 || !(isIpv4(r[1]) || isIpv6(r[1]) || HOST.test(r[1]))) return unsupported()
    const at = ['system', 'ntp', 'servers', addressKey(r[1])]
    const options: [string, unknown][] = []
    for (let k = 2; k < r.length; k++) {
      if (r[k] === 'prefer') options.push(['prefer', true])
      else if (r[k] === 'version' && /^[1-4]$/.test(r[k + 1] ?? '')) options.push(['version', Number(r[++k])])
      else if (r[k] === 'routing-instance' && r[k + 1] !== undefined) options.push(['networkInstance', r[++k]])
      else return unsupported(r[k] === 'key' ? "NTP authentication isn't converted yet" : undefined)
    }
    if (!options.length) return mapped([model.ensure(at)])
    return mapped(options.map(([field, value]) => put(i, [...at, field], value)))
  }

  const mapSyslog = (r: readonly string[], i: number): Mutable => {
    if (r[0] !== 'host' || r.length < 2 || !(isIpv4(r[1]) || isIpv6(r[1]) || HOST.test(r[1]))) return unsupported()
    const at = ['system', 'logging', 'remoteServers', addressKey(r[1])]
    const [k, v, ...extra] = r.slice(2)
    if (k === undefined) return mapped([model.ensure(at)])
    if (extra.length || v === undefined) return unsupported()
    if (k === 'any') return Object.hasOwn(SEVERITIES, v) ? mapped([put(i, [...at, 'severity'], SEVERITIES[v])]) : unsupported()
    if (k === 'port' && isInteger(v, 65535)) return mapped([put(i, [...at, 'port'], Number(v))])
    if (k === 'routing-instance') return mapped([put(i, [...at, 'networkInstance'], v)])
    if (k === 'facility-override') return mapped([put(i, [...at, 'facility'], v)])
    if (k === 'transport' && v === 'udp') return ignored('UDP, the default transport')
    if (Object.hasOwn(SEVERITIES, v) || v === 'none') return unsupported("a severity for one facility: the model has one severity for every facility")
    return unsupported()
  }

  // ---- interfaces

  const ensureInterface = (name: string): string[] => {
    const at = ['interfaces', name]
    model.object(at)
    const type = interfaceType(name)
    const path = type ? model.set([...at, 'type'], type) : model.ensure(at)
    incidental.add(path)
    return [path]
  }
  /** The object a statement's setting goes in, made sure of; its path is incidental to that statement. */
  const container = (segments: Segments): string => {
    const path = model.ensure(segments)
    incidental.add(path)
    return path
  }

  const mapInterface = (w: readonly string[], i: number): Mutable => {
    const name = w[1]
    if (name === undefined || NOT_INTERFACES.has(name)) return unsupported()
    const iface = ['interfaces', name]
    const r = w.slice(2)
    const withIface = (fields: string[]) => mapped([...ensureInterface(name), ...fields])
    if (!r.length) return withIface([])
    if (r[0] === 'description' && r.length === 2) return withIface([put(i, [...iface, 'description'], r[1])])
    if (r[0] === 'disable' && r.length === 1) return withIface([put(i, [...iface, 'enabled'], false)])
    if (r[0] === 'mtu' && r.length === 2 && isInteger(r[1], 65535)) return withIface([put(i, [...iface, 'mtu'], Number(r[1]))])
    if (r[0] === 'vlan-tagging' && r.length === 1) return withIface([put(i, [...iface, 'vlanTagging'], true)])
    if (r[0] !== 'unit' || !isInteger(r[1])) return unsupported()

    const sub = [...iface, 'subinterfaces', String(Number(r[1]))]
    const u = r.slice(2)
    const withSub = (fields: string[]) => mapped([...ensureInterface(name), container(sub), ...fields])
    if (!u.length) return withSub([])
    if (u[0] === 'description' && u.length === 2) return withSub([put(i, [...sub, 'description'], u[1])])
    if (u[0] === 'disable' && u.length === 1) return withSub([put(i, [...sub, 'enabled'], false)])
    if (u[0] === 'vlan-id' && u.length === 2 && isInteger(u[1], 4094)) return withSub([put(i, [...sub, 'vlanId'], Number(u[1]))])
    if (u[0] !== 'family' || (u[1] !== 'inet' && u[1] !== 'inet6')) return unsupported(u[0] === 'family' && u[1] === 'ethernet-switching' ? 'switching (family ethernet-switching) comes later, with VLANs' : undefined)

    const v6 = u[1] === 'inet6'
    const family = [...sub, v6 ? 'ipv6' : 'ipv4']
    const f = u.slice(2)
    if (!f.length) return withSub([model.ensure(family)])
    if (f[0] === 'mtu' && f.length === 2 && isInteger(f[1], 65535)) return withSub([put(i, [...family, 'mtu'], Number(f[1]))])
    if (f[0] === 'address' && f.length >= 2) {
      const p = parsePrefix(f[1])
      if (!p || p.v6 !== v6) return unsupported('not an address with a prefix length for this family')
      if (f.length > 3 || (f.length === 3 && f[2] !== 'primary')) return unsupported()
      const at = [...family, 'addresses', p.address]
      const fields = [put(i, [...at, 'prefixLength'], p.length)]
      if (f.length === 3) fields.push(put(i, [...at, 'primary'], true))
      return withSub(fields)
    }
    return unsupported()
  }

  // ---- static routes

  const routes = new Map<string, RouteState>()

  const mapRoutingOptions = (instance: string, r: readonly string[], i: number): Mutable => {
    if (r[0] === 'static' && r[1] === 'route' && r.length >= 3) return mapRoute(instance, r[2], r.slice(3), i, null)
    const prefix = instance === 'default' ? '' : `${instance}.`
    if (r[0] === 'rib' && r[2] === 'static' && r[3] === 'route' && r.length >= 5) {
      if (r[1] === `${prefix}inet.0`) return mapRoute(instance, r[4], r.slice(5), i, false)
      if (r[1] === `${prefix}inet6.0`) return mapRoute(instance, r[4], r.slice(5), i, true)
    }
    return unsupported()
  }

  /** One statement about a static route: a next hop, or a setting of the route's or of one of its hops. */
  const mapRoute = (instance: string, destination: string, o: readonly string[], i: number, v6: boolean | null): Mutable => {
    const p = parsePrefix(destination)
    // IPv6 routes go in rib inet6.0; a static route outside a rib is IPv4.
    if (!p || p.v6 !== (v6 ?? false)) return unsupported('not a destination prefix with its length, of the table\'s family')
    const at = ['networkInstances', instance, 'staticRoutes', prefixKey(p)]
    const routeKey = `${instance}\u0000${prefixKey(p)}`
    const state = routes.get(routeKey) ?? { at, hops: new Map(), own: new Map(), level: new Map() }
    routes.set(routeKey, state)

    const isAddress = (s: string) => (p.v6 ? isIpv6(s) : isIpv4(s))
    /** The hop `id` names, created if new: its index and whether it was. */
    const hop = (id: string): [string, boolean] => {
      const existing = state.hops.get(id)
      if (existing !== undefined) return [existing, false]
      const index = String(state.hops.size)
      state.hops.set(id, index)
      return [index, true]
    }
    const hopAt = (index: string) => [...at, 'nextHops', index]

    if (o.length === 2 && o[0] === 'next-hop') {
      if (!isAddress(o[1]) && !isInterfaceName(o[1])) return unsupported()
      const [index, created] = hop(`next-hop ${o[1]}`)
      if (!created) return ignored('already a next hop of the route')
      return mapped([model.set([...hopAt(index), isAddress(o[1]) ? 'address' : 'interface'], isAddress(o[1]) ? addressKey(o[1]) : o[1])])
    }
    if (o.length === 1 && (o[0] === 'discard' || o[0] === 'reject')) {
      const [index] = hop('drop')
      return mapped([put(i, [...hopAt(index), 'drop'], o[0])])
    }
    if (o[0] === 'qualified-next-hop' && o.length >= 2) {
      const target = o[1]
      if (!isAddress(target) && !isInterfaceName(target)) return unsupported()
      const q = o.slice(2)
      const setting = q[0]
      const valid = !q.length || (q.length === 2 && ((['preference', 'metric', 'tag'].includes(setting) && isInteger(q[1])) || (setting === 'interface' && isAddress(target) && isInterfaceName(q[1]))))
      if (!valid) return unsupported()
      const [index, created] = hop(`qualified-next-hop ${target}`)
      const fields = created ? [model.set([...hopAt(index), isAddress(target) ? 'address' : 'interface'], isAddress(target) ? addressKey(target) : target)] : []
      if (!q.length) return created ? mapped(fields) : ignored('already a next hop of the route')
      const own = state.own.get(index) ?? new Set()
      state.own.set(index, own)
      if (setting !== 'interface') own.add(setting)
      fields.push(put(i, [...hopAt(index), setting], setting === 'interface' ? q[1] : Number(q[1])))
      return mapped(fields)
    }
    if (o.length === 2 && ['preference', 'metric', 'tag'].includes(o[0]) && isInteger(o[1])) {
      // Applied to every hop without its own value once all the route's statements are read: a placeholder until then.
      claim(`${routeKey}\u0000${o[0]}`, i)
      state.level.set(o[0], { index: i, value: Number(o[1]) })
      return mapped([])
    }
    return unsupported()
  }

  // ---- routing instances

  const mapInstance = (w: readonly string[], i: number): Mutable => {
    const name = w[1]
    if (name === undefined || name === 'default' || name === 'master') return unsupported()
    const r = w.slice(2)
    const at = ['networkInstances', name]
    if (!r.length) return mapped([model.ensure(at)])
    if (r[0] === 'instance-type' && r.length === 2) return r[1] === 'vrf' ? mapped([put(i, [...at, 'type'], 'vrf')]) : unsupported('routing instances other than VRFs come later')
    if (r[0] === 'routing-options') return mapRoutingOptions(name, r.slice(1), i)
    return unsupported()
  }

  // ---- SNMP

  /** Communities with a setting this mapper can't convert: none of them is converted. */
  const tainted = new Set<string>()

  const mapSnmp = (w: readonly string[], i: number): Mutable => {
    const r = w.slice(1)
    if ((r[0] === 'location' || r[0] === 'contact') && r.length === 2) return mapped([put(i, ['system', 'snmp', r[0]], r[1])])
    if (r[0] !== 'community' || r[1] === undefined) return unsupported()
    const at = ['system', 'snmp', 'communities', r[1]]
    const c = r.slice(2)
    if (!c.length) return mapped([model.ensure(at)])
    if (c[0] === 'authorization' && c.length === 2 && (c[1] === 'read-only' || c[1] === 'read-write')) return mapped([put(i, [...at, 'access'], c[1])])
    if (c[0] === 'clients' && c.length === 2 && (parsePrefix(c[1]) || isIpv4(c[1]) || isIpv6(c[1]))) {
      const clients = (model.get([...at, 'clients']) as string[] | undefined) ?? []
      const client = parsePrefix(c[1]) ? prefixKey(parsePrefix(c[1])!) : addressKey(c[1])
      if (clients.includes(client)) return ignored('already a client of the community')
      return mapped([model.set([...at, 'clients'], [...clients, client])])
    }
    tainted.add(r[1])
    return unsupported(c[0] === 'clients' ? "a client restriction this converter can't carry over" : 'a community setting this converter can\'t carry over yet')
  }

  // ---- every statement

  const mapStatement = (s: Expanded, i: number): Mutable => {
    const w = s.words
    switch (w[0]) {
      case 'version':
        return w.length === 2 ? ignored('the software version the configuration was written by') : unsupported()
      case 'system':
        return mapSystem(w, i)
      case 'interfaces':
        return mapInterface(w, i)
      case 'routing-options':
        return mapRoutingOptions('default', w.slice(1), i)
      case 'routing-instances':
        return mapInstance(w, i)
      case 'snmp':
        return mapSnmp(w, i)
      default:
        return unsupported(Object.hasOwn(LATER, w[0]) ? LATER[w[0]] : undefined)
    }
  }

  statements.forEach((s, i) => {
    results[i] = mapStatement(s, i)
  })

  // Route-wide settings, now every hop of each route is known.
  for (const state of routes.values()) {
    // `level` holds each setting's last statement: earlier ones were superseded by it.
    for (const [setting, { index, value }] of state.level) {
      const hops = [...state.hops.values()].filter((h) => !state.own.get(h)?.has(setting))
      if (!state.hops.size) results[index] = unsupported('a setting of a route with no next hop')
      else if (!hops.length) results[index] = ignored(`every next hop of the route has its own ${setting}`)
      else results[index] = mapped(hops.map((h) => model.set([...state.at, 'nextHops', h, setting], value)))
    }
  }

  // A community with a setting that can't be converted isn't converted at all.
  for (const name of tainted) {
    model.remove(['system', 'snmp', 'communities', name])
    model.removeIfEmpty(['system', 'snmp', 'communities'])
    model.removeIfEmpty(['system', 'snmp'])
    model.removeIfEmpty(['system'])
    statements.forEach((s, i) => {
      if (startsWith(s.words, ['snmp', 'community', name]) && results[i].kind !== 'unsupported') {
        results[i] = unsupported("the community has a setting that isn't converted, so none of it is: without that setting it could answer clients it shouldn't")
      }
    })
  }

  return { tree: read.tree, model: model.root as Device, dispositions: settle(read.tree, read.dispositions, expansion, statements, results), diagnostics: read.diagnostics }
}

/**
 * Every syntax node's disposition: what reading the text settled (inactive, deleted), then what expansion did (groups
 * and ranges defined and applied), then what the node's statements mapped to, all together. A node stands for several
 * statements when it has a `[ … ]` list or is a group or range statement applied in several places: one of them
 * unsupported makes the node unsupported, so it can't hide behind the others; else mapped when any is. A container
 * with no statement of its own takes its contents': it groups mapped statements, or holds only unsupported or ignored
 * ones.
 */
function settle(tree: readonly SyntaxNode[], read: Readonly<Record<string, StatementDisposition>>, expansion: ReturnType<typeof expand>, statements: readonly Expanded[], results: readonly Mutable[]): Record<string, StatementDisposition> {
  const byNode = new Map<string, StatementDisposition[]>()
  statements.forEach((s, i) => {
    const list = byNode.get(s.node) ?? []
    list.push(results[i])
    byNode.set(s.node, list)
  })
  const out: Record<string, StatementDisposition> = {}
  const combine = (list: readonly StatementDisposition[], container: boolean): StatementDisposition => {
    const maps = list.filter((d) => d.kind === 'mapped')
    const unconverted = list.find((d) => d.kind === 'unsupported')
    if (container) return maps.length ? mapped([]) : (unconverted ?? ignored('holds only statements ignored by design'))
    if (unconverted) {
      if (!maps.length) return unconverted
      const why = unconverted.reason ? `: ${unconverted.reason}` : ''
      return unsupported(`only partly converted: some of its values or the places it applies aren't${why}`)
    }
    return maps.length ? mapped([...new Set(maps.flatMap((d) => d.fields))]) : list[0]
  }
  const visit = (node: SyntaxNode): StatementDisposition => {
    const kids = (node.children ?? []).map(visit)
    const own = Object.hasOwn(read, node.id) ? read[node.id] : Object.hasOwn(expansion.dispositions, node.id) ? expansion.dispositions[node.id] : undefined
    const list = byNode.get(node.id)
    const d = own ?? (list ? combine(list, false) : Object.hasOwn(expansion.unused, node.id) ? expansion.unused[node.id] : kids.length ? combine(kids, true) : unsupported())
    out[node.id] = d
    return d
  }
  tree.forEach(visit)
  return out
}
