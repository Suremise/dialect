// IOS / IOS-XE text → the shared model, for the phase 1 areas: system (hostname, domain name, DNS), interfaces and
// subinterfaces with their addresses and VRF, VRFs (`vrf definition`, `ip vrf`) with their route distinguisher and
// route targets, static routes, NTP, logging and SNMP; and from model 0.4, VLANs, switch ports (`switchport`) and VLAN
// interfaces (`interface Vlan10`, routing for VLAN 10); from model 0.5, routing policy (policy.ts: prefix lists,
// community and AS-path lists, route maps), which BGP's route maps resolve to. Every statement of the tree gets a disposition: `mapped` when
// everything it says went into the model, `ignored-by-design` with why, or `unsupported` (its text kept in the tree). A
// statement is mapped only when every option on it is understood: one with an option the model can't hold
// (`ntp server 192.0.2.1 key 1`) is unsupported as a whole, never half-converted. `vrf forwarding` clears the addresses
// before it, as on the device.
import { fieldPath, isRouteDistinguisher, type Context, type Device, type Diagnostic, type ParseResult, type StatementDisposition, type SyslogSeverity } from '@dialect/core'
import { asNumber, inRange, ipv4Prefix, ipv6Prefix, isIpv4, isIpv6, maskLength } from './addresses'
import { interfaceName, interfaceType, isInterfaceName, splitSubinterface } from './names'
import { createAclReader } from './acl'
import { createPolicyReader } from './policy'
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

/** A VLAN ID as IOS writes it (`10`), from 1 to 4094, or null. */
const vlanId = (s: string): number | null => (INTEGER.test(s) && Number(s) >= 1 && Number(s) <= 4094 ? Number(s) : null)
/** Every VLAN ID, as IOS reads `all` (and a trunk with no allowed list). */
const ALL_VLANS: ReadonlySet<number> = new Set(Array.from({ length: 4094 }, (_, i) => i + 1))
/** VLANs IOS always has and can't delete: VLAN 1, and 1002 to 1005 (the FDDI and Token Ring defaults). */
const DEFAULT_VLANS: ReadonlySet<number> = new Set([1, 1002, 1003, 1004, 1005])

/** A VLAN list (`10,20-30`, as the words after the keyword, joined) as IDs, or null when an item isn't an ID or a range of them. */
function readVlanList(text: string): Set<number> | null {
  const ids = new Set<number>()
  for (const item of text.split(',')) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(item)
    const first = m ? vlanId(m[1]) : null
    const last = m?.[2] !== undefined ? vlanId(m[2]) : first
    if (first === null || last === null || first > last) return null
    for (let v = first; v <= last; v++) ids.add(v)
  }
  return ids
}

/** An OSPF area as the model keys it, dotted (`area 10` is `0.0.0.10`), or null. */
export function ospfArea(s: string): string | null {
  if (INTEGER.test(s)) {
    const n = Number(s)
    return n <= 4294967295 ? [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.') : null
  }
  return isIpv4(s) ? s : null
}

/** An IPv4 address as a 32-bit number. */
const ipv4Number = (a: string) => a.split('.').reduce((n, o) => n * 256 + Number(o), 0)

/** VLAN IDs as the model's allowed list: in order, a run of two or more as a range (`20-30`), a single one alone. */
export function vlanList(ids: ReadonlySet<number>): string[] {
  const sorted = [...ids].sort((a, b) => a - b)
  const out: string[] = []
  for (let i = 0; i < sorted.length; ) {
    let j = i
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++
    out.push(j > i ? `${sorted[i]}-${sorted[j]}` : String(sorted[i]))
    i = j + 1
  }
  return out
}
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
  /** Prefix lists, community and AS-path lists and route maps (policy.ts). */
  const policy = createPolicyReader(dispositions)
  /** Access lists and their attachment to interfaces (acl.ts). */
  const acl = createAclReader(dispositions)

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

  // ---- switch ports

  /** Per interface: its `switchport` statements, so `no switchport` can clear them. */
  const switchports = new Map<string, IosNode[]>()
  /** Per interface: the VLANs its trunk allows (none here: every VLAN, IOS's default), and the statements that say so. */
  const trunks = new Map<string, { readonly ids: ReadonlySet<number>; readonly nodes: IosNode[] }>()
  /** VLANs a `switchport access vlan` created, as IOS does, with no `vlan` statement since: by that statement. */
  const createdBy = new Map<number, IosNode>()
  /** Per Vlan interface: its `interface VlanN` statement, which says the VLAN it routes for. */
  const svis = new Map<string, IosNode[]>()

  /**
   * `switchport …` and its `no` forms on a main interface: the interface's `switching`. A later mode, access or native
   * VLAN supersedes an earlier one; a trunk's allowed list is replaced by a list, `all`, `none` or `except`, and changed
   * by `add` and `remove` (from every VLAN when it has none yet), as on the device. `no switchport` clears them all.
   */
  const mapSwitchport = (node: IosNode, ctx: InterfaceContext): StatementDisposition => {
    if (ctx.isSub) return unsupported('a subinterface isn\'t a switch port')
    if (interfaceType(ctx.name) === 'irb-or-svi') return unsupported('a VLAN interface routes: it isn\'t a switch port')
    const lw = node.words.map((x) => x.toLowerCase())
    const remove = lw[0] === 'no'
    const a = lw.slice(remove ? 2 : 1)
    const sw = ['interfaces', ctx.name, 'switching']
    const statements = switchports.get(ctx.name) ?? []
    switchports.set(ctx.name, statements)
    const settings = { mode: [...sw, 'mode'], access: [...sw, 'accessVlan'], native: [...sw, 'nativeVlan'] }

    const setting = (path: Segments, value: unknown): StatementDisposition => {
      claim(fieldPath(...path), node)
      statements.push(node)
      return mapped([model.set(path, value)])
    }
    const unset = (path: Segments): StatementDisposition => {
      const previous = owners.get(fieldPath(...path))
      if (!previous) return ignored('not set: nothing to convert')
      owners.delete(fieldPath(...path))
      model.remove(path)
      set(previous, ignored(`removed by line ${line(node)}`))
      return ignored(`removes the setting on line ${line(previous)}: nothing to convert`)
    }

    if (remove) {
      if (!a.length) {
        // The interface becomes a routed port: every switch port setting before it goes, as on the device.
        for (const n of statements) set(n, ignored(`removed by line ${line(node)}, which makes the interface a routed port`))
        switchports.delete(ctx.name)
        trunks.delete(ctx.name)
        for (const path of Object.values(settings)) owners.delete(fieldPath(...path))
        model.remove(sw)
        return unsupported('a routed port: the model has no setting for it')
      }
      if (a[0] === 'mode' && a.length <= 2) return unset(settings.mode)
      if (a[0] === 'access' && a[1] === 'vlan' && a.length <= 3) return unset(settings.access)
      if (a[0] === 'trunk' && a[1] === 'native' && a[2] === 'vlan' && a.length <= 4) return unset(settings.native)
      if (a[0] === 'trunk' && a[1] === 'allowed' && a[2] === 'vlan' && a.length === 3) {
        const trunk = trunks.get(ctx.name)
        if (!trunk) return ignored('no allowed list: nothing to convert')
        for (const n of trunk.nodes) set(n, ignored(`removed by line ${line(node)}`))
        trunks.delete(ctx.name)
        model.remove([...sw, 'allowedVlans'])
        return ignored(`removes the allowed list on ${linesText(trunk.nodes.map(line))}, so the trunk allows every VLAN: nothing to convert`)
      }
      return unsupported()
    }

    if (!a.length) {
      statements.push(node)
      model.object(sw)
      return mapped([fieldPath(...sw)])
    }
    if (a[0] === 'mode' && a.length === 2 && (a[1] === 'access' || a[1] === 'trunk')) return setting(settings.mode, a[1])
    if (a[0] === 'mode' && ((a[1] === 'dynamic' && (a[2] === 'auto' || a[2] === 'desirable') && a.length === 3) || (a[1] === 'dot1q-tunnel' && a.length === 2) || (a[1] === 'private-vlan' && a.length >= 3))) {
      // A mode the model doesn't have still replaces the one before it, as on the device: that one isn't converted
      // either, so a negotiated port never comes out as a forced trunk.
      claim(fieldPath(...settings.mode), node)
      statements.push(node)
      model.remove(settings.mode)
      return unsupported('a switch port mode the model doesn\'t have (only access and trunk)')
    }
    if (a[0] === 'access' && a[1] === 'vlan' && a.length === 3) {
      const id = vlanId(a[2])
      if (id === null) return unsupported('not a VLAN ID from 1 to 4094')
      const d = setting(settings.access, id)
      // IOS creates an access VLAN that doesn't exist, one `no vlan` deleted too, and it stays when the port moves on.
      if (model.get(['vlans', String(id)]) !== undefined || d.kind !== 'mapped') return d
      model.object(['vlans', String(id)])
      deletions.delete(id)
      createdBy.set(id, node)
      return mapped([...d.fields, fieldPath('vlans', String(id))])
    }
    if (a[0] === 'trunk' && a[1] === 'native' && a[2] === 'vlan' && a.length === 4) {
      const id = vlanId(a[3])
      return id === null ? unsupported('not a VLAN ID from 1 to 4094') : setting(settings.native, id)
    }
    if (a[0] === 'trunk' && a[1] === 'allowed' && a[2] === 'vlan' && a.length > 3) {
      const words = a.slice(3)
      const op = words[0]
      const current = trunks.get(ctx.name)
      let ids: ReadonlySet<number>
      let replaces = true
      if (words.length === 1 && (op === 'all' || op === 'none')) ids = op === 'all' ? ALL_VLANS : new Set()
      else {
        const changes = op === 'add' || op === 'remove' || op === 'except'
        const list = words.length > (changes ? 1 : 0) ? readVlanList(words.slice(changes ? 1 : 0).join('')) : null
        if (!list) return unsupported('not a list of VLAN IDs from 1 to 4094')
        const base = current?.ids ?? ALL_VLANS
        if (op === 'except') ids = new Set([...ALL_VLANS].filter((v) => !list.has(v)))
        else if (op === 'add') ids = new Set([...base, ...list])
        else if (op === 'remove') ids = new Set([...base].filter((v) => !list.has(v)))
        else ids = list
        replaces = op !== 'add' && op !== 'remove'
      }
      if (replaces && current) for (const n of current.nodes) set(n, ignored(`superseded by line ${line(node)}`))
      trunks.set(ctx.name, { ids, nodes: [...(replaces || !current ? [] : current.nodes), node] })
      statements.push(node)
      return mapped([model.set([...sw, 'allowedVlans'], vlanList(ids))])
    }
    if (a[0] === 'trunk' && a[1] === 'encapsulation' && a[2] === 'dot1q' && a.length === 3) {
      statements.push(node)
      return ignored('802.1Q, the only trunk encapsulation the model knows, and the only one most IOS-XE switches have')
    }
    return unsupported()
  }

  // ---- OSPF on an interface: placed once every statement is read, as it depends on the processes and the addresses

  type Setting = { readonly value: string | number; readonly node: IosNode }
  type OspfInterfaceState = { readonly ctx: InterfaceContext; area?: { readonly process: string; readonly area: string; readonly node: IosNode }; readonly settings: Map<string, Setting> }
  /** Per interface reference (`Gi1`, `Gi1.10`): its `ip ospf P area A` and its OSPF settings, by the model's leaf. */
  const ospfInterfaces = new Map<string, OspfInterfaceState>()
  /** A statement whose disposition the end of the text decides (an OSPF setting: mapped only if OSPF runs there). */
  const pending = (): StatementDisposition => mapped([])
  const OSPF_LEAVES: Readonly<Record<string, string>> = { cost: 'cost', network: 'networkType', 'hello-interval': 'helloInterval', 'dead-interval': 'deadInterval', authentication: 'authentication' }

  /**
   * `ip ospf P area A`, `ip ospf cost|network|hello-interval|dead-interval|authentication …` and their `no` forms. A
   * later one supersedes an earlier one. Keys (`authentication-key`, `message-digest-key`) are never carried: the
   * model flags authentication by its type, and a target asks for the key.
   */
  const mapInterfaceOspf = (node: IosNode, ctx: InterfaceContext): StatementDisposition => {
    const lw = node.words.map((x) => x.toLowerCase())
    const remove = lw[0] === 'no'
    const a = lw.slice(remove ? 3 : 2)
    const ref = ctx.isSub ? `${ctx.name}.${ctx.sub}` : ctx.name
    const state: OspfInterfaceState = ospfInterfaces.get(ref) ?? { ctx, settings: new Map() }
    ospfInterfaces.set(ref, state)
    const replace = (leaf: string, value: string | number | null, why: string): StatementDisposition => {
      if (value === null) return unsupported(why)
      const previous = state.settings.get(leaf)
      if (previous) set(previous.node, ignored(`superseded by line ${line(node)}`))
      state.settings.set(leaf, { value, node })
      return pending()
    }
    if (a[0] === 'authentication-key' || a[0] === 'message-digest-key') return ignored(remove ? 'removes an OSPF key, which is never carried: nothing to convert' : 'an OSPF key: never carried, so a target asks for it')
    // A process number as `router ospf` takes it, from 1 to 65535 (`01` is 1).
    const process = INTEGER.test(a[0] ?? '') && a[1] === 'area' ? inRange(a[0], 1, 65535) : null
    if (INTEGER.test(a[0] ?? '') && a[1] === 'area' && process === null) return unsupported('not an OSPF process number from 1 to 65535')
    if (!remove) {
      if (process !== null && a.length === 3) {
        const area = ospfArea(a[2])
        if (area === null) return unsupported('not an OSPF area')
        if (state.area) set(state.area.node, ignored(`superseded by line ${line(node)}`))
        state.area = { process: String(process), area, node }
        return pending()
      }
      if (a.length === 2 && (a[0] === 'cost' || a[0] === 'hello-interval' || a[0] === 'dead-interval')) return replace(OSPF_LEAVES[a[0]], inRange(a[1], 1, 65535), `not an OSPF ${a[0] === 'cost' ? 'cost' : 'interval'} from 1 to 65535`)
      if (a[0] === 'network' && a.length === 2 && (a[1] === 'point-to-point' || a[1] === 'broadcast')) return replace('networkType', a[1], '')
      if (a[0] === 'authentication' && (a.length === 1 || (a.length === 2 && a[1] === 'message-digest') || (a.length === 3 && a[1] === 'key-chain'))) {
        // A key chain's name goes with its keys: the target asks for them.
        return replace('authentication', a.length === 1 ? 'simple' : a[1] === 'message-digest' ? 'md5' : 'key-chain', '')
      }
      return unsupported()
    }
    if (process !== null && a.length <= 3) {
      const previous = state.area
      if (!previous || previous.process !== String(process)) return ignored('not in that OSPF process: nothing to convert')
      state.area = undefined
      set(previous.node, ignored(`removed by line ${line(node)}`))
      return ignored(`removes the OSPF area on line ${line(previous.node)}: nothing to convert`)
    }
    const leaf = Object.hasOwn(OSPF_LEAVES, a[0] ?? '') ? OSPF_LEAVES[a[0]] : undefined
    if (leaf && a.length <= 3) {
      const previous = state.settings.get(leaf)
      if (!previous) return ignored('not set: nothing to convert')
      state.settings.delete(leaf)
      set(previous.node, ignored(`removed by line ${line(node)}`))
      return ignored(`removes the setting on line ${line(previous.node)}: nothing to convert`)
    }
    return unsupported()
  }

  const mapInterfaceChild = (node: IosNode, ctx: InterfaceContext): StatementDisposition => {
    const w = node.words
    const lw = w.map((x) => x.toLowerCase())
    const iface = ['interfaces', ctx.name]
    const sub = [...iface, 'subinterfaces', ctx.sub]
    const own = ctx.isSub ? sub : iface

    if (lw[0] === 'switchport' || (lw[0] === 'no' && lw[1] === 'switchport')) return mapSwitchport(node, ctx)
    const attached = acl.attach(node, sub)
    if (attached) return attached
    if ((lw[0] === 'ip' && lw[1] === 'ospf') || (lw[0] === 'no' && lw[1] === 'ip' && lw[2] === 'ospf')) return mapInterfaceOspf(node, ctx)
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
    // `interface VlanN` routes for VLAN N, on its subinterface 0; IOS has no VLAN interface with a subinterface.
    const svi = interfaceType(ctx.name) === 'irb-or-svi'
    const routed = svi ? vlanId(/\d+$/.exec(ctx.name)?.[0] ?? '') : null
    if (svi && (split || routed === null)) {
      unsupportedTree(node)
      return
    }
    const fields = ensureInterface(ctx.name)
    if (split) model.object(['interfaces', ctx.name, 'subinterfaces', ctx.sub])
    if (routed !== null) {
      fields.push(model.set(['interfaces', ctx.name, 'subinterfaces', '0', 'routedVlan'], routed))
      svis.set(ctx.name, [...(svis.get(ctx.name) ?? []), node])
    }
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
  /** A VRF's `import map NAME` or `export map NAME` (model 0.5.2), in a scope: a later one each way replaces the earlier. */
  type VrfMap = { readonly node: IosNode; readonly name: string; readonly direction: 'import' | 'export' }
  type Scope = { unconverted?: IosNode; readonly maps: Map<'import' | 'export', VrfMap> }
  type Family = Scope & { readonly statements: IosNode[]; readonly targets: RouteTarget[] }
  type VrfState = Scope & { readonly definitions: IosNode[]; readonly common: RouteTarget[]; readonly families: Map<'ipv4' | 'ipv6', Family> }
  const vrfs = new Map<string, VrfState>()
  const vrfState = (instance: string): VrfState => {
    const state = vrfs.get(instance) ?? { definitions: [], common: [], families: new Map(), maps: new Map() }
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

  /** Whether a statement is `[no] import|export map [NAME]`. */
  const isVrfMap = (node: IosNode): boolean => {
    const lw = node.words.map((x) => x.toLowerCase())
    const remove = lw[0] === 'no'
    return (lw[remove ? 1 : 0] === 'import' || lw[remove ? 1 : 0] === 'export') && lw[remove ? 2 : 1] === 'map' && (remove ? lw.length <= 4 : lw.length === 3)
  }
  /** `[no] import|export map [NAME]` (isVrfMap()), VRF-wide or in an address family: the scope's map that way. */
  const mapVrfMap = (node: IosNode, scope: Scope): StatementDisposition => {
    const w = node.words
    const lw = w.map((x) => x.toLowerCase())
    const remove = lw[0] === 'no'
    const direction = lw[remove ? 1 : 0] as 'import' | 'export'
    const previous = scope.maps.get(direction)
    if (remove) {
      if (!previous || (w.length === 4 && w[3] !== previous.name)) return ignored('no such map: nothing to convert')
      scope.maps.delete(direction)
      set(previous.node, ignored(`removed by line ${line(node)}`))
      return ignored(`removes the map on line ${line(previous.node)}: nothing to convert`)
    }
    if (previous) set(previous.node, ignored(`superseded by line ${line(node)}`))
    scope.maps.set(direction, { node, name: w[2], direction })
    return mapped([])
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
      else if (leaf && isVrfMap(child)) set(child, mapVrfMap(child, state))
      else if (!legacy && leaf && lw[0] === 'no' && lw[1] === 'address-family' && (lw[2] === 'ipv4' || lw[2] === 'ipv6') && (cw.length === 3 || (cw.length === 4 && lw[3] === 'unicast'))) set(child, removeFamily(child, instance, lw[2]))
      else if (!legacy && child.kind === 'statement' && lw[0] === 'address-family' && (lw[1] === 'ipv4' || lw[1] === 'ipv6') && (cw.length === 2 || (cw.length === 3 && lw[2] === 'unicast'))) {
        const family: Family = state.families.get(lw[1]) ?? { statements: [], targets: [], maps: new Map() }
        state.families.set(lw[1], family)
        family.statements.push(child)
        const targets = family.targets
        set(child, ignored('an address family of the VRF: the model\'s VRFs carry every family, and a render writes the ones its addresses and routes need'))
        for (const c of child.children) {
          const clw = c.words.map((x) => x.toLowerCase())
          if (c.kind === 'comment') set(c, ignored('a comment'))
          else if (c.kind === 'statement' && !c.children.length && (clw[0] === 'route-target' || (clw[0] === 'no' && clw[1] === 'route-target'))) mapRouteTarget(c, family, targets)
          else if (c.kind === 'statement' && !c.children.length && clw[0] === 'exit-address-family' && c.words.length === 1) set(c, ignored('ends the address family'))
          else if (c.kind === 'statement' && !c.children.length && isVrfMap(c)) set(c, mapVrfMap(c, family))
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

  // ---- VLANs

  /** Each `vlan …` statement and the VLANs it still defines (`no vlan` can take some of a list's). */
  const vlanStatements = new Map<IosNode, Set<number>>()
  /** VLANs `no vlan` deleted and no later `vlan` defined again, by the statement that deleted them. */
  const deletions = new Map<number, IosNode>()

  /** `vlan N` (or a list, `vlan 100,3000`, `vlan 10-20`): the VLANs, and a single one's `name`. */
  const mapVlan = (node: IosNode): void => {
    const ids = node.words.length > 1 ? readVlanList(node.words.slice(1).join('')) : null
    if (!ids) return unsupportedTree(node)
    vlanStatements.set(node, ids)
    set(node, mapped([...ids].map((id) => fieldPath('vlans', String(id)))))
    for (const id of ids) {
      model.object(['vlans', String(id)])
      deletions.delete(id)
      createdBy.delete(id)
    }
    const [only] = ids.size === 1 ? ids : []
    for (const child of node.children) {
      const cw = child.words
      const lw = cw.map((x) => x.toLowerCase())
      const leaf = child.kind === 'statement' && !child.children.length
      const name = ['vlans', String(only), 'name']
      if (child.kind === 'comment') set(child, ignored('a comment'))
      else if (leaf && lw[0] === 'exit' && cw.length === 1) set(child, ignored('ends the VLAN\'s configuration mode'))
      else if (only !== undefined && leaf && lw[0] === 'name' && cw.length === 2) {
        claim(fieldPath(...name), child)
        set(child, mapped([model.set(name, cw[1])]))
      } else if (only !== undefined && leaf && lw[0] === 'no' && lw[1] === 'name' && cw.length <= 3) {
        const previous = owners.get(fieldPath(...name))
        owners.delete(fieldPath(...name))
        model.remove(name)
        if (previous) set(previous, ignored(`removed by line ${line(child)}`))
        set(child, ignored(previous ? `removes the name on line ${line(previous)}: nothing to convert` : 'no name to remove: nothing to convert'))
      } else unsupportedTree(child)
    }
  }

  /** `no vlan N` (or a list): those VLANs and their names go; IOS keeps its default VLANs. */
  const removeVlans = (node: IosNode): StatementDisposition => {
    const ids = node.words.length > 2 ? readVlanList(node.words.slice(2).join('')) : null
    if (!ids) return unsupported('not a list of VLAN IDs from 1 to 4094')
    const lines: number[] = []
    for (const id of ids) {
      if (DEFAULT_VLANS.has(id)) continue
      deletions.set(id, node)
      const creator = createdBy.get(id)
      if (creator) lines.push(line(creator))
      createdBy.delete(id)
      for (const [n, defined] of vlanStatements) {
        if (!defined.delete(id)) continue
        lines.push(line(n))
        if (defined.size) set(n, mapped([...defined].map((d) => fieldPath('vlans', String(d)))))
        else {
          const why = ignored(`removed by line ${line(node)}`)
          set(n, why)
          for (const child of n.children) if (dispositions[child.id]?.kind !== 'unsupported' && child.kind !== 'comment') set(child, why)
          vlanStatements.delete(n)
        }
      }
      owners.delete(fieldPath('vlans', String(id), 'name'))
      model.remove(['vlans', String(id)])
    }
    model.removeIfEmpty(['vlans'])
    if (!lines.length) return ignored([...ids].every((id) => DEFAULT_VLANS.has(id)) ? 'IOS can\'t delete a default VLAN: nothing to convert' : 'no such VLAN: nothing to convert')
    return ignored(`removes the VLANs of ${linesText([...new Set(lines)].sort((a, b) => a - b))}: nothing to convert`)
  }

  // ---- OSPF processes: read here, placed in the model once every statement is read

  type OspfNetwork = { readonly node: IosNode; readonly address: number; readonly wildcard: number; readonly area: string }
  type OspfProcess = {
    readonly id: string
    readonly vrf?: string
    /** Its `router ospf` statements, and every statement in them, so `no router ospf` can remove them. */
    readonly nodes: IosNode[]
    routerId?: Setting
    readonly networks: OspfNetwork[]
    passiveDefault?: IosNode
    /** `passive-interface X`, and `no passive-interface X` under `passive-interface default`, by reference. */
    readonly passive: Map<string, IosNode>
    readonly active: Map<string, IosNode>
    /** Per area: its type and authentication (`area 1 stub`, `area 0 authentication message-digest`). */
    readonly areas: Map<string, Map<string, Setting>>
  }
  const ospfProcesses = new Map<string, OspfProcess>()

  /** `router ospf P [vrf V]` and what is in it. */
  const mapRouterOspf = (node: IosNode): void => {
    const w = node.words
    const lw = w.map((x) => x.toLowerCase())
    if (inRange(w[2], 1, 65535) === null || !(w.length === 3 || (w.length === 5 && lw[3] === 'vrf'))) return unsupportedTree(node)
    const id = String(Number(w[2]))
    const vrf = w.length === 5 ? vrfName(w[4]) : undefined
    const process: OspfProcess = ospfProcesses.get(id) ?? { id, ...(vrf !== undefined ? { vrf } : {}), nodes: [], networks: [], passive: new Map(), active: new Map(), areas: new Map() }
    // The same process named again in another VRF: IOS refuses it.
    if (process.vrf !== vrf) return unsupportedTree(node)
    ospfProcesses.set(id, process)
    process.nodes.push(node)
    set(node, pending())
    const areaSetting = (area: string, key: string, value: string | undefined, child: IosNode) => {
      const settings = process.areas.get(area) ?? new Map<string, Setting>()
      process.areas.set(area, settings)
      const previous = settings.get(key)
      if (value === undefined) {
        settings.delete(key)
        if (previous) set(previous.node, ignored(`removed by line ${line(child)}`))
        return set(child, ignored(previous ? `removes the setting on line ${line(previous.node)}: nothing to convert` : 'not set: nothing to convert'))
      }
      if (previous) set(previous.node, ignored(`superseded by line ${line(child)}`))
      settings.set(key, { value, node: child })
      set(child, pending())
    }
    for (const child of node.children) {
      const cw = child.words
      const c = cw.map((x) => x.toLowerCase())
      const remove = c[0] === 'no'
      const a = c.slice(remove ? 1 : 0)
      const leaf = child.kind === 'statement' && !child.children.length
      if (child.kind === 'comment') {
        set(child, ignored('a comment'))
        continue
      }
      process.nodes.push(child)
      if (!leaf) unsupportedTree(child)
      else if (a[0] === 'router-id' && !remove && a.length === 2 && isIpv4(cw[1])) {
        if (process.routerId) set(process.routerId.node, ignored(`superseded by line ${line(child)}`))
        process.routerId = { value: cw[1], node: child }
        set(child, pending())
      } else if (a[0] === 'router-id' && remove && a.length <= 2) {
        const previous = process.routerId
        process.routerId = undefined
        if (previous) set(previous.node, ignored(`removed by line ${line(child)}`))
        set(child, ignored(previous ? `removes the router ID on line ${line(previous.node)}: nothing to convert` : 'no router ID to remove: nothing to convert'))
      } else if (a[0] === 'network' && a.length === 5 && a[3] === 'area') {
        const [address, wildcard] = [cw[remove ? 2 : 1], cw[remove ? 3 : 2]]
        const area = ospfArea(a[4])
        if (!isIpv4(address) || !isIpv4(wildcard) || area === null) {
          set(child, unsupported(remove ? undefined : 'not a network statement with an address, a wildcard mask and an area'))
          continue
        }
        const network = { node: child, address: ipv4Number(address), wildcard: ipv4Number(wildcard), area }
        if (!remove) {
          process.networks.push(network)
          set(child, pending())
          continue
        }
        const removed = process.networks.filter((n) => n.address === network.address && n.wildcard === network.wildcard && n.area === area)
        for (const n of removed) set(n.node, ignored(`removed by line ${line(child)}`))
        process.networks.splice(0, process.networks.length, ...process.networks.filter((n) => !removed.includes(n)))
        set(child, ignored(removed.length ? `removes the network statement on ${linesText(removed.map((n) => line(n.node)))}: nothing to convert` : 'no such network statement: nothing to convert'))
      } else if (a[0] === 'passive-interface' && a[1] === 'default' && a.length === 2) {
        const previous = [...(process.passiveDefault ? [process.passiveDefault] : []), ...process.passive.values(), ...process.active.values()]
        for (const n of previous) set(n, ignored(`${remove ? 'removed' : 'superseded'} by line ${line(child)}`))
        process.passive.clear()
        process.active.clear()
        process.passiveDefault = remove ? undefined : child
        set(child, remove ? ignored('makes every interface active again, as the model has them unless passive: nothing to convert') : pending())
      } else if (a[0] === 'passive-interface' && a.length >= 2) {
        const n = interfaceName(cw, remove ? 2 : 1)
        if (!n || (remove ? 2 : 1) + n.used !== cw.length) {
          set(child, unsupported())
          continue
        }
        const previous = process.passive.get(n.name) ?? process.active.get(n.name)
        if (previous) set(previous, ignored(`${remove && process.passive.has(n.name) ? 'removed' : 'superseded'} by line ${line(child)}`))
        process.passive.delete(n.name)
        process.active.delete(n.name)
        if (!remove) process.passive.set(n.name, child)
        else if (process.passiveDefault) process.active.set(n.name, child)
        set(child, remove ? ignored(process.passiveDefault ? 'keeps the interface active under "passive-interface default", as the model has it by leaving passive out' : 'makes the interface active, as the model has it unless passive: nothing to convert') : pending())
      } else if (a[0] === 'area' && a.length === 3 && (a[2] === 'stub' || a[2] === 'nssa') && ospfArea(a[1]) !== null) areaSetting(ospfArea(a[1])!, 'type', remove ? undefined : a[2], child)
      else if (a[0] === 'area' && a[2] === 'authentication' && ospfArea(a[1]) !== null && (a.length === 3 || (a.length === 4 && a[3] === 'message-digest'))) areaSetting(ospfArea(a[1])!, 'authentication', remove ? undefined : a.length === 3 ? 'simple' : 'md5', child)
      else if (a[0] === 'exit' && a.length === 1 && !remove) set(child, ignored('ends the OSPF configuration mode'))
      else set(child, unsupported())
    }
  }

  /** `no router ospf P`: the process, everything in it, and every interface's `ip ospf P area`, as the device removes them. */
  const removeRouterOspf = (node: IosNode): StatementDisposition => {
    const id = inRange(node.words[3], 1, 65535)
    if (id === null || node.words.length !== 4) return unsupported()
    const process = ospfProcesses.get(String(id))
    const why = ignored(`removed by line ${line(node)}`)
    const lines: number[] = []
    for (const n of process?.nodes ?? []) {
      set(n, why)
      lines.push(line(n))
    }
    ospfProcesses.delete(String(id))
    for (const state of ospfInterfaces.values()) {
      if (state.area?.process !== String(id)) continue
      set(state.area.node, why)
      lines.push(line(state.area.node))
      state.area = undefined
    }
    return ignored(lines.length ? `removes the OSPF process and its interfaces (${linesText(lines.sort((x, y) => x - y))}): nothing to convert` : 'no such OSPF process: nothing to convert')
  }

  // ---- BGP

  const BGP_FAMILIES: Readonly<Record<string, 'ipv4-unicast' | 'ipv6-unicast'>> = { ipv4: 'ipv4-unicast', ipv6: 'ipv6-unicast' }
  /** The router's AS (`router bgp ASN`): IOS runs one, and every VRF's BGP is in it. */
  let bgpAs: number | undefined
  /** `no bgp default ipv4-unicast`: neighbors carry IPv4 only where `neighbor X activate` says so. */
  let noDefaultIpv4: IosNode | undefined
  /** The `router bgp` statements, so `no router bgp` can remove them with everything in them. */
  const bgpNodes: IosNode[] = []
  /** Each peer's statements, by `instance|kind|key`, so `no neighbor X` can remove them. */
  type Peer = { readonly instance: string; readonly kind: 'groups' | 'neighbors'; readonly key: string; readonly nodes: IosNode[]; readonly families: Map<'ipv4-unicast' | 'ipv6-unicast', PeerFamily> }
  /**
   * A peer's address family as read: activated (`neighbor X activate`, or by being defined in a VRF's family), taken
   * out (`no neighbor X activate`), and its route maps. The model's `addressFamilies` is built from it once every
   * statement is read, as a family is there only when the peer carries it: a route map alone activates nothing.
   */
  type PeerFamily = { activate?: IosNode; auto?: IosNode; deactivate?: IosNode; readonly policies: Map<'importPolicies' | 'exportPolicies', { readonly name: string; readonly node: IosNode }> }
  const peers = new Map<string, Peer>()
  /** Update sources, checked once every interface is read: a source that isn't one of them is left out. */
  const updateSources: { readonly path: Segments; readonly node: IosNode }[] = []

  /** A neighbor's key (`192.0.2.2`, an IPv6 address in lower case) or a peer group's name, with its kind. */
  const peerOf = (instance: string, word: string): Peer => {
    const v6 = isIpv6(word)
    const kind = v6 || isIpv4(word) ? 'neighbors' : 'groups'
    const key = v6 ? word.toLowerCase() : word
    const id = `${instance}|${kind}|${key}`
    const peer: Peer = peers.get(id) ?? { instance, kind, key, nodes: [], families: new Map() }
    peers.set(id, peer)
    return peer
  }

  /**
   * `neighbor X …` in `router bgp` (the global table and IPv4) or in an address family (`vrf V`: that VRF's), and its
   * `no` forms. `no neighbor X` and `no neighbor X remote-as` remove the peer and everything about it, as the device does.
   */
  const mapNeighbor = (node: IosNode, instance: string, family: 'ipv4-unicast' | 'ipv6-unicast'): StatementDisposition => {
    const w = node.words
    const lw = w.map((x) => x.toLowerCase())
    const remove = lw[0] === 'no'
    const i = remove ? 1 : 0
    const a = lw.slice(i + 2)
    if (w[i + 1] === undefined) return unsupported()
    const peer = peerOf(instance, w[i + 1])
    const base = ['networkInstances', instance, 'bgp', peer.kind, peer.key]
    const exists = model.get(base) !== undefined
    const group = peer.kind === 'groups'
    const setting = (path: Segments, value: unknown): StatementDisposition => {
      claim(fieldPath(...path), node, () => model.remove(path))
      peer.nodes.push(node)
      return mapped([model.set(path, value)])
    }
    const familyState = (): PeerFamily => {
      const f = peer.families.get(family) ?? { policies: new Map() }
      peer.families.set(family, f)
      return f
    }
    const direction = a[0] === 'route-map' && a.length === 3 && (a[2] === 'in' || a[2] === 'out') ? (a[2] === 'in' ? 'importPolicies' : 'exportPolicies') : undefined

    if (remove) {
      if (!exists) return ignored('no such neighbor: nothing to convert')
      const whole = !a.length || (a[0] === 'remote-as' && a.length <= 2) || (group && a[0] === 'peer-group' && a.length === 1)
      if (whole) {
        const why = ignored(`removed by line ${line(node)}`)
        const removed = [peer, ...(group ? [...peers.values()].filter((p) => p.instance === instance && p.kind === 'neighbors' && model.get(['networkInstances', instance, 'bgp', 'neighbors', p.key, 'group']) === peer.key) : [])]
        // A peer group's members go with it, as on the device.
        for (const p of removed) {
          for (const n of p.nodes) set(n, why)
          model.remove(['networkInstances', instance, 'bgp', p.kind, p.key])
          peers.delete(`${instance}|${p.kind}|${p.key}`)
        }
        for (const kind of ['groups', 'neighbors']) model.removeIfEmpty(['networkInstances', instance, 'bgp', kind])
        return ignored(`removes the ${group ? 'peer group' : 'neighbor'} configured on ${linesText([...new Set(removed.flatMap((p) => p.nodes.map(line)))].sort((x, y) => x - y))}: nothing to convert`)
      }
      const leaf = a[0] === 'description' ? 'description' : a[0] === 'update-source' ? 'updateSource' : a[0] === 'ebgp-multihop' ? 'multihop' : a[0] === 'password' ? 'authentication' : !group && a[0] === 'peer-group' ? 'group' : undefined
      if (a[0] === 'activate' && a.length === 1) {
        // The neighbor leaves the family, and its configuration there goes with it, as on the device. Under `bgp default
        // ipv4-unicast`, this also keeps it out of IPv4.
        const f = familyState()
        const why = ignored(`removed by line ${line(node)}, which takes the neighbor out of the address family`)
        for (const n of [f.activate, ...[...f.policies.values()].map((p) => p.node)]) if (n) set(n, why)
        f.activate = undefined
        f.auto = undefined
        f.policies.clear()
        f.deactivate = node
        peer.nodes.push(node)
        return ignored('takes the neighbor out of the address family, which the model says by leaving the family out')
      }
      if (direction) {
        const f = familyState()
        const previous = f.policies.get(direction)
        if (!previous) return ignored('no such route map: nothing to convert')
        f.policies.delete(direction)
        set(previous.node, ignored(`removed by line ${line(node)}`))
        return ignored(`removes the route map on line ${line(previous.node)}: nothing to convert`)
      }
      const path: Segments | undefined = leaf ? [...base, leaf] : undefined
      if (!path) return unsupported()
      const previous = owners.get(fieldPath(...path))
      owners.delete(fieldPath(...path))
      if (model.get(path) === undefined) return ignored('not set: nothing to convert')
      model.remove(path)
      if (previous) set(previous, ignored(`removed by line ${line(node)}`))
      return ignored(`removes the setting${previous ? ` on line ${line(previous)}` : ''}: nothing to convert`)
    }

    if (group && a[0] === 'peer-group' && a.length === 1) {
      peer.nodes.push(node)
      model.object(base)
      return mapped([fieldPath(...base)])
    }
    // A peer group is defined (`neighbor G peer-group`) before it is used, or IOS refuses the statement.
    if (group && !exists) return unsupported('names a peer group the configuration doesn\'t define')
    if (a[0] === 'remote-as' && a.length === 2) {
      const as = asNumber(a[1])
      if (as === null) return unsupported('not an AS number from 1 to 4294967295')
      // A neighbor defined in a VRF's address family carries it.
      if (instance !== 'default' && !group) {
        const f = familyState()
        f.auto = node
        f.deactivate = undefined
      }
      return setting([...base, 'peerAs'], as)
    }
    if (!group && a[0] === 'peer-group' && a.length === 2) {
      const name = w[i + 3]
      if (model.get(['networkInstances', instance, 'bgp', 'groups', name]) === undefined) return unsupported('names a peer group the configuration doesn\'t define')
      return setting([...base, 'group'], name)
    }
    if (a[0] === 'description' && a.length > 1) return setting([...base, 'description'], node.text.replace(/^\s*(?:\S+\s+){3}/, ''))
    if (a[0] === 'update-source' && a.length >= 2) {
      const n = interfaceName(w, i + 3)
      if (!n || i + 3 + n.used !== w.length) return unsupported()
      updateSources.push({ path: [...base, 'updateSource'], node })
      return setting([...base, 'updateSource'], n.name)
    }
    if (a[0] === 'ebgp-multihop' && a.length <= 2) {
      const ttl = a.length === 2 ? inRange(a[1], 1, 255) : undefined
      if (ttl === null) return unsupported('not a hop count from 1 to 255')
      model.remove([...base, 'multihop'])
      return setting([...base, 'multihop'], ttl === undefined ? {} : { ttl })
    }
    // The password itself is never carried: the model flags it, and a target asks for it.
    if (a[0] === 'password' && a.length >= 2) return setting([...base, 'authentication'], true)
    if (a[0] === 'activate' && a.length === 1) {
      const f = familyState()
      peer.nodes.push(node)
      if (f.activate) return ignored(`already active in the address family (line ${line(f.activate)})`)
      f.activate = node
      f.deactivate = undefined
      return pending()
    }
    if (direction) {
      // IOS has one route map a direction: a later one replaces it. It names a route map, resolved once the text is read.
      const f = familyState()
      const previous = f.policies.get(direction)
      if (previous) set(previous.node, ignored(`superseded by line ${line(node)}`))
      f.policies.set(direction, { name: w[i + 3], node })
      peer.nodes.push(node)
      return pending()
    }
    return unsupported()
  }

  /** `router bgp ASN` and what is in it: the global table's BGP, and each VRF's in `address-family ipv4|ipv6 vrf V`. */
  const mapRouterBgp = (node: IosNode): void => {
    const as = node.words.length === 3 ? asNumber(node.words[2]) : null
    // IOS runs one BGP AS: a second is refused.
    if (as === null || (bgpAs !== undefined && bgpAs !== as)) return unsupportedTree(node)
    bgpAs = as
    bgpNodes.push(node)
    set(node, mapped([model.set(['networkInstances', 'default', 'bgp', 'localAs'], as)]))
    const routerId = (child: IosNode, instance: string) => {
      const path = ['networkInstances', instance, 'bgp', 'routerId']
      claim(fieldPath(...path), child, () => model.remove(path))
      return mapped([model.set(path, child.words[2])])
    }
    const statement = (child: IosNode, instance: string, family: 'ipv4-unicast' | 'ipv6-unicast'): StatementDisposition => {
      const c = child.words.map((x) => x.toLowerCase())
      const a = c[0] === 'no' ? c.slice(1) : c
      if (a[0] === 'neighbor') return mapNeighbor(child, instance, family)
      if (c[0] === 'bgp' && c[1] === 'router-id' && c.length === 3 && isIpv4(child.words[2])) return routerId(child, instance)
      return unsupported()
    }
    for (const child of node.children) {
      const cw = child.words
      const c = cw.map((x) => x.toLowerCase())
      const leaf = child.kind === 'statement' && !child.children.length
      if (child.kind === 'comment') set(child, ignored('a comment'))
      else if (c[0] === 'address-family' && (c[1] === 'ipv4' || c[1] === 'ipv6') && child.kind === 'statement') {
        const rest = c.slice(c[2] === 'unicast' ? 3 : 2)
        const family = BGP_FAMILIES[c[1]]
        const vrf = rest[0] === 'vrf' && rest.length === 2 ? cw[cw.length - 1] : undefined
        // A VRF's BGP needs the VRF defined, as on the device.
        if ((rest.length && vrf === undefined) || (vrf !== undefined && !vrfs.get(vrf)?.definitions.length)) {
          unsupportedTree(child)
          continue
        }
        const instance = vrf ?? 'default'
        set(child, vrf !== undefined ? mapped([model.set(['networkInstances', instance, 'bgp', 'localAs'], as)]) : ignored('an address family: the model lists the families each neighbor carries'))
        for (const g of child.children) {
          const gl = g.words.map((x) => x.toLowerCase())
          if (g.kind === 'comment') set(g, ignored('a comment'))
          else if (g.kind !== 'statement' || g.children.length) unsupportedTree(g)
          else if (gl[0] === 'exit-address-family' && gl.length === 1) set(g, ignored('ends the address family'))
          else set(g, statement(g, instance, family))
        }
      } else if (!leaf) unsupportedTree(child)
      else if (c[0] === 'no' && c[1] === 'bgp' && c[2] === 'default' && c[3] === 'ipv4-unicast' && c.length === 4) {
        noDefaultIpv4 = child
        set(child, ignored('neighbors carry IPv4 where "neighbor … activate" says so, which the model lists for each'))
      } else if (c[0] === 'bgp' && c[1] === 'default' && c[2] === 'ipv4-unicast' && c.length === 3) {
        if (noDefaultIpv4) set(noDefaultIpv4, ignored(`superseded by line ${line(child)}`))
        noDefaultIpv4 = undefined
        set(child, ignored('IOS\'s default: every neighbor carries IPv4 unless it says otherwise, which the model lists for each'))
      } else if (c[0] === 'bgp' && c[1] === 'log-neighbor-changes' && c.length === 2) set(child, ignored('logs neighbor changes, as IOS does by default: nothing to convert'))
      else set(child, statement(child, 'default', 'ipv4-unicast'))
    }
  }

  /** `no router bgp ASN`: BGP in every instance, and everything configured for it. */
  const removeRouterBgp = (node: IosNode): StatementDisposition => {
    const as = node.words.length === 4 ? asNumber(node.words[3]) : null
    if (as === null) return unsupported()
    if (as !== bgpAs) return ignored('no such BGP AS: nothing to convert')
    const why = ignored(`removed by line ${line(node)}`)
    const all = (n: IosNode): IosNode[] => [n, ...n.children.flatMap(all)]
    const removed = bgpNodes.flatMap(all).filter((n) => n.kind !== 'comment')
    for (const n of removed) set(n, why)
    for (const [instance] of Object.entries((model.root as Device).networkInstances ?? {})) {
      model.remove(['networkInstances', instance, 'bgp'])
      model.removeIfEmpty(['networkInstances', instance])
    }
    model.removeIfEmpty(['networkInstances'])
    // Deleting while iterating a Map is safe: the iteration skips what is gone.
    for (const key of owners.keys()) if (/\.bgp[.[]/.test(key)) owners.delete(key)
    peers.clear()
    bgpNodes.length = 0
    bgpAs = undefined
    noDefaultIpv4 = undefined
    return ignored(`removes BGP and everything in it (${linesText([...new Set(removed.map(line))])}): nothing to convert`)
  }

  // ---- the top level

  const mapTop = (node: IosNode): void => {
    if (node.kind === 'comment') return set(node, ignored('a comment'))
    const lines = node.span.endLine - node.span.startLine + 1
    if (node.kind === 'banner') return set(node, unsupported(`a ${BANNER_TYPES.has(node.words[1]?.toLowerCase()) ? node.words[1].toLowerCase() : 'motd'} banner, ${lines} line${lines === 1 ? '' : 's'}, kept verbatim`))
    if (node.kind === 'certificate-chain') return set(node, unsupported(`certificate chain ${node.words[4] ?? ''}, ${lines} lines, kept verbatim`))

    if (policy.top(node) || acl.top(node)) return
    const w = node.words
    const lw = w.map((x) => x.toLowerCase())
    if (lw[0] === 'interface') return mapInterface(node)
    if (lw[0] === 'vrf' && lw[1] === 'definition') return mapVrfDefinition(node, false)
    if (lw[0] === 'ip' && lw[1] === 'vrf' && w.length === 3) return mapVrfDefinition(node, true)
    if (lw[0] === 'no' && lw[1] === 'vrf' && lw[2] === 'definition' && !node.children.length) return set(node, removeVrfDefinition(node))
    if (lw[0] === 'no' && lw[1] === 'ip' && lw[2] === 'vrf' && !node.children.length) return set(node, removeVrfDefinition(node))
    if (lw[0] === 'vlan' && /^\d/.test(w[1] ?? '')) return mapVlan(node)
    if (lw[0] === 'router' && lw[1] === 'ospf') return mapRouterOspf(node)
    if (lw[0] === 'router' && lw[1] === 'bgp') return mapRouterBgp(node)
    if (lw[0] === 'no' && lw[1] === 'router' && lw[2] === 'ospf' && !node.children.length) return set(node, removeRouterOspf(node))
    if (lw[0] === 'no' && lw[1] === 'router' && lw[2] === 'bgp' && !node.children.length) return set(node, removeRouterBgp(node))
    if (lw[0] === 'no' && lw[1] === 'vlan' && /^\d/.test(w[2] ?? '') && !node.children.length) return set(node, removeVlans(node))

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
    else if (lw[0] === 'exit' && w.length === 1) d = ignored('leaves a configuration mode: nothing to convert')
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

  // Routing policy (model 0.5.0), once every list a route map names is read; BGP's route maps resolve to it below.
  const routingPolicy = policy.finish()
  if (routingPolicy) model.set(['routingPolicy'], routingPolicy)
  /** Why a BGP route map can't be kept, or undefined when it names a policy of the model. */
  const policyProblem = (name: string): string | undefined => {
    if (routingPolicy?.policies && Object.hasOwn(routingPolicy.policies, name)) return undefined
    return policy.definesRouteMap(name) ? 'names a route map that isn\'t converted' : 'names a route map the configuration doesn\'t define: IOS denies every route then, which the model can\'t say'
  }

  // A community with a statement not converted anywhere in the text (an access list, a view) is left out whole: mapped
  // without it, it would answer clients, or allow access, the source doesn't.
  for (const [name, state] of communities) {
    if (!state.unconverted) continue
    model.remove(['system', 'snmp', 'communities', name])
    for (const up of [['system', 'snmp', 'communities'], ['system', 'snmp'], ['system']]) model.removeIfEmpty(up)
    for (const n of state.nodes) if (dispositions[n.id]?.kind === 'mapped') set(n, unsupported(`left out whole: line ${line(state.unconverted)} about the same community isn't converted, and may limit or change it`))
  }

  // A VRF's own import and export maps (model 0.5.2): one each way in the model, so every address family's (its own, or
  // else the VRF-wide one) must name the same, and a route map that is converted. IOS's map filters after the route
  // targets (`after-route-targets`). One that can't be kept changes what the route targets import or export, so they are
  // left out with it (below), as before model 0.5.2; and the maps go with the route targets when those are left out.
  const vrfMaps = new Map<string, { readonly maps: VrfMap[]; readonly chosen: Partial<Record<'import' | 'export', string>> }>()
  for (const [instance, state] of vrfs) {
    const maps = [...state.maps.values(), ...[...state.families.values()].flatMap((f) => [...f.maps.values()])]
    if (!maps.length || model.get(['networkInstances', instance]) === undefined) continue
    const families = [...state.families.values()]
    const chosen: Partial<Record<'import' | 'export', string>> = {}
    let why: string | undefined
    for (const direction of ['import', 'export'] as const) {
      const names = families.length ? families.map((f) => (f.maps.get(direction) ?? state.maps.get(direction))?.name) : [state.maps.get(direction)?.name]
      if (new Set(names).size > 1) why ??= 'maps that differ between the address families: the model holds one each way for the VRF'
      else if (names[0] !== undefined) chosen[direction] = names[0]
    }
    for (const name of Object.values(chosen)) if (!why && !(routingPolicy?.policies && Object.hasOwn(routingPolicy.policies, name))) why = policy.definesRouteMap(name) ? 'names a route map that isn\'t converted' : 'names a route map the configuration doesn\'t define'
    if (why) {
      for (const m of maps) set(m.node, unsupported(why))
      state.unconverted ??= maps.map((m) => m.node).sort((a, b) => line(a) - line(b))[0]
      continue
    }
    vrfMaps.set(instance, { maps, chosen })
  }
  /** Each VRF's maps that can be kept, put in the model once its route targets are (they go together). */
  const keepVrfMaps = (instance: string, state: VrfState, leftOut?: string) => {
    const kept = vrfMaps.get(instance)
    if (!kept) return
    if (leftOut) {
      for (const m of kept.maps) set(m.node, unsupported(`left out with the VRF's route targets: ${leftOut}`))
      return
    }
    const at = ['networkInstances', instance]
    const mode = model.set([...at, 'vrfPolicyMode'], 'after-route-targets')
    const fields: Partial<Record<'import' | 'export', string>> = {}
    for (const direction of ['import', 'export'] as const) if (kept.chosen[direction] !== undefined) fields[direction] = model.set([...at, direction === 'import' ? 'importPolicies' : 'exportPolicies'], [kept.chosen[direction]])
    const families = [...state.families.values()]
    for (const m of kept.maps) {
      // A VRF-wide map every family overrides with its own isn't used.
      const overridden = families.length > 0 && state.maps.get(m.direction) === m && families.every((f) => f.maps.has(m.direction))
      set(m.node, overridden ? ignored('overridden by the address families\' own maps') : mapped([fields[m.direction]!, mode]))
    }
  }

  // A VRF's route targets: one set in the model, so every address family's (each with the VRF-wide ones) must agree as
  // sets (a family with none disagrees with one with some), and none may be left out.
  for (const [instance, state] of vrfs) {
    const own = [...state.families.values()].map((f) => f.targets)
    const all = [...state.common, ...own.flat()]
    if (model.get(['networkInstances', instance]) === undefined) continue
    if (!all.length) {
      keepVrfMaps(instance, state)
      continue
    }
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
      keepVrfMaps(instance, state, why.replace(/^left out whole: /, ''))
      continue
    }
    keepVrfMaps(instance, state)
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

  // VLANs a switch port or VLAN interface uses that the text doesn't define (a switch in VTP server mode keeps its VLANs
  // out of the configuration, and IOS creates an access VLAN a port names, as it was read): kept as VLANs with no name,
  // mapped by the first statement that uses (or created) them, which a render writes. A warning says so, by field
  // (value-free), except for VLAN 1, which IOS always has and never writes.
  //
  // A VLAN `no vlan` deleted (and nothing created or defined again since) is another matter: the device has no such
  // VLAN, its ports are inactive and its VLAN interface is down, which the model can't say, so they are left out rather
  // than the VLAN brought back.
  const uses = new Map<number, IosNode>(createdBy)
  const use = (id: unknown, node: IosNode | undefined) => {
    if (typeof id === 'number' && node && !uses.has(id)) uses.set(id, node)
  }
  /** The `no vlan` that deleted VLAN `id`, when it is still gone. */
  const deletedBy = (id: unknown): IosNode | undefined => (typeof id === 'number' ? deletions.get(id) : undefined)
  for (const [name, iface] of Object.entries((model.root as Device).interfaces ?? {})) {
    const s = iface.switching
    const owner = (leaf: string) => owners.get(fieldPath('interfaces', name, 'switching', leaf))
    const trunk = trunks.get(name)
    const lastTrunk = trunk?.nodes[trunk.nodes.length - 1]
    const singles = (s?.allowedVlans ?? []).filter((entry) => INTEGER.test(entry)).map(Number)
    const routed = iface.subinterfaces?.['0']?.routedVlan
    const svi = svis.get(name) ?? []
    const routedGone = deletedBy(routed)
    if (routedGone) {
      // The VLAN interface of a deleted VLAN: left out whole, with its addresses.
      model.remove(['interfaces', name])
      model.removeIfEmpty(['interfaces'])
      const why = unsupported(`left out whole: it routes for a VLAN line ${line(routedGone)} deletes`)
      const all = (n: IosNode): IosNode[] => [n, ...n.children.flatMap(all)]
      for (const n of svi.flatMap(all)) if (n.kind !== 'comment') set(n, why)
      continue
    }
    const switchGone = deletedBy(s?.accessVlan) ?? deletedBy(s?.nativeVlan) ?? singles.map(deletedBy).find((d) => d !== undefined)
    if (switchGone) {
      // A switch port in a deleted VLAN: left out whole, as an access VLAN or allowed list without it would carry other
      // VLANs than the device does.
      model.remove(['interfaces', name, 'switching'])
      for (const n of switchports.get(name) ?? []) if (dispositions[n.id]?.kind === 'mapped') set(n, unsupported(`left out whole: the switch port uses a VLAN line ${line(switchGone)} deletes`))
      continue
    }
    use(routed, svi[0])
    use(s?.accessVlan, owner('accessVlan'))
    use(s?.nativeVlan, owner('nativeVlan'))
    for (const id of singles) use(id, lastTrunk)
  }
  for (const [id, node] of uses) {
    const field = fieldPath('vlans', String(id))
    if (!createdBy.has(id)) {
      if (model.get(['vlans', String(id)]) !== undefined) continue
      model.set(['vlans', String(id)], {})
      const d = dispositions[node.id]
      if (d?.kind === 'mapped') dispositions[node.id] = mapped([...d.fields, field])
    }
    if (id !== 1) diagnostics.push({ severity: 'warning', category: 'semantic', code: 'iosxe.vlan-created', message: 'A VLAN a switch port or VLAN interface uses has no "vlan" statement in the text: it is kept with no name, and a render writes it.', field, statement: node.id })
  }

  // OSPF, once the interfaces, their addresses and their VRFs are final. Each process goes in its VRF's instance (the
  // model has one OSPF a VRF: a second process there is left out); an interface is in an area by its own
  // `ip ospf P area A` (`enabledBy: 'interface'`, which wins), or else by the most specific `network` statement of a
  // process in its VRF that matches its primary IPv4 address (`enabledBy: 'network'`). `ip ospf P area` with no
  // `router ospf P` makes the process in the interface's VRF, as IOS does.
  const device = model.root as Device
  const vrfOf = (ref: string): string => {
    const split = splitSubinterface(ref)
    const sub = split ? device.interfaces?.[split.parent]?.subinterfaces?.[split.index] : device.interfaces?.[ref]?.subinterfaces?.['0']
    return sub?.networkInstance ?? 'default'
  }
  const interfaceExists = (ref: string): boolean => {
    const split = splitSubinterface(ref)
    if (!split) return !!device.interfaces && Object.hasOwn(device.interfaces, ref)
    const subs = device.interfaces && Object.hasOwn(device.interfaces, split.parent) ? device.interfaces[split.parent].subinterfaces : undefined
    return !!subs && Object.hasOwn(subs, split.index)
  }
  for (const [ref, state] of ospfInterfaces) {
    if (!state.area || ospfProcesses.has(state.area.process) || !interfaceExists(ref)) continue
    const vrf = vrfOf(ref)
    ospfProcesses.set(state.area.process, { id: state.area.process, ...(vrf !== 'default' ? { vrf } : {}), nodes: [], networks: [], passive: new Map(), active: new Map(), areas: new Map() })
  }
  const processInstance = new Map<string, string>()
  const instanceProcess = new Map<string, string>()
  const firstLine = (p: OspfProcess) => (p.nodes.length ? line(p.nodes[0]) : Infinity)
  for (const process of [...ospfProcesses.values()].sort((x, y) => firstLine(x) - firstLine(y))) {
    const instance = process.vrf ?? 'default'
    const why = process.vrf !== undefined && !vrfs.get(process.vrf)?.definitions.length ? 'names a VRF the configuration doesn\'t define' : instanceProcess.has(instance) ? 'a second OSPF process in its VRF: the model has one OSPF a VRF' : undefined
    if (why) {
      for (const n of process.nodes) if (dispositions[n.id]?.kind === 'mapped') set(n, unsupported(why))
      continue
    }
    processInstance.set(process.id, instance)
    instanceProcess.set(instance, process.id)
  }
  /** Where each interface runs OSPF: its process, area, and what enabled it. */
  const enabled = new Map<string, { readonly process: OspfProcess; readonly area: string; readonly by: 'interface' | 'network'; readonly node: IosNode }>()
  for (const [ref, state] of ospfInterfaces) {
    if (!state.area) continue
    const process = ospfProcesses.get(state.area.process)
    if (!process || !processInstance.has(process.id)) set(state.area.node, unsupported('names an OSPF process that isn\'t converted'))
    else if (!interfaceExists(ref)) set(state.area.node, unsupported('on an interface the model doesn\'t have'))
    else if (processInstance.get(process.id) !== vrfOf(ref)) set(state.area.node, unsupported('the interface is in another VRF than the OSPF process'))
    else enabled.set(ref, { process, area: state.area.area, by: 'interface', node: state.area.node })
  }
  for (const [name, iface] of Object.entries(device.interfaces ?? {})) {
    for (const [index, sub] of Object.entries(iface.subinterfaces ?? {})) {
      const ref = index === '0' ? name : `${name}.${index}`
      const addresses = Object.entries(sub.ipv4?.addresses ?? {})
      const primary = (addresses.find(([, a]) => a.primary) ?? (addresses.length === 1 ? addresses[0] : undefined))?.[0]
      if (enabled.has(ref) || primary === undefined) continue
      const address = ipv4Number(primary)
      let best: { process: OspfProcess; network: OspfNetwork } | undefined
      for (const process of ospfProcesses.values()) {
        if (processInstance.get(process.id) !== (sub.networkInstance ?? 'default')) continue
        for (const network of process.networks) {
          // A wildcard's set bits are the ones that don't have to match; the fewest such bits is the most specific.
          const mask = ~network.wildcard >>> 0
          const bits = (x: number) => x.toString(2).replace(/0/g, '').length
          if (((address & mask) >>> 0) === ((network.address & mask) >>> 0) && (!best || bits(network.wildcard) < bits(best.network.wildcard))) best = { process, network }
        }
      }
      if (best) enabled.set(ref, { process: best.process, area: best.network.area, by: 'network', node: best.network.node })
    }
  }
  const networkFields = new Map<IosNode, string[]>()
  const passiveFields = new Map<IosNode, string[]>()
  for (const [ref, e] of enabled) {
    const instance = processInstance.get(e.process.id)!
    const at = ['networkInstances', instance, 'ospf', 'areas', e.area, 'interfaces', ref]
    const field = model.set([...at, 'enabledBy'], e.by)
    if (e.by === 'interface') set(e.node, mapped([field]))
    else networkFields.set(e.node, [...(networkFields.get(e.node) ?? []), field])
    const passive = e.process.passive.get(ref) ?? (e.process.passiveDefault && !e.process.active.has(ref) ? e.process.passiveDefault : undefined)
    if (passive) passiveFields.set(passive, [...(passiveFields.get(passive) ?? []), model.set([...at, 'passive'], true)])
    for (const [leaf, s] of ospfInterfaces.get(ref)?.settings ?? []) set(s.node, mapped([model.set([...at, leaf], s.value)]))
  }
  for (const process of ospfProcesses.values()) {
    const instance = processInstance.get(process.id)
    if (instance === undefined) continue
    const at = ['networkInstances', instance, 'ospf']
    const routerNodes = process.nodes.filter((n) => n.words[0]?.toLowerCase() === 'router')
    const id = model.set([...at, 'processId'], process.id)
    for (const n of routerNodes) set(n, mapped([id]))
    if (process.routerId) set(process.routerId.node, mapped([model.set([...at, 'routerId'], process.routerId.value)]))
    for (const [area, settings] of process.areas) for (const [key, s] of settings) set(s.node, mapped([model.set([...at, 'areas', area, key], s.value)]))
    for (const network of process.networks) {
      const fields = networkFields.get(network.node)
      set(network.node, fields ? mapped(fields) : unsupported('enables no interface the model has: it keeps OSPF per interface, so a range for interfaces to come isn\'t kept'))
    }
    for (const n of [...process.passive.values(), ...(process.passiveDefault ? [process.passiveDefault] : [])]) {
      const fields = passiveFields.get(n)
      set(n, fields ? mapped(fields) : ignored('OSPF doesn\'t run on the interface: nothing to convert'))
    }
  }
  // An interface's OSPF settings with OSPF not running on it change nothing.
  for (const [ref, state] of ospfInterfaces) {
    if (enabled.has(ref)) continue
    for (const s of state.settings.values()) set(s.node, ignored('OSPF doesn\'t run on the interface: nothing to convert'))
  }

  // BGP: an update source that isn't one of the model's interfaces is left out; under `bgp default ipv4-unicast`
  // (IOS's default), a neighbor of the global table carries IPv4 unless `no neighbor X activate` says otherwise.
  for (const { path, node } of updateSources) {
    const value = model.get(path)
    if (owners.get(fieldPath(...path)) !== node || typeof value !== 'string' || interfaceExists(value)) continue
    model.remove(path)
    set(node, unsupported('names an interface the configuration doesn\'t have'))
  }
  // Each peer's address families: those it carries (activated, defined in a VRF's family, or a global IPv4 neighbor
  // under `bgp default ipv4-unicast`, IOS's default, unless taken out), with their route maps. A route map in a family
  // the peer doesn't carry is left out: the model keeps policies with a family it carries, which would activate it.
  // IOS stopped activating IPv6 neighbors in IPv4 by default (12.2(33)SRE4), so the default is for IPv4 addresses only.
  //
  // A member carries the families its peer group does, too: its own route map there is kept on its own family entry
  // (a member can customise its inbound policy), which the model reads as the group's family with the member's
  // setting winning. A VRF's neighbor that carries no family (taken out with `no neighbor X activate`) is left out:
  // IOS writes a VRF's neighbors in their family, which would activate it.
  /** The families each peer group carries, by `instance|group`. */
  const groupFamilies = new Map<string, Set<string>>()
  const groupsFirst = [...peers.values()].sort((x, y) => Number(x.kind === 'neighbors') - Number(y.kind === 'neighbors'))
  for (const peer of groupsFirst) {
    const base = ['networkInstances', peer.instance, 'bgp', peer.kind, peer.key]
    if (model.get(base) === undefined) continue
    const implicit = !noDefaultIpv4 && peer.instance === 'default' && peer.kind === 'neighbors' && isIpv4(peer.key)
    if (implicit && !peer.families.has('ipv4-unicast')) peer.families.set('ipv4-unicast', { policies: new Map() })
    const group = peer.kind === 'neighbors' ? model.get([...base, 'group']) : undefined
    const inherited = typeof group === 'string' ? (groupFamilies.get(`${peer.instance}|${group}`) ?? new Set<string>()) : new Set<string>()
    const carried = new Set<string>()
    for (const [family, f] of peer.families) {
      const own = f.activate ?? f.auto ?? (family === 'ipv4-unicast' && implicit && !f.deactivate ? peer.nodes.find((n) => dispositions[n.id]?.kind === 'mapped') : undefined)
      const fromGroup = !own && !f.deactivate && inherited.has(family)
      if (!own && !fromGroup) {
        for (const p of f.policies.values()) set(p.node, unsupported('a route map in an address family the neighbor doesn\'t carry: the model keeps policies only with a family it carries'))
        continue
      }
      carried.add(family)
      // A route map names a policy of the model (model 0.5.0), or it isn't kept: a name alone would say nothing.
      const policies = [...f.policies].filter(([, p]) => {
        const why = policyProblem(p.name)
        if (why) set(p.node, unsupported(why))
        return !why
      })
      // Inherited with nothing of its own: the group's family says it all.
      if (fromGroup && !policies.length) continue
      const at = [...base, 'addressFamilies', family]
      const field = model.set(at, {})
      if (own) {
        const d = dispositions[own.id]
        set(own, mapped([...(d?.kind === 'mapped' ? d.fields : []), field]))
      }
      for (const [leaf, p] of policies) set(p.node, mapped([...(own ? [] : [field]), model.set([...at, leaf], [p.name])]))
    }
    if (peer.kind === 'groups') groupFamilies.set(`${peer.instance}|${peer.key}`, carried)
    else if (peer.instance !== 'default' && !carried.size && !inherited.size) {
      model.remove(base)
      model.removeIfEmpty(['networkInstances', peer.instance, 'bgp', 'neighbors'])
      for (const n of peer.nodes) if (dispositions[n.id]?.kind === 'mapped') set(n, unsupported('a VRF\'s neighbor taken out of its address family: IOS defines it in the family, which would activate it'))
    }
  }

  // What IOS does with an eBGP peer's routes when no policy applies (model 0.4.1): it accepts them, both ways. Set for
  // the side(s) that apply, on an instance with an eBGP peer (its own or its group's peer AS, not the local one) that
  // carries a family with no route map in that direction (its own, its group's, for the peer or the family).
  for (const [instance, ni] of Object.entries(device.networkInstances ?? {})) {
    const bgp = ni.bgp
    if (!bgp) continue
    const sides = new Set<'import' | 'export'>()
    for (const n of Object.values(bgp.neighbors ?? {})) {
      const group = n.group !== undefined && bgp.groups && Object.hasOwn(bgp.groups, n.group) ? bgp.groups[n.group] : undefined
      const peerAs = n.peerAs ?? group?.peerAs
      if (peerAs === undefined || peerAs === bgp.localAs) continue
      const families = new Set([...Object.keys(n.addressFamilies ?? {}), ...Object.keys(group?.addressFamilies ?? {})]) as Set<'ipv4-unicast' | 'ipv6-unicast'>
      for (const family of families)
        for (const [side, leaf] of [['import', 'importPolicies'], ['export', 'exportPolicies']] as const)
          if (!(n[leaf] ?? group?.[leaf] ?? n.addressFamilies?.[family]?.[leaf] ?? group?.addressFamilies?.[family]?.[leaf])) sides.add(side)
    }
    if (sides.size) model.set(['networkInstances', instance, 'bgp', 'ebgpDefaultPolicy'], { ...(sides.has('import') ? { import: 'accept' } : {}), ...(sides.has('export') ? { export: 'accept' } : {}) })
  }

  // Access lists (model 0.5.1), and each interface's, once every interface is final: one applied to an interface the
  // model doesn't have (a VLAN interface left out, say), or naming an ACL that isn't converted, is left out.
  const acls = acl.finish()
  if (acls.filters) model.set(['filters'], acls.filters)
  diagnostics.push(...acls.diagnostics)
  for (const a of acls.attachments) {
    if (a.why) set(a.node, unsupported(a.why))
    else if (model.get(['interfaces', a.path[1]]) === undefined) set(a.node, unsupported('on an interface the model doesn\'t have'))
    else set(a.node, mapped([model.set(a.path, a.name)]))
  }

  return { tree: nodes, model: model.root as Device, dispositions, diagnostics }
}
