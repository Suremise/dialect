// Junos text → the shared model, for the phase 1 areas: system (host name, domain name, DNS), interfaces with their
// units, families and addresses, static routes, routing instances (VRFs and virtual routers: their units, route
// distinguisher and vrf-target), NTP, syslog and SNMP, from model 0.4 VLANs, ELS switch ports, IRB units, OSPF and BGP,
// and from model 0.5 routing policy (policy.ts), which BGP's import and export policies name.
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
import { fieldPath, type Context, type Device, type Diagnostic, type ParseResult, type StatementDisposition, type SyntaxNode, type SyslogSeverity } from '@dialect/core'
import { addressKey, isIpv4, isIpv6, parsePrefix, prefixKey } from './addresses'
import { fromJunos, targetFromJunos } from './communities'
import { expand, type Expanded } from './expand'
import { isObject, ModelBuilder, type Obj, type Segments } from './model'
import { interfaceType, NOT_INTERFACES } from './names'
import { ignored, mapped, unsupported, type Mutable } from './dispositions'
import { filterMapper } from './filters'
import { policyMapper } from './policy'
import { readConfig, startsWith } from './statements'
import { secretValues, unconvertedReason } from './unconverted'

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
  /**
   * Which statement owns each single-valued setting: the one that outranks the others (expand.ts's `outranks`: the
   * configuration over groups, a group's earlier sibling over a later one), the later of equal ones, as loading the
   * commands in order would. A statement it supersedes keeps only its other fields.
   */
  const owners = new Map<string, number>()
  /** Statements that lost a setting to a higher-ranked one before they were mapped: the winner's line. */
  const lost = new Map<number, number>()
  /** Takes `key` for statement `index`; false when a statement of higher rank already has it. */
  const claim = (key: string, index: number): boolean => {
    const previous = owners.get(key)
    if (previous !== undefined && previous !== index && expansion.outranks(statements[previous], statements[index])) {
      lost.set(index, statements[previous].line)
      return false
    }
    owners.set(key, index)
    if (previous === undefined || previous === index) return true
    const result = results[previous]
    if (result?.kind !== 'mapped') return true
    result.fields = result.fields.filter((f) => f !== key)
    if (result.fields.every((f) => incidental.has(f))) results[previous] = ignored(`superseded by line ${statements[index].line}`)
    return true
  }
  /** Sets a single-valued leaf for statement `index` unless a higher-ranked statement has it: its path, or null. */
  const policy = policyMapper({ statements, results, model, claim, reshaped: read.reshaped ?? [] })
  // A unit a filter attachment names is made sure of when the attachment settles (ensureInterface and container are below).
  const ensureUnit = (name: string, unit: string): string[] => [...ensureInterface(name), container(['interfaces', name, 'subinterfaces', unit])]
  const filter = filterMapper({ statements, results, model, claim, reshaped: read.reshaped ?? [], ensureUnit })
  const put = (index: number, segments: Segments, value: unknown): string | null => {
    const path = fieldPath(...segments)
    if (!claim(path, index)) return null
    model.set(segments, value)
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
    const withIface = (fields: (string | null)[]) => mapped([...ensureInterface(name), ...fields])
    if (!r.length) return withIface([])
    if (r[0] === 'description' && r.length === 2) return withIface([put(i, [...iface, 'description'], r[1])])
    if (r[0] === 'disable' && r.length === 1) return withIface([put(i, [...iface, 'enabled'], false)])
    if (r[0] === 'mtu' && r.length === 2 && isInteger(r[1], 65535)) return withIface([put(i, [...iface, 'mtu'], Number(r[1]))])
    if (r[0] === 'vlan-tagging' && r.length === 1) return withIface([put(i, [...iface, 'vlanTagging'], true)])
    if (r[0] === 'native-vlan-id' && r.length === 2) return mapNative(name, r[1], i)
    if ((r[0] === 'gigether-options' || r[0] === 'ether-options') && r[1] === '802.3ad') return mapLagMember(name, r.slice(2), i)
    if (r[0] === 'aggregated-ether-options') return mapAggregation(name, r.slice(1), i)
    if (r[0] !== 'unit' || !isInteger(r[1])) return unsupported()

    const sub = [...iface, 'subinterfaces', String(Number(r[1]))]
    const u = r.slice(2)
    const withSub = (fields: (string | null)[]) => mapped([...ensureInterface(name), container(sub), ...fields])
    if (!u.length) return withSub([])
    if (u[0] === 'description' && u.length === 2) return withSub([put(i, [...sub, 'description'], u[1])])
    if (u[0] === 'disable' && u.length === 1) return withSub([put(i, [...sub, 'enabled'], false)])
    if (u[0] === 'vlan-id' && u.length === 2 && isInteger(u[1], 4094)) return withSub([put(i, [...sub, 'vlanId'], Number(u[1]))])
    if (u[0] === 'family' && u[1] === 'ethernet-switching') return mapSwitching(name, Number(r[1]), u.slice(2), i)
    if (u[0] !== 'family' || (u[1] !== 'inet' && u[1] !== 'inet6')) return unsupported()

    const v6 = u[1] === 'inet6'
    const family = [...sub, v6 ? 'ipv6' : 'ipv4']
    const f = u.slice(2)
    if (f[0] === 'filter') return filter.mapAttachment(name, String(Number(r[1])), v6 ? 'ipv6' : 'ipv4', f.slice(1), i)
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

  // ---- LAGs (model 0.5.4)

  /**
   * `gigether-options 802.3ad aeN` (MX) or `ether-options 802.3ad aeN` (EX, QFX): the interface is a member link of
   * aggregate `aeN`. Either form sets the one membership. The aggregate is made sure of once memberships are settled
   * (settleAggregates), so one only a superseded statement named isn't made up.
   */
  const mapLagMember = (name: string, o: readonly string[], i: number): Mutable => {
    if (o[0] === 'lacp') return unsupported("a member link's own LACP settings (port priority, force-up): the model has the aggregate's mode")
    if (o[0] === 'primary' || o[0] === 'backup') return unsupported('a primary or backup member link: the model has no such role')
    if (o.length !== 1) return unsupported('an 802.3ad setting the model has no place for')
    if (!/^ae\d+$/.test(o[0])) return unsupported('not an aggregate (aeN) to be a member link of')
    if (interfaceType(name) === 'aggregate') return unsupported('an aggregate as a member link of another, which Junos refuses')
    return mapped([...ensureInterface(name), put(i, ['interfaces', name, 'aggregate'], o[0])])
  }

  /** Each aggregate a member link names in the end, made sure of: its type is mapped by the member's statement. */
  const settleAggregates = () => {
    const interfaces = model.get(['interfaces'])
    if (!isObject(interfaces)) return
    for (const [name, iface] of Object.entries(interfaces)) {
      if (!isObject(iface) || typeof iface.aggregate !== 'string') continue
      const index = owners.get(fieldPath('interfaces', name, 'aggregate'))
      const fields = ensureInterface(iface.aggregate)
      const result = index === undefined ? undefined : results[index]
      if (result?.kind === 'mapped') result.fields = [...new Set([...result.fields, ...fields])]
    }
  }

  /** `aggregated-ether-options` on an aggregate: its LACP mode (`lacp active|passive`) and `minimum-links N`. */
  const mapAggregation = (name: string, o: readonly string[], i: number): Mutable => {
    if (interfaceType(name) !== 'aggregate' || !/^ae\d+$/.test(name)) return unsupported("aggregate settings on an interface that isn't an aggregate (aeN)")
    const at = ['interfaces', name, 'aggregation']
    const withAggregate = (fields: (string | null)[]) => mapped([...ensureInterface(name), container(at), ...fields])
    if (o[0] === 'lacp' && o.length === 2 && (o[1] === 'active' || o[1] === 'passive')) return withAggregate([put(i, [...at, 'lacp'], o[1])])
    if (o[0] === 'lacp') return unsupported('LACP settings other than active and passive (periodic, system ID, admin key…): the model has the mode only')
    if (o[0] === 'minimum-links' && o.length === 2 && isInteger(o[1], 64) && Number(o[1]) >= 1) return withAggregate([put(i, [...at, 'minLinks'], Number(o[1]))])
    if (o[0] === 'minimum-links') return unsupported('not a number of links from 1 to 64')
    return unsupported(o[0] === 'link-speed' ? "an aggregate's link speed: the model has none" : 'an aggregate setting the model has no place for')
  }

  // ---- static routes

  const routes = new Map<string, RouteState>()

  const mapRoutingOptions = (instance: string, r: readonly string[], i: number): Mutable => {
    if (r[0] === 'static' && r[1] === 'route' && r.length >= 3) return mapRoute(instance, r[2], r.slice(3), i, null)
    if (r[0] === 'router-id' && r.length === 2) return isIpv4(r[1]) ? later(routerIds, instance, r[1], i) : unsupported('not a router ID (an IPv4 address)')
    if (r[0] === 'autonomous-system' && r.length === 2) return asNumber(r[1]) !== null ? later(asNumbers, instance, asNumber(r[1])!, i) : unsupported('not an AS number from 1 to 4294967295, in plain form')
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
      const fields: (string | null)[] = created ? [model.set([...hopAt(index), isAddress(target) ? 'address' : 'interface'], isAddress(target) ? addressKey(target) : target)] : []
      if (!q.length) return created ? mapped(fields) : ignored('already a next hop of the route')
      const own = state.own.get(index) ?? new Set()
      state.own.set(index, own)
      if (setting !== 'interface') own.add(setting)
      fields.push(put(i, [...hopAt(index), setting], setting === 'interface' ? q[1] : Number(q[1])))
      return mapped(fields)
    }
    if (o.length === 2 && ['preference', 'metric', 'tag'].includes(o[0]) && isInteger(o[1])) {
      // Applied to every hop without its own value once all the route's statements are read: a placeholder until then.
      if (claim(`${routeKey}\u0000${o[0]}`, i)) state.level.set(o[0], { index: i, value: Number(o[1]) })
      return mapped([])
    }
    return unsupported()
  }

  // ---- routing instances

  /**
   * Each unit in a routing instance, by its subinterface's field path: the instance, and every statement that put it in
   * one. A unit named in two instances is in neither (Junos doesn't commit that): an error, not a guess at which.
   */
  const members = new Map<string, { readonly sub: Segments; readonly instance: string; readonly statements: number[]; twice: boolean }>()
  /**
   * `instance-type` statements of a type this mapper doesn't convert (`mac-vrf`, `evpn`, `forwarding`…), by statement:
   * their instance. One that is the instance's type in the end (it outranks every other instance-type, as a single
   * setting does) means none of the instance's statements is converted, as its route distinguisher, targets and units
   * mean something else there than in a VRF. One a higher-ranked type overrides is superseded like any setting.
   */
  const otherTypeAt = new Map<number, string>()
  const otherTypes = new Set<string>()
  /** Per instance and side (`R\u0000importPolicies`), its `vrf-import` or `vrf-export` policies in order, with their statements. */
  const vrfPolicies = new Map<string, { readonly index: number; readonly name: string }[]>()
  /** Per instance, its `vrf-target`, `vrf-target import` and `vrf-target export`: the statement that set each last, and its value. */
  const targets = new Map<string, Map<'both' | 'import' | 'export', { readonly index: number; readonly value: string }>>()

  const mapMember = (instance: string, ref: string, i: number): Mutable => {
    const m = /^(.+)\.(\d+)$/.exec(ref)
    if (!m || NOT_INTERFACES.has(m[1]) || !/^[a-z][\w/:-]*$/i.test(m[1]) || !isInteger(m[2])) return unsupported('not an interface unit (ge-0/0/0.0): a routing instance takes units')
    const sub = ['interfaces', m[1], 'subinterfaces', String(Number(m[2]))]
    const key = fieldPath(...sub)
    const member = members.get(key)
    if (member) {
      member.statements.push(i)
      if (member.instance === instance) return ignored('already in the routing instance')
      member.twice = true
      return mapped([])
    }
    members.set(key, { sub, instance, statements: [i], twice: false })
    // The instance is there even if nothing else of it is converted: the unit names it.
    return mapped([...ensureInterface(m[1]), container(sub), container(['networkInstances', instance]), model.set([...sub, 'networkInstance'], instance)])
  }

  const mapTarget = (instance: string, t: readonly string[], i: number): Mutable => {
    const side = t.length === 1 ? 'both' : t.length === 2 && (t[0] === 'import' || t[0] === 'export') ? t[0] : null
    if (!side) return unsupported()
    const value = targetFromJunos(t[t.length - 1])
    if (!value) return unsupported(t[t.length - 1] === 'auto' ? "vrf-target auto (route targets from the AS number) isn't converted yet" : 'not a route target in a form the model has (target:ASN:nn or target:IP:nn)')
    const state = targets.get(instance) ?? new Map()
    targets.set(instance, state)
    // Settled once every statement is read (an import or export overrides the plain one): a placeholder until then.
    if (claim(`${instance}\u0000vrf-target\u0000${side}`, i)) state.set(side, { index: i, value })
    return mapped([])
  }

  const mapInstance = (w: readonly string[], i: number): Mutable => {
    const name = w[1]
    if (name === undefined || name === 'default' || name === 'master') return unsupported()
    const r = w.slice(2)
    const at = ['networkInstances', name]
    if (!r.length) return mapped([model.ensure(at)])
    if (r[0] === 'instance-type' && r.length === 2) {
      if (r[1] === 'vrf' || r[1] === 'virtual-router') return mapped([put(i, [...at, 'type'], r[1])])
      // It takes the type as any instance-type would, so the ranks decide which one the instance has: settled below.
      claim(fieldPath(...at, 'type'), i)
      otherTypeAt.set(i, name)
      return mapped([])
    }
    if (r[0] === 'interface' && r.length === 2) return mapMember(name, r[1], i)
    if (r[0] === 'route-distinguisher' && r.length === 2) {
      const rd = fromJunos(r[1])
      return rd ? mapped([put(i, [...at, 'routeDistinguisher'], rd)]) : unsupported('not a route distinguisher in a form the model has (ASN:nn, IP:nn or a 4-byte AS with L)')
    }
    if (r[0] === 'vrf-target') return mapTarget(name, r.slice(1), i)
    if ((r[0] === 'vrf-import' || r[0] === 'vrf-export') && r.length === 2) {
      // Resolved once the policies are settled, as BGP's are (settleProtocols).
      const field = r[0] === 'vrf-import' ? 'importPolicies' : 'exportPolicies'
      const list = vrfPolicies.get(`${name}\u0000${field}`) ?? []
      if (list.some((ref) => ref.name === r[1])) return ignored('already a policy of the routing instance')
      list.push({ index: i, name: r[1] })
      vrfPolicies.set(`${name}\u0000${field}`, list)
      return mapped([])
    }
    if (r[0] === 'routing-options') return mapRoutingOptions(name, r.slice(1), i)
    if (r[0] === 'protocols') return mapProtocols(name, r.slice(1), i)
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

  // ---- VLANs and switch ports (ELS)
  //
  // The model keys VLANs by ID, and Junos by name: a VLAN's statements and the ports that name it are settled once every
  // statement is read (each a placeholder until then), when each name has its ID.

  /** Per VLAN name: its statements, and the one that set each single setting last, with its value. */
  const vlanStates = new Map<string, { readonly statements: number[]; id?: { index: number; value: number }; description?: { index: number; value: string }; l3?: { index: number; value: string } }>()
  /** Per switch port (an interface's unit 0): its `vlan members` statements, and its `native-vlan-id`. */
  const ports = new Map<string, { readonly members: { readonly index: number; readonly value: string }[]; native?: { index: number; value: number } }>()
  const port = (name: string) => {
    const state = ports.get(name) ?? { members: [] }
    ports.set(name, state)
    return state
  }
  /**
   * Per VLAN name, its `vlan-id-list` statements. Junos takes a vlan-id or a vlan-id-list, one replacing the other, so
   * they settle as one setting (rank, then order): a VLAN whose list wins isn't converted (the model gives a VLAN one
   * ID), and a list a vlan-id wins over is superseded.
   */
  const lists = new Map<string, number[]>()
  /** Ports whose mode non-ELS `port-mode` sets: none of their switching is converted, as their mode can't be told. */
  const nonEls = new Set<string>()
  /** A VLAN ID as Junos writes one (`10`), or null when it isn't one from 1 to 4094. */
  const vlanId = (s: string | undefined): number | null => (isInteger(s, 4094) && Number(s) >= 1 ? Number(s) : null)

  const mapVlan = (w: readonly string[], i: number): Mutable => {
    const name = w[1]
    if (name === undefined) return unsupported()
    const r = w.slice(2)
    const state = vlanStates.get(name) ?? { statements: [] }
    vlanStates.set(name, state)
    const later = (key: 'id' | 'description' | 'l3', value: number | string): Mutable => {
      if (claim(`vlans\u0000${name}\u0000${key}`, i)) (state as Record<string, unknown>)[key] = { index: i, value }
      state.statements.push(i)
      return mapped([])
    }
    if (!r.length) {
      state.statements.push(i)
      return mapped([])
    }
    if (r[0] === 'vlan-id' && r.length === 2) {
      const id = vlanId(r[1])
      return id === null ? unsupported('not a VLAN ID from 1 to 4094') : later('id', id)
    }
    if (r[0] === 'description' && r.length === 2) return later('description', r[1])
    if (r[0] === 'l3-interface' && r.length === 2) return later('l3', r[1])
    if (r[0] === 'vlan-id-list') {
      lists.set(name, [...(lists.get(name) ?? []), i])
      state.statements.push(i)
      return mapped([])
    }
    if (r[0] === 'interface') return unsupported("a VLAN's ports named under the VLAN (non-ELS): ELS names them on the interface, which is converted")
    return unsupported()
  }

  /** `family ethernet-switching` on unit `unit` of interface `name`: an ELS switch port. */
  const mapSwitching = (name: string, unit: number, s: readonly string[], i: number): Mutable => {
    if (unit !== 0) return unsupported('switching on a unit other than 0: the model has one switch port per interface')
    const at = ['interfaces', name, 'switching']
    const withPort = (fields: (string | null)[]) => mapped([...ensureInterface(name), container(at), ...fields])
    if (!s.length) return withPort([])
    if (s[0] === 'interface-mode' && s.length === 2 && (s[1] === 'access' || s[1] === 'trunk')) return withPort([put(i, [...at, 'mode'], s[1])])
    if (s[0] === 'port-mode') {
      nonEls.add(name)
      return unsupported('non-ELS port-mode: this converter reads ELS switching (interface-mode)')
    }
    if (s[0] === 'native-vlan-id') return unsupported('a native VLAN under family ethernet-switching (non-ELS): ELS sets native-vlan-id on the interface')
    if (s[0] === 'vlan' && s[1] === 'members' && s.length === 3) {
      const m = s[2]
      // A member is a VLAN ID, a range of them, `all`, or a VLAN's name, which never starts with a digit.
      if (m !== 'all' && /^\d/.test(m)) {
        const range = /^(\d+)-(\d+)$/.exec(m)
        const valid = range ? vlanId(range[1]) !== null && vlanId(range[2]) !== null && Number(range[1]) < Number(range[2]) : vlanId(m) !== null
        if (!valid) return unsupported('not a VLAN ID from 1 to 4094, a range of them or a VLAN name')
      }
      port(name).members.push({ index: i, value: m })
      return withPort([])
    }
    return unsupported()
  }

  /** `native-vlan-id` on an interface (ELS): its trunk's untagged VLAN, by ID. */
  const mapNative = (name: string, value: string, i: number): Mutable => {
    const id = vlanId(value)
    if (id === null) return unsupported('not a VLAN ID from 1 to 4094')
    if (claim(fieldPath('interfaces', name, 'switching', 'nativeVlan'), i)) port(name).native = { index: i, value: id }
    return mapped([])
  }

  /** Statement `index`'s placeholder, now settled: a statement already superseded or unsupported keeps that. */
  const settleTo = (index: number, result: Mutable) => {
    if (results[index].kind === 'mapped') results[index] = result
  }
  /** The lines of `indexes`, in order, for a diagnostic that says where without quoting a name. */
  const linesOf = (indexes: readonly number[]) => [...new Set(indexes.map((index) => statements[index].line))].sort((a, b) => a - b)
  const conflict = (code: string, message: string, indexes: readonly number[]) => {
    const first = statements[indexes[0]]
    diagnostics.push({ severity: 'error', category: 'semantic', code, message: `${message} (lines ${linesOf(indexes).join(', ')}).`, span: { startLine: first.line, startColumn: 1, endLine: first.line, endColumn: 1 }, statement: first.node })
  }

  /**
   * Once every statement is read: each VLAN keyed by its ID, its name, description and routed IRB unit; each switch
   * port's VLANs by ID; and IRB units that route for no VLAN left out, as the model has an IRB unit only for a VLAN.
   */
  function settleVlans() {
    // vlan-id against vlan-id-list, as one setting: the higher-ranked, else the later, replaces the other.
    const listed = new Set<string>()
    for (const [name, indexes] of lists) {
      const id = vlanStates.get(name)!.id?.index
      const wins = (l: number) => id === undefined || expansion.outranks(statements[l], statements[id]) || (!expansion.outranks(statements[id], statements[l]) && l > id)
      const winner = indexes.find(wins)
      if (winner === undefined) {
        for (const index of indexes) settleTo(index, ignored(`superseded by line ${statements[id!].line}`))
        continue
      }
      listed.add(name)
      if (id !== undefined) settleTo(id, ignored(`superseded by line ${statements[winner].line}`))
      for (const index of indexes) settleTo(index, unsupported('a VLAN with a list of IDs: the model gives a VLAN one ID'))
    }

    // Each name's ID. Two VLANs with one ID are neither: Junos refuses that, and which one a port means can't be told.
    const byId = new Map<number, string[]>()
    for (const [name, state] of vlanStates) if (state.id && !listed.has(name)) byId.set(state.id.value, [...(byId.get(state.id.value) ?? []), name])
    const ids = new Map<string, number>()
    for (const [id, names] of byId) {
      if (names.length === 1) {
        ids.set(names[0], id)
        continue
      }
      const all = names.flatMap((name) => vlanStates.get(name)!.statements)
      for (const index of all) settleTo(index, unsupported('two VLANs have the same vlan-id, which Junos refuses: neither is converted'))
      conflict('junos.vlan-id-twice', 'Two VLANs have the same vlan-id: Junos accepts a VLAN ID once', all)
    }

    // Each VLAN with its ID: its name, description and routed unit. One without an ID isn't converted.
    const routedUnits = new Map<string, number[]>()
    for (const [name, state] of vlanStates) {
      const id = ids.get(name)
      if (id === undefined) {
        const why = listed.has(name) ? 'a VLAN with a list of IDs (vlan-id-list): the model gives a VLAN one ID, so none of it is converted' : 'a VLAN with no vlan-id: the model keys VLANs by their ID'
        if (!state.id || listed.has(name)) for (const index of state.statements) settleTo(index, unsupported(why))
        continue
      }
      const at = ['vlans', String(id)]
      const vlan = container(at)
      for (const index of state.statements) settleTo(index, mapped([vlan]))
      settleTo(state.id!.index, mapped([model.set([...at, 'name'], name)]))
      if (state.description) settleTo(state.description.index, mapped([model.set([...at, 'description'], state.description.value)]))
      if (state.l3) {
        const m = /^irb\.(\d+)$/.exec(state.l3.value)
        if (!m || !isInteger(m[1])) settleTo(state.l3.index, unsupported('routes for the VLAN on an interface other than an irb unit (non-ELS vlan.N): not converted'))
        else routedUnits.set(String(Number(m[1])), [...(routedUnits.get(String(Number(m[1]))) ?? []), state.l3.index])
      }
    }
    // An IRB unit routes for one VLAN: one named by two is in neither (Junos refuses it).
    for (const [unit, indexes] of routedUnits) {
      if (indexes.length > 1) {
        for (const index of indexes) settleTo(index, unsupported('two VLANs name this IRB unit as their l3-interface, which Junos refuses: it routes for neither'))
        conflict('junos.irb-unit-twice', "Two VLANs have the same l3-interface: Junos routes an IRB unit for one VLAN", indexes)
        continue
      }
      const vlan = ids.get(statements[indexes[0]].words[1])!
      const sub = ['interfaces', 'irb', 'subinterfaces', unit]
      settleTo(indexes[0], mapped([...ensureInterface('irb'), container(sub), model.set([...sub, 'routedVlan'], vlan)]))
    }

    // A non-ELS port isn't converted: without its port-mode, a trunk would come out as an access port.
    const isSwitching = (w: readonly string[], name: string) => w[0] === 'interfaces' && w[1] === name && ((w[2] === 'unit' && isInteger(w[3]) && Number(w[3]) === 0 && w[4] === 'family' && w[5] === 'ethernet-switching') || w[2] === 'native-vlan-id')
    for (const name of nonEls) {
      ports.delete(name)
      model.remove(['interfaces', name, 'switching'])
      statements.forEach((s, i) => {
        if (isSwitching(s.words, name) && results[i].kind !== 'unsupported') results[i] = unsupported("the port's mode is non-ELS port-mode, which isn't converted, so none of its switching is")
      })
    }

    // Each switch port's VLANs, by ID: every name resolved, a trunk's as its allowed VLANs, an access port's (the
    // default mode) as its access VLAN.
    for (const [name, state] of ports) {
      const at = ['interfaces', name, 'switching']
      const resolved: { index: number; value: string }[] = []
      let unresolved = false
      for (const { index, value } of state.members) {
        const id = value === 'all' ? '1-4094' : !/^\d/.test(value) ? (ids.has(value) ? String(ids.get(value)) : null) : value.includes('-') ? value.split('-').map(Number).join('-') : String(Number(value))
        if (id === null || (!id.includes('-') && !byId.has(Number(id))) || (!id.includes('-') && byId.get(Number(id))!.length > 1)) {
          settleTo(index, unsupported("names a VLAN the configuration doesn't give a vlan-id"))
          unresolved = true
        } else resolved.push({ index, value: id })
      }
      const trunk = model.get([...at, 'mode']) === 'trunk'
      const distinct = [...new Set(resolved.map((m) => m.value))]
      // An access port's one VLAN, only when it names no other: beside a VLAN that isn't converted, which it is in can't be told.
      if (!trunk && (distinct.length > 1 || distinct.some((v) => v.includes('-')) || (distinct.length && unresolved))) {
        for (const { index } of resolved) settleTo(index, unsupported('an access port is in one VLAN: Junos refuses more than one, or a range'))
      } else if (distinct.length) {
        const field = trunk ? model.set([...at, 'allowedVlans'], distinct) : model.set([...at, 'accessVlan'], Number(distinct[0]))
        const seen = new Set<string>()
        for (const { index, value } of resolved) {
          settleTo(index, seen.has(value) ? ignored('already a VLAN of the port') : mapped([...ensureInterface(name), container(at), field]))
          seen.add(value)
        }
      }
      // A native VLAN is a trunk's: on a port with no interface-mode trunk, Junos has nothing to carry untagged with it.
      if (state.native) {
        const known = byId.get(state.native.value)?.length === 1
        if (!known) settleTo(state.native.index, unsupported("names a VLAN the configuration doesn't give a vlan-id"))
        else if (!trunk) settleTo(state.native.index, unsupported("a native VLAN on a port that isn't a trunk (interface-mode trunk): Junos takes one on a trunk only"))
        else settleTo(state.native.index, mapped([...ensureInterface(name), container(at), model.set([...at, 'nativeVlan'], state.native.value)]))
      }
    }

    // A port none of whose switching statements converted isn't one, and an interface only those configured isn't there
    // (an aggregate a member link names is made sure of after: settleAggregates).
    for (const name of new Set([...nonEls, ...ports.keys()])) {
      const converted = (test: (w: readonly string[]) => boolean) => statements.some((s, i) => test(s.words) && results[i].kind === 'mapped')
      if (!converted((w) => isSwitching(w, name))) model.remove(['interfaces', name, 'switching'])
      const left = model.get(['interfaces', name])
      const typeOnly = isObject(left) && Object.keys(left).every((key) => key === 'type')
      if (typeOnly && !converted((w) => w[0] === 'interfaces' && w[1] === name)) model.remove(['interfaces', name])
    }
    model.removeIfEmpty(['interfaces'])

    // An IRB unit that routes for no VLAN isn't converted (the model's IRB unit routes for a VLAN): its statements are
    // unsupported, and so is the irb interface's own when none of its units is converted.
    const irb = model.get(['interfaces', 'irb'])
    if (!isObject(irb)) return
    const subs = isObject(irb.subinterfaces) ? irb.subinterfaces : {}
    const dropped = Object.keys(subs).filter((unit) => !isObject(subs[unit]) || (subs[unit] as Obj).routedVlan === undefined)
    const whole = dropped.length === Object.keys(subs).length
    const inUnit = (s: Expanded, unit: string) => s.words[2] === 'unit' && isInteger(s.words[3]) && String(Number(s.words[3])) === unit
    const left: number[] = []
    statements.forEach((s, i) => {
      if (s.words[0] !== 'interfaces' || s.words[1] !== 'irb') return
      if (!(whole || dropped.some((unit) => inUnit(s, unit)))) return
      if (results[i].kind !== 'mapped') return
      results[i] = unsupported("an IRB unit that routes for no VLAN converted here (no top-level vlans … l3-interface names it, or only a mac-vrf's): not converted")
      left.push(i)
    })
    for (const unit of dropped) {
      const member = members.get(fieldPath('interfaces', 'irb', 'subinterfaces', unit))
      for (const index of member?.statements ?? []) {
        if (results[index].kind !== 'mapped') continue
        results[index] = unsupported('an IRB unit that routes for no VLAN: not converted')
        left.push(index)
      }
      model.remove(['interfaces', 'irb', 'subinterfaces', unit])
    }
    if (whole) model.remove(['interfaces', 'irb'])
    else model.removeIfEmpty(['interfaces', 'irb', 'subinterfaces'])
    model.removeIfEmpty(['interfaces'])
    if (left.length) diagnostics.push({ severity: 'warning', category: 'semantic', code: 'junos.irb-without-vlan', message: `An IRB unit routes for no VLAN, so it isn't converted (lines ${linesOf(left).join(', ')}).` })
  }

  // ---- OSPF and BGP
  //
  // Per routing instance (`protocols` at the top is the global table's). The instance's router ID and AS number
  // (`routing-options router-id`, `autonomous-system`) are its OSPF's and BGP's, settled once every statement is read.
  // Keys are flagged, never carried: a statement with one fills only the `authentication` flag.

  /** Per instance, the `router-id` and `autonomous-system` statements that set them last, with their values. */
  const routerIds = new Map<string, { index: number; value: string | number }>()
  const asNumbers = new Map<string, { index: number; value: string | number }>()
  /** A single setting of an instance's routing options, settled later: a placeholder until then. */
  const later = (states: Map<string, { index: number; value: string | number }>, instance: string, value: string | number, i: number): Mutable => {
    if (claim(`${instance}\u0000${states === routerIds ? 'router-id' : 'autonomous-system'}`, i)) states.set(instance, { index: i, value })
    return mapped([])
  }
  /** An AS number in plain form, from 1 to 4294967295, or null. */
  const asNumber = (s: string | undefined): number | null => (isInteger(s) && Number(s) >= 1 ? Number(s) : null)
  /** An OSPF area ID, dotted (`0.0.0.0`) or as a number (`0` is `0.0.0.0`), in dotted form; or null. */
  const areaId = (s: string): string | null => {
    if (isIpv4(s)) return s
    if (!isInteger(s)) return null
    const n = Number(s)
    return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.')
  }
  /** Per instance and area, every OSPF statement about the area: one whose type can't be carried converts not at all. */
  const areaStatements = new Map<string, number[]>()
  /** Per instance, area and interface reference, every OSPF statement about the interface. */
  const interfaceStatements = new Map<string, number[]>()
  /** `interface-type` statements of a type the model has no word for (`nbma`, `p2mp`), by statement: the interface. */
  const untyped = new Map<number, { readonly at: Segments; readonly key: string }>()
  /** `stub` or `nssa` statements with options (`no-summaries`, `default-metric`…), by statement: their instance and area. */
  const optioned = new Map<number, { readonly instance: string; readonly area: string; readonly type: 'stub' | 'nssa' }>()
  /** Every `stub` and `nssa` statement, plain or with options, by statement: which of the two it says. */
  const areaTypes = new Map<number, 'stub' | 'nssa'>()
  /** Each OSPF interface statement: where its interface is in the model, and its reference, checked once interfaces are settled. */
  const ospfRefs: { readonly index: number; readonly at: Segments; readonly ref: string }[] = []
  /** Per instance and neighbor address, the groups that name it and their statements: Junos takes a neighbor in one group. */
  const neighbors = new Map<string, { readonly instance: string; readonly address: string; readonly groups: Map<string, number[]> }>()
  /** The import and export statements: each policy it names, the peer and the side, resolved once policies are settled. */
  const policyRefs: { readonly index: number; readonly peer: Segments; readonly field: 'importPolicies' | 'exportPolicies'; readonly name: string }[] = []

  const mapProtocols = (instance: string, r: readonly string[], i: number): Mutable => {
    if (r[0] === 'ospf') return mapOspf(instance, r.slice(1), i)
    if (r[0] === 'bgp') return mapBgp(instance, r.slice(1), i)
    return unsupported(r[0] === 'ospf3' ? 'OSPFv3 comes later: the model has OSPFv2' : 'routing protocols come later')
  }

  const mapOspf = (instance: string, r: readonly string[], i: number): Mutable => {
    const at = ['networkInstances', instance, 'ospf']
    if (!r.length) return mapped([model.ensure(at)])
    if (r[0] !== 'area' || r[1] === undefined) return unsupported(r[0] === 'import' || r[0] === 'export' ? "OSPF import and export policies: the model has no place for them yet" : undefined)
    const area = areaId(r[1])
    if (area === null) return unsupported('not an OSPF area ID (dotted, or a number)')
    const a = [...at, 'areas', area]
    const areaKey = `${instance}\u0000${area}`
    areaStatements.set(areaKey, [...(areaStatements.get(areaKey) ?? []), i])
    const withArea = (fields: (string | null)[]) => mapped([container(at), container(a), ...fields])
    const s = r.slice(2)
    if (!s.length) return withArea([])
    if (s[0] === 'stub' || s[0] === 'nssa') areaTypes.set(i, s[0])
    if ((s[0] === 'stub' || s[0] === 'nssa') && s.length === 1) return withArea([put(i, [...a, 'type'], s[0])])
    if (s[0] === 'stub' || s[0] === 'nssa') {
      // It says the area's type as a plain stub or nssa does, so the ranks decide which type the area has; its option
      // is a child of that type, which a bare `stub` beside it doesn't take away. Settled below.
      claim(fieldPath(...a, 'type'), i)
      optioned.set(i, { instance, area, type: s[0] })
      return unsupported(`${s[0] === 'stub' ? 'a stub' : 'an NSSA'} area's options (no-summaries, default-metric…) come later`)
    }
    if (s[0] === 'authentication-type' && s.length === 2 && (s[1] === 'simple' || s[1] === 'md5')) return withArea([put(i, [...a, 'authentication'], s[1])])
    if (s[0] !== 'interface' || s[1] === undefined) return unsupported()
    const ref = s[1]
    if (ref === 'all') return unsupported('OSPF on every interface (interface all): the model names each interface')
    const f = [...a, 'interfaces', ref]
    const t = s.slice(2)
    const interfaceKey = `${areaKey}\u0000${ref}`
    interfaceStatements.set(interfaceKey, [...(interfaceStatements.get(interfaceKey) ?? []), i])
    const withInterface = (fields: (string | null)[]) => {
      const enabled = model.set([...f, 'enabledBy'], 'interface')
      incidental.add(enabled)
      ospfRefs.push({ index: i, at: f, ref })
      return withArea([container(f), enabled, ...fields])
    }
    const seconds = (max: number) => t.length === 2 && isInteger(t[1], max) && Number(t[1]) >= 1
    if (!t.length) return withInterface([])
    if (t[0] === 'passive' && t.length === 1) return withInterface([put(i, [...f, 'passive'], true)])
    if (t[0] === 'metric' && t.length === 2 && isInteger(t[1], 65535) && Number(t[1]) >= 1) return withInterface([put(i, [...f, 'cost'], Number(t[1]))])
    if (t[0] === 'interface-type' && t.length === 2) {
      if (t[1] === 'p2p') return withInterface([put(i, [...f, 'networkType'], 'point-to-point')])
      // It sets the network type as p2p would, so the ranks decide which the interface has: settled below.
      claim(fieldPath(...f, 'networkType'), i)
      untyped.set(i, { at: f, key: interfaceKey })
      return unsupported('an OSPF interface type the model has no word for (it has point-to-point and broadcast)')
    }
    if (t[0] === 'hello-interval' && seconds(255)) return withInterface([put(i, [...f, 'helloInterval'], Number(t[1]))])
    if (t[0] === 'dead-interval' && seconds(65535)) return withInterface([put(i, [...f, 'deadInterval'], Number(t[1]))])
    // The key is never carried: the model says only how the interface authenticates.
    if (t[0] === 'authentication' && t[1] === 'simple-password' && t.length === 3) return withInterface([put(i, [...f, 'authentication'], 'simple')])
    if (t[0] === 'authentication' && t[1] === 'md5' && isInteger(t[2], 255) && t[3] === 'key' && t.length === 5) return withInterface([put(i, [...f, 'authentication'], 'md5')])
    return unsupported()
  }

  const mapBgp = (instance: string, r: readonly string[], i: number): Mutable => {
    const at = ['networkInstances', instance, 'bgp']
    if (!r.length) return mapped([model.ensure(at)])
    if (r[0] !== 'group' || r[1] === undefined) return unsupported(r[0] === 'neighbor' ? 'a BGP neighbor outside a group: the model has a neighbor in a group' : 'BGP settings for every group come later: the model has them per group and neighbor')
    const group = r[1]
    const g = [...at, 'groups', group]
    const s = r.slice(2)
    if (s[0] !== 'neighbor') return mapPeer(g, s, i, () => [container(at), container(g)], true)
    const address = s[1]
    if (address === undefined || !(isIpv4(address) || isIpv6(address))) return unsupported('a BGP neighbor that is not an address')
    const n = [...at, 'neighbors', addressKey(address)]
    // The neighbor, in its group, only once one of its settings converts: one with none isn't in the model.
    const made = () => {
      const key = `${instance}\u0000${addressKey(address)}`
      const state = neighbors.get(key) ?? { instance, address: addressKey(address), groups: new Map<string, number[]>() }
      neighbors.set(key, state)
      state.groups.set(group, [...(state.groups.get(group) ?? []), i])
      const inGroup = model.set([...n, 'group'], group)
      incidental.add(inGroup)
      return [container(at), container(g), container(n), inGroup]
    }
    return mapPeer(n, s.slice(2), i, made, false)
  }

  /**
   * A setting of a BGP group (`group`) or neighbor: what both say, and a group's type. `made` makes sure of the peer
   * (and its BGP and group), only once the setting converts.
   */
  const mapPeer = (at: Segments, t: readonly string[], i: number, made: () => string[], group: boolean): Mutable => {
    const ok = (fields: () => (string | null)[]) => {
      const peer = made()
      return mapped([...peer, ...fields()])
    }
    if (!t.length) return ok(() => [])
    if (group && t[0] === 'type' && t.length === 2 && (t[1] === 'internal' || t[1] === 'external')) return ok(() => [put(i, [...at, 'type'], t[1])])
    if (t[0] === 'peer-as' && t.length === 2) return asNumber(t[1]) !== null ? ok(() => [put(i, [...at, 'peerAs'], asNumber(t[1]))]) : unsupported('not an AS number from 1 to 4294967295, in plain form')
    if (t[0] === 'description' && t.length === 2) return ok(() => [put(i, [...at, 'description'], t[1])])
    if (t[0] === 'local-address' && t.length === 2) return isIpv4(t[1]) || isIpv6(t[1]) ? ok(() => [put(i, [...at, 'localAddress'], addressKey(t[1]))]) : unsupported('not an address')
    if (t[0] === 'multihop' && t.length === 1) return ok(() => [model.ensure([...at, 'multihop'])])
    if (t[0] === 'multihop' && t[1] === 'ttl' && t.length === 3 && isInteger(t[2], 255) && Number(t[2]) >= 1) return ok(() => [container([...at, 'multihop']), put(i, [...at, 'multihop', 'ttl'], Number(t[2]))])
    if (t[0] === 'family' && (t[1] === 'inet' || t[1] === 'inet6') && t[2] === 'unicast' && t.length === 3) return ok(() => [model.ensure([...at, 'addressFamilies', t[1] === 'inet' ? 'ipv4-unicast' : 'ipv6-unicast'])])
    if (t[0] === 'family') return unsupported('BGP address families other than IPv4 and IPv6 unicast, and their options, come later')
    if (t[0] === 'import' || t[0] === 'export') {
      if (t.length !== 2 || !/^[A-Za-z0-9_][\w.:/-]*$/.test(t[1])) return unsupported('a policy expression: the model names each policy')
      const field = [...at, t[0] === 'import' ? 'importPolicies' : 'exportPolicies']
      const list = (model.get(field) as string[] | undefined) ?? []
      if (list.includes(t[1])) return ignored('already a policy of the peer')
      policyRefs.push({ index: i, peer: at, field: field[field.length - 1] as 'importPolicies' | 'exportPolicies', name: t[1] })
      return ok(() => [model.set(field, [...list, t[1]])])
    }
    // The key is never carried: the model says only that there is one.
    if (t[0] === 'authentication-key' && t.length === 2) return ok(() => [put(i, [...at, 'authentication'], true)])
    return unsupported()
  }

  /**
   * Once every statement is read and the interfaces settled: OSPF interfaces that name one the model has, each BGP
   * neighbor in one group, and each instance's router ID and AS number on its OSPF and BGP.
   */
  function settleProtocols(policies: ReadonlySet<string>) {
    const interfaces = model.get(['interfaces'])
    /** Whether `ref` names an interface of the model, or with `.N`, one of its subinterfaces (as modelProblems() reads it). */
    const exists = (ref: string): boolean => {
      if (!isObject(interfaces)) return false
      if (Object.hasOwn(interfaces, ref)) return true
      const m = /^(.+)\.(\d+)$/.exec(ref)
      const subs = m && isObject(interfaces[m[1]]) ? (interfaces[m[1]] as Obj).subinterfaces : undefined
      return m !== null && isObject(subs) && Object.hasOwn(subs, String(Number(m[2])))
    }
    // An area whose type, in the end, is a stub or NSSA with options the model can't carry converts not at all: its
    // interfaces in an area of another type (normal, or a lower-ranked type) would change how the area routes. Stub and
    // NSSA replace each other (rank, then order), but an option stays with its type: a bare `stub` beside `stub
    // no-summaries`, before or after it, or from the configuration over a group's, leaves the option in force.
    const excluded = new Set<string>()
    for (const [, { instance, area, type }] of optioned) {
      const at = ['networkInstances', instance, 'ospf', 'areas', area]
      const owner = owners.get(fieldPath(...at, 'type'))
      if (owner === undefined || areaTypes.get(owner) !== type || excluded.has(`${instance}\u0000${area}`)) continue
      excluded.add(`${instance}\u0000${area}`)
      for (const i of areaStatements.get(`${instance}\u0000${area}`) ?? []) {
        if (!optioned.has(i) && results[i].kind !== 'unsupported') results[i] = unsupported("the area is a stub or NSSA with options that aren't converted, so none of it is")
      }
      model.remove(at)
      for (let k = at.length - 1; k >= 3; k--) model.removeIfEmpty(at.slice(0, k))
      if (instance === 'default') model.removeIfEmpty(at.slice(0, 2))
      model.removeIfEmpty(['networkInstances'])
    }

    // Likewise an interface whose network type, in the end, is one the model has no word for: as broadcast or with a
    // lower-ranked type it would form adjacencies another way.
    for (const [index, { at, key }] of untyped) {
      if (owners.get(fieldPath(...at, 'networkType')) !== index || model.get(at) === undefined) continue
      for (const i of interfaceStatements.get(key) ?? []) {
        if (i !== index && results[i].kind !== 'unsupported') results[i] = unsupported("the interface's OSPF network type isn't converted, so none of its OSPF settings are")
      }
      model.remove(at)
      for (let k = at.length - 1; k >= 3; k--) model.removeIfEmpty(at.slice(0, k))
      if (at[1] === 'default') model.removeIfEmpty(at.slice(0, 2))
      model.removeIfEmpty(['networkInstances'])
    }

    for (const { index, at, ref } of ospfRefs) {
      if (exists(ref) || results[index].kind !== 'mapped' || model.get(at) === undefined) continue
      results[index] = unsupported("names an interface the configuration doesn't have, or that isn't converted")
      model.remove(at)
      // Up to the instance, which goes too when it was only there for its OSPF (the global table).
      for (let k = at.length - 1; k >= 3; k--) model.removeIfEmpty(at.slice(0, k))
      if (at[1] === 'default') model.removeIfEmpty(at.slice(0, 2))
      model.removeIfEmpty(['networkInstances'])
    }

    // A neighbor two groups name is in neither: Junos refuses it.
    for (const { instance, address, groups } of neighbors.values()) {
      if (groups.size < 2) continue
      const all = [...groups.values()].flat()
      for (const index of all) results[index] = unsupported('the neighbor is in two BGP groups, which Junos refuses: it is left in neither')
      model.remove(['networkInstances', instance, 'bgp', 'neighbors', address])
      model.removeIfEmpty(['networkInstances', instance, 'bgp', 'neighbors'])
      conflict('junos.bgp-neighbor-twice', 'A BGP neighbor is in two groups: Junos accepts it in one only', all)
    }

    for (const [instance, { index, value }] of routerIds) {
      if (otherTypes.has(instance)) continue
      const fields = ['ospf', 'bgp'].filter((p) => isObject(model.get(['networkInstances', instance, p]))).map((p) => model.set(['networkInstances', instance, p, 'routerId'], value))
      settleTo(index, fields.length ? mapped(fields) : unsupported('a router ID with no OSPF or BGP here: the model keeps it with them'))
    }
    for (const [instance, { index, value }] of asNumbers) {
      if (otherTypes.has(instance)) continue
      const bgp = isObject(model.get(['networkInstances', instance, 'bgp']))
      settleTo(index, bgp ? mapped([model.set(['networkInstances', instance, 'bgp', 'localAs'], value)]) : unsupported('an AS number with no BGP here: the model keeps it with BGP'))
    }

    // A VRF's vrf-import and vrf-export (model 0.5.2): its own policies, a chain each way, converted whole as a BGP peer's
    // are. On Junos they replace the vrf-target that way (`vrfPolicyMode: 'replaces-route-targets'`).
    for (const [key, refs] of vrfPolicies) {
      const [instance, field] = key.split('\u0000') as [string, 'importPolicies' | 'exportPolicies']
      const live = refs.filter((ref) => results[ref.index].kind === 'mapped')
      if (!live.length || otherTypes.has(instance)) continue
      if (live.some((ref) => !policies.has(ref.name))) {
        for (const ref of live) results[ref.index] = unsupported("names a policy the configuration doesn't define, or that isn't converted: none of the routing instance's policies that way are, as they run as a chain")
        continue
      }
      const at = ['networkInstances', instance]
      const list = model.set([...at, field], live.map((ref) => ref.name))
      const mode = model.set([...at, 'vrfPolicyMode'], 'replaces-route-targets')
      incidental.add(mode)
      for (const ref of live) results[ref.index] = mapped([container(at), list, mode])
    }

    // Each peer's import and export policies are a chain, converted whole: one that names a policy the configuration
    // doesn't define, or that isn't converted, leaves the side out. A neighbor without its own would take its group's,
    // so the group's goes too.
    const chains = new Map<string, { readonly peer: Segments; readonly field: 'importPolicies' | 'exportPolicies'; readonly indexes: number[]; broken: boolean }>()
    for (const ref of policyRefs) {
      if (results[ref.index].kind !== 'mapped') continue
      const key = fieldPath(...ref.peer, ref.field)
      const chain = chains.get(key) ?? { peer: ref.peer, field: ref.field, indexes: [], broken: false }
      chains.set(key, chain)
      chain.indexes.push(ref.index)
      if (!policies.has(ref.name)) chain.broken = true
    }
    const breakChain = (chain: { readonly peer: Segments; readonly field: string; readonly indexes: number[] }, reason: string) => {
      for (const index of chain.indexes) if (results[index].kind !== 'unsupported') results[index] = unsupported(reason)
      model.remove([...chain.peer, chain.field])
    }
    for (const chain of chains.values()) {
      if (!chain.broken) continue
      breakChain(chain, "names a policy the configuration doesn't define, or that isn't converted: none of the peer's policies that way are, as they run as a chain")
      const neighbor = chain.peer[chain.peer.length - 2] === 'neighbors'
      const group = neighbor ? model.get([...chain.peer, 'group']) : undefined
      const groupChain = typeof group === 'string' ? chains.get(fieldPath(...chain.peer.slice(0, -2), 'groups', group, chain.field)) : undefined
      if (groupChain && !groupChain.broken) breakChain(groupChain, "a neighbor of the group has its own policies that way that aren't converted: without them it would take the group's, so the group's aren't converted either")
    }

    // Junos's default for an eBGP peer with no policy: it accepts the peer's routes and advertises its active BGP routes
    // to it (model 0.4.1). Set for the side(s) an eBGP peer without a policy has, so a target that rejects by default
    // (IOS-XR, RFC 8212) can say what changes.
    const instances = model.get(['networkInstances'])
    for (const name of isObject(instances) ? Object.keys(instances) : []) {
      const bgp = model.get(['networkInstances', name, 'bgp'])
      if (!isObject(bgp)) continue
      const groups = isObject(bgp.groups) ? bgp.groups : {}
      const sides = new Set<'import' | 'export'>()
      for (const neighbor of Object.values(isObject(bgp.neighbors) ? bgp.neighbors : {})) {
        if (!isObject(neighbor)) continue
        const group = typeof neighbor.group === 'string' && isObject(groups[neighbor.group]) ? (groups[neighbor.group] as Obj) : {}
        const peerAs = neighbor.peerAs ?? group.peerAs
        const external = group.type === 'external' || (group.type === undefined && typeof peerAs === 'number' && typeof bgp.localAs === 'number' && peerAs !== bgp.localAs)
        if (!external) continue
        // A neighbor's own policies replace its group's, as Junos applies them.
        for (const [side, field] of [['import', 'importPolicies'], ['export', 'exportPolicies']] as const) if (!Array.isArray(neighbor[field] ?? group[field])) sides.add(side)
      }
      if (sides.size) model.set(['networkInstances', name, 'bgp', 'ebgpDefaultPolicy'], Object.fromEntries([...sides].sort().map((side) => [side, 'accept'])))
    }
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
      case 'protocols':
        return mapProtocols('default', w.slice(1), i)
      case 'routing-instances':
        return mapInstance(w, i)
      case 'snmp':
        return mapSnmp(w, i)
      case 'vlans':
        return mapVlan(w, i)
      case 'policy-options':
        return policy.map(w, i)
      case 'firewall':
        return filter.map(w, i)
      case 'chassis':
        if (w[1] === 'aggregated-devices' && w[2] === 'ethernet' && w[3] === 'device-count' && w.length === 5) return ignored("how many aggregates Junos makes room for: a render writes it from the model's aggregates")
        return unsupported()
      default:
        return unsupported()
    }
  }

  statements.forEach((s, i) => {
    const result = mapStatement(s, i)
    // A statement whose setting a higher-ranked one kept, with nothing else of its own, is superseded by it.
    const winner = lost.get(i)
    results[i] = winner !== undefined && result.kind === 'mapped' && result.fields.every((f) => incidental.has(f)) ? ignored(`superseded by line ${winner}`) : result
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

  // Each instance's route targets, now its every vrf-target statement is known: import and export override the plain one.
  for (const [instance, state] of targets) {
    const both = state.get('both')
    const fields = new Map<number, string[]>()
    for (const side of ['import', 'export'] as const) {
      const from = state.get(side) ?? both
      if (!from) continue
      fields.set(from.index, [...(fields.get(from.index) ?? []), model.set(['networkInstances', instance, 'routeTargets', side], [from.value])])
    }
    for (const { index } of state.values()) results[index] = fields.has(index) ? mapped(fields.get(index)!) : ignored('overridden by vrf-target import and export')
  }

  // A unit named in two routing instances is in neither: Junos would refuse the configuration.
  const diagnostics: Diagnostic[] = []
  for (const member of members.values()) {
    if (!member.twice) continue
    model.remove([...member.sub, 'networkInstance'])
    model.removeIfEmpty(member.sub)
    model.removeIfEmpty(member.sub.slice(0, -1))
    for (const index of member.statements) results[index] = unsupported('the unit is in two routing instances, which Junos refuses: it is left in neither')
    const lines = [...new Set(member.statements.map((index) => statements[index].line))].sort((a, b) => a - b)
    const first = statements[member.statements[1]]
    diagnostics.push({
      severity: 'error',
      category: 'semantic',
      code: 'junos.unit-in-two-instances',
      // Which unit is said by the lines, not its name (a name can be a reused secret).
      message: `A unit is in two routing instances (lines ${lines.join(', ')}): Junos accepts it in one only.`,
      span: { startLine: first.line, startColumn: 1, endLine: first.line, endColumn: 1 },
      statement: first.node
    })
  }

  // An instance whose type, in the end, isn't one converted isn't converted at all, nor are its units' memberships.
  for (const [index, name] of otherTypeAt) {
    if (owners.get(fieldPath('networkInstances', name, 'type')) !== index) continue
    results[index] = unsupported('routing instances other than VRFs and virtual routers come later')
    otherTypes.add(name)
  }
  for (const name of otherTypes) {
    model.remove(['networkInstances', name])
    model.removeIfEmpty(['networkInstances'])
    for (const member of members.values()) {
      if (member.instance !== name) continue
      model.remove([...member.sub, 'networkInstance'])
      model.removeIfEmpty(member.sub)
      model.removeIfEmpty(member.sub.slice(0, -1))
    }
    statements.forEach((s, i) => {
      if (startsWith(s.words, ['routing-instances', name]) && results[i].kind !== 'unsupported') results[i] = unsupported("the routing instance's type isn't converted, so none of it is")
    })
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

  // Filters before VLANs: an IRB unit that routes for no VLAN takes its filter attachments with it.
  const settled = policy.settle()
  filter.settle(settled.lists)
  settleVlans()
  settleProtocols(settled.policies)
  settleAggregates()

  // Every statement left out says why: one its mapper had nothing more to say about, by its keywords (unconverted.ts),
  // in words no secret of the configuration is in.
  const secrets = secretValues(text)
  results.forEach((r, i) => {
    if (r.kind === 'unsupported' && !r.reason) results[i] = unsupported(unconvertedReason(statements[i].words, secrets))
  })

  return { tree: read.tree, model: model.root as Device, dispositions: settle(read.tree, read.dispositions, expansion, statements, results), diagnostics: [...read.diagnostics, ...expansion.diagnostics, ...diagnostics] }
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
    const d = own ?? (list ? combine(list, false) : Object.hasOwn(expansion.unused, node.id) ? expansion.unused[node.id] : kids.length ? combine(kids, true) : unsupported("a statement this converter doesn't read"))
    out[node.id] = d
    return d
  }
  tree.forEach(visit)
  return out
}
