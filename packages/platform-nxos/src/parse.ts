// NX-OS text → the shared model: system (hostname, domain name, DNS), interfaces and subinterfaces with their addresses,
// VRFs (`vrf context`) and static routes, NTP, logging and SNMP (phase 1), and VLANs, switch ports, SVIs, OSPF and BGP
// (phase 2, model 0.4.0), and routing policy (phase 3, model 0.5.0, policy.ts: prefix lists, community and AS-path lists,
// route maps), which BGP's route maps resolve to. Every statement of the tree gets a disposition: `mapped` when everything it says went into the
// model, `ignored-by-design` with why, or `unsupported` (its text kept in the tree). A statement is mapped only when
// every option on it is understood: one with an option the model can't hold (`ntp server 192.0.2.1 key 1`) is
// unsupported as a whole, never half-converted. Later statements act on earlier ones as on the device: a second setting
// supersedes the first, and `no …` forms and `vrf member` clear what they remove.
import { fieldPath, isRouteDistinguisher, type Context, type Device, type Bgp, type BgpAddressFamilyName, type Diagnostic, type OspfAuthentication, type OspfNetworkType, type ParseResult, type StatementDisposition, type SyslogSeverity } from '@dialect/core'
import { asNumber, inRange, ipv4Prefix, ipv6Prefix, isIpv4, isIpv6, maskLength } from './addresses'
import { OSPF_FEATURE, REQUIRED_FEATURES, VPN_FEATURE } from './features'
import { createPolicyReader } from './policy'
import { interfaceName, interfaceType, isInterfaceName, isSwitchable, splitSubinterface } from './names'
import { BANNER_TYPES, parseTree, unquote, type NxNode } from './tree'
import { ALL_VLANS, compactVlans, vlanEntries, vlanIds } from './vlans'

type Obj = { [key: string]: unknown }
type Segments = readonly string[]

/** The model's syslog severities by NX-OS's level numbers (`logging server 192.0.2.1 5`), 0 to 7. */
export const SEVERITY_LEVELS: readonly SyslogSeverity[] = ['emergency', 'alert', 'critical', 'error', 'warning', 'notice', 'informational', 'debug']

/** NX-OS's SNMP community groups, by the model's access. */
export const SNMP_GROUPS = { 'read-only': 'network-operator', 'read-write': 'network-admin' } as const

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

  /** Removes `segments`, then each parent the removal left empty, up to (not including) the first `keep` segments. */
  prune(segments: Segments, keep: number): void {
    this.remove(segments)
    for (let n = segments.length - 1; n > keep; n--) this.removeIfEmpty(segments.slice(0, n))
  }
}

const mapped = (fields: string[]): StatementDisposition => ({ kind: 'mapped', fields })
const unsupported = (reason?: string): StatementDisposition => (reason ? { kind: 'unsupported', reason } : { kind: 'unsupported' })
const ignored = (reason: string): StatementDisposition => ({ kind: 'ignored-by-design', reason })

const INTEGER = /^\d+$/
const SHUTDOWN = /^shut(?:d(?:o(?:w(?:n)?)?)?)?$/
/**
 * A VRF named on a statement, or undefined for the global table: `use-vrf default` is the same thing as no VRF, and the
 * model leaves it out the same way (a render can't bring it back).
 */
const vrfName = (name: string): string | undefined => (name === 'default' ? undefined : name)
const HOST = /^[A-Za-z0-9][\w.-]*$/
/** Words on a route that aren't an interface name. */
const ROUTE_KEYWORDS = new Set(['tag', 'name', 'track', 'vrf', 'static'])
const MGMT = /^mgmt0$/i

/** An OSPF area as the model writes it, dotted: NX-OS takes `0.0.0.10` or `10` (any number up to 4294967295). */
export function areaId(text: string): string | null {
  if (isIpv4(text)) return text
  const n = inRange(text, 0, 4294967295)
  return n === null ? null : [24, 16, 8, 0].map((shift) => Math.floor(n / 2 ** shift) % 256).join('.')
}


/** Where an interface statement's settings go: subinterface `0` for the main interface's addresses. */
interface InterfaceContext {
  readonly name: string
  readonly sub: string
  readonly isSub: boolean
}

/** Parses NX-OS `text` into the model, with a disposition for every statement of its tree. */
export function parse(text: string, _context: Context): ParseResult {
  const { nodes, diagnostics: treeDiagnostics } = parseTree(text)
  const diagnostics: Diagnostic[] = [...treeDiagnostics]
  const model = new ModelBuilder()
  const dispositions: Record<string, StatementDisposition> = {}
  const set = (node: NxNode, disposition: StatementDisposition) => {
    dispositions[node.id] = disposition
  }
  /** Prefix lists, community and AS-path lists and route maps (policy.ts). */
  const policy = createPolicyReader(dispositions)
  const line = (node: NxNode) => node.span.startLine

  /** The statement that last set a single-valued setting, by key: a later one supersedes it, as on the device. */
  const owners = new Map<string, NxNode>()
  const claim = (key: string, node: NxNode, onSupersede?: () => void) => {
    const previous = owners.get(key)
    if (previous && previous !== node) {
      onSupersede?.()
      set(previous, ignored(`superseded by line ${line(node)}`))
    }
    owners.set(key, node)
  }
  /**
   * A `no …` form of a single-valued setting: the statement that set it (if any) is removed, with what it put in the
   * model. Returns the `no` statement's own disposition.
   */
  const unclaim = (key: string, node: NxNode, what: string, path: Segments, keep: number): StatementDisposition => {
    const previous = owners.get(key)
    if (!previous) return ignored(`no ${what} to remove: nothing to convert`)
    owners.delete(key)
    model.prune(path, keep)
    set(previous, ignored(`removed by line ${line(node)}`))
    return ignored(`removes the ${what} on line ${line(previous)}: nothing to convert`)
  }

  // ---- interfaces

  type AddressStatement = { readonly node: NxNode; readonly address: string }
  /** Per subinterface and family (`name|sub|4`): its primary address (or `dhcp`) and secondaries, by statement. */
  type Addressing = { readonly ctx: InterfaceContext; readonly family: 4 | 6; primary?: AddressStatement | { readonly node: NxNode; readonly dhcp: true }; secondaries: AddressStatement[] }
  const addressing = new Map<string, Addressing>()
  const addressingOf = (ctx: InterfaceContext, family: 4 | 6) => {
    const key = `${ctx.name}|${ctx.sub}|${family}`
    const state = addressing.get(key) ?? { ctx, family, secondaries: [] }
    addressing.set(key, state)
    return state
  }
  const subPath = (ctx: InterfaceContext) => ['interfaces', ctx.name, 'subinterfaces', ctx.sub]
  const familyPath = (ctx: InterfaceContext, family: 4 | 6) => [...subPath(ctx), family === 4 ? 'ipv4' : 'ipv6']

  /** Drops what removing addresses left empty: the address map, the family, a main interface's subinterface 0. */
  const pruneFamily = (ctx: InterfaceContext, family: 4 | 6) => {
    const at = familyPath(ctx, family)
    model.removeIfEmpty([...at, 'addresses'])
    model.removeIfEmpty(at)
    if (!ctx.isSub) pruneMain(ctx)
  }
  /** A main interface's subinterface 0 left with nothing in it: dropped, with the map it was in when that is empty too. */
  const pruneMain = (ctx: InterfaceContext) => {
    model.removeIfEmpty(subPath(ctx))
    model.removeIfEmpty(['interfaces', ctx.name, 'subinterfaces'])
  }

  /** Removes a family's addresses before `node`, each statement marked with `why`; the statements' lines, in order. */
  const clearAddresses = (ctx: InterfaceContext, family: 4 | 6, why: string): number[] => {
    const state = addressing.get(`${ctx.name}|${ctx.sub}|${family}`)
    if (!state) return []
    const removed = [...(state.primary ? [state.primary] : []), ...state.secondaries]
    for (const r of removed) {
      if ('address' in r) model.remove([...familyPath(ctx, family), 'addresses', r.address])
      set(r.node, ignored(why))
    }
    addressing.delete(`${ctx.name}|${ctx.sub}|${family}`)
    pruneFamily(ctx, family)
    return removed.map((r) => line(r.node)).sort((a, b) => a - b)
  }
  const linesText = (lines: number[]) => `line${lines.length > 1 ? 's' : ''} ${lines.join(', ')}`

  /** `ip address …` / `ipv6 address …`: a primary replaces the one before it; `secondary` adds one; `dhcp` replaces all. */
  const mapAddress = (node: NxNode, ctx: InterfaceContext, family: 4 | 6): StatementDisposition => {
    const w = node.words
    const lw = w.map((x) => x.toLowerCase())
    // In a VRF since deleted, the address may be in it or in the global table: neither is guessed.
    const deletedBy = vrfOf(ctx).deletedBy
    if (deletedBy) return uncertain(deletedBy)
    const state = addressingOf(ctx, family)
    const at = familyPath(ctx, family)
    if (lw[2] === 'dhcp' && w.length === 3) {
      // An address from DHCP replaces the static ones before it, as on the device.
      const lines = clearAddresses(ctx, family, `replaced by the address from DHCP on line ${line(node)}`)
      addressingOf(ctx, family).primary = { node, dhcp: true }
      return unsupported(`an address from DHCP${lines.length ? `, replacing the address${lines.length > 1 ? 'es' : ''} on ${linesText(lines)}` : ''}`)
    }
    const secondary = lw[w.length - 1] === 'secondary'
    const args = w.slice(2, secondary ? -1 : undefined)
    let address: string
    let length: number
    if (family === 4) {
      const prefix = args.length === 2 ? ipv4Prefix(args[0], args[1]) : args.length === 1 ? ipv4Prefix(args[0]) : null
      if (!prefix) return unsupported(args.length === 2 && isIpv4(args[0]) && maskLength(args[1]) === null ? 'not a contiguous mask' : undefined)
      const [a, l] = prefix.split('/')
      address = a
      length = Number(l)
    } else {
      const p = args.length === 1 ? ipv6Prefix(args[0]) : null
      if (!p) return unsupported()
      address = p.address
      length = p.length
    }
    if (secondary) state.secondaries.push({ node, address })
    else {
      const previous = state.primary
      if (previous && previous.node !== node) {
        if ('address' in previous && previous.address !== address) model.remove([...at, 'addresses', previous.address])
        set(previous.node, ignored(`replaced by line ${line(node)}`))
      }
      state.primary = { node, address }
    }
    return mapped([model.set([...at, 'addresses', address, 'prefixLength'], length)])
  }

  /** `no ip address A/L [secondary]` / `no ipv6 address A/L [secondary]`: removes that one address. */
  const removeAddress = (node: NxNode, ctx: InterfaceContext, family: 4 | 6): StatementDisposition => {
    const w = node.words
    const args = w.slice(3, w[w.length - 1].toLowerCase() === 'secondary' ? -1 : undefined)
    const prefix = family === 4 ? (args.length === 2 ? ipv4Prefix(args[0], args[1]) : args.length === 1 ? ipv4Prefix(args[0]) : null) : args.length === 1 ? ipv6Prefix(args[0]) : null
    if (!prefix) return unsupported()
    const address = typeof prefix === 'string' ? prefix.split('/')[0] : prefix.address
    const state = addressing.get(`${ctx.name}|${ctx.sub}|${family}`)
    const entries = state ? [...(state.primary && 'address' in state.primary ? [state.primary] : []), ...state.secondaries] : []
    const removed = entries.filter((e) => e.address === address)
    if (!state || !removed.length) return ignored('no such address on the interface: nothing to convert')
    for (const r of removed) set(r.node, ignored(`removed by line ${line(node)}`))
    if (state.primary && removed.includes(state.primary as AddressStatement)) delete state.primary
    state.secondaries = state.secondaries.filter((e) => !removed.includes(e))
    model.remove([...familyPath(ctx, family), 'addresses', address])
    pruneFamily(ctx, family)
    return ignored(`removes the address on ${linesText(removed.map((r) => line(r.node)))}: nothing to convert`)
  }

  /**
   * Per interface (`name|sub`): the VRF it is in and the `vrf member` statement that put it there. `deletedBy`: the
   * `no vrf context` that deleted that VRF while the interface was in it. What the device keeps of the membership is
   * then not certain (#47), until a later `vrf member` or `no vrf member` says it again.
   */
  type Membership = { readonly ctx: InterfaceContext; readonly vrf: string; readonly node?: NxNode; readonly deletedBy?: NxNode }
  const membership = new Map<string, Membership>()
  const uncertain = (deletedBy: NxNode) => unsupported(`in a VRF line ${line(deletedBy)} deletes: what the device keeps of it isn't certain`)
  const vrfOf = (ctx: InterfaceContext): { vrf: string; node?: NxNode; deletedBy?: NxNode } => membership.get(`${ctx.name}|${ctx.sub}`) ?? { vrf: MGMT.test(ctx.name) && !ctx.isSub ? 'management' : 'default' }

  /**
   * `vrf member V` / `no vrf member [V]`: the subinterface's `networkInstance` (subinterface `0` for a main interface).
   * Moving an interface to another VRF clears its addresses, as on the device, so only addresses after it stay.
   * mgmt0 is always in the management VRF (its interface statement maps that), and no other interface is.
   */
  const mapVrfMember = (node: NxNode, ctx: InterfaceContext, remove: boolean): StatementDisposition => {
    const w = node.words.slice(remove ? 1 : 0)
    if (w.length > 3 || (!remove && w.length !== 3)) return unsupported()
    const isMgmt = MGMT.test(ctx.name) && !ctx.isSub
    const current = vrfOf(ctx)
    const target = remove ? 'default' : w[2]
    const at = [...subPath(ctx), 'networkInstance']
    if (remove && w[2] !== undefined && w[2] !== current.vrf) return ignored('not in that VRF: nothing to convert')
    if (isMgmt && target !== 'management') return unsupported('mgmt0 is always in the management VRF')
    if (!isMgmt && target === 'management') return unsupported('only mgmt0 is in the management VRF')
    if (target === current.vrf && !current.deletedBy) {
      if (isMgmt) return ignored('mgmt0 is always in the management VRF: its interface statement says so')
      return ignored(target === 'default' ? 'already in the default VRF: nothing to convert' : `already in that VRF${current.node ? ` (line ${line(current.node)})` : ''}`)
    }
    const why = `removed by line ${line(node)}, which moves the interface to another VRF`
    // NX-OS deletes the interface's Layer 3 configuration: its addresses and its OSPF settings.
    clearOspfPort(ctx, ignored(why))
    const lines = [...clearAddresses(ctx, 4, why), ...clearAddresses(ctx, 6, why)].sort((a, b) => a - b)
    const cleared = lines.length ? `, clearing the addresses on ${linesText(lines)}` : ''
    if (current.node) set(current.node, ignored(`undone by line ${line(node)}`))
    // `vrf member default` is the global table too: the model says it by leaving networkInstance out.
    if (target === 'default') {
      membership.set(`${ctx.name}|${ctx.sub}`, { ctx, vrf: 'default' })
      model.remove(at)
      if (!ctx.isSub) pruneMain(ctx)
      return ignored(`returns the interface to the default VRF${cleared}: nothing to convert`)
    }
    membership.set(`${ctx.name}|${ctx.sub}`, { ctx, vrf: target, node })
    return mapped([model.set(at, target)])
  }

  /** The `interface mgmt0` statements, which put it in the management VRF. */
  const mgmtInterfaces: NxNode[] = []

  /** Main interfaces with `no switchport`, decided once every statement is read (it depends on their addresses). */
  const routedPorts: { node: NxNode; ctx: InterfaceContext }[] = []

  /** Main interfaces with `switchport` alone, decided once every statement is read (a port with IP configuration isn't one). */
  const switchPorts: { node: NxNode; ctx: InterfaceContext }[] = []
  /** `interface VlanN` statements: SVIs, which stay `irb-or-svi` only when their VLAN is defined. */
  const svis: { node: NxNode; ctx: InterfaceContext; vlan: number }[] = []

  // ---- switch ports

  /** Per interface, the statements its switch port settings come from, so `no switchport` can clear them. */
  const switchStatements = new Map<string, NxNode[]>()
  /** Per interface, the statements its trunk's allowed VLANs come from: the last that set the list, and the edits after it. */
  const allowedStatements = new Map<string, NxNode[]>()
  const switchingPath = (name: string) => ['interfaces', name, 'switching']
  const EVERY_VLAN = Array.from({ length: 4094 }, (_, i) => i + 1)

  /** Forgets which statements set the settings under `path`: they are gone, so a later `no …` has nothing to remove. */
  const dropOwners = (path: Segments) => {
    const p = fieldPath(...path)
    for (const key of owners.keys()) if (key === p || key.startsWith(`${p}.`) || key.startsWith(`${p}[`)) owners.delete(key)
  }

  /** Clears a port's switch port settings (`no switchport` makes it routed), each statement still mapped marked `why`. */
  const clearSwitching = (name: string, why: string) => {
    for (const n of switchStatements.get(name) ?? []) if (dispositions[n.id]?.kind === 'mapped') set(n, ignored(why))
    switchStatements.delete(name)
    allowedStatements.delete(name)
    dropOwners(switchingPath(name))
    model.remove(switchingPath(name))
  }

  /** `switchport mode|access vlan|trunk native vlan|trunk allowed vlan …`: the port's `switching`. */
  const mapSwitchport = (node: NxNode, ctx: InterfaceContext): StatementDisposition => {
    const w = node.words
    const lw = w.map((x) => x.toLowerCase())
    if (ctx.isSub || !isSwitchable(ctx.name)) return unsupported('a switch port setting on an interface that can\'t be a switch port')
    const at = switchingPath(ctx.name)
    const said = (field: string, value: unknown): StatementDisposition => {
      claim(fieldPath(...at, field), node)
      switchStatements.set(ctx.name, [...(switchStatements.get(ctx.name) ?? []), node])
      return mapped([model.set([...at, field], value)])
    }
    if (lw[1] === 'mode' && w.length === 3) return lw[2] === 'access' || lw[2] === 'trunk' ? said('mode', lw[2]) : unsupported('a switch port mode other than access or trunk')
    const vlan = (written: string, field: string) => {
      const id = inRange(written, 1, 4094)
      return id === null ? unsupported('not a VLAN ID from 1 to 4094') : said(field, id)
    }
    if (lw[1] === 'access' && lw[2] === 'vlan' && w.length === 4) return vlan(w[3], 'accessVlan')
    if (lw[1] === 'trunk' && lw[2] === 'native' && lw[3] === 'vlan' && w.length === 5) return vlan(w[4], 'nativeVlan')
    if (lw[1] === 'trunk' && lw[2] === 'allowed' && lw[3] === 'vlan' && (w.length === 5 || w.length === 6)) return mapAllowed(node, ctx)
    return unsupported()
  }

  /**
   * `switchport trunk allowed vlan LIST|all|none`, or `add|remove|except LIST`: a list sets them, `add` and `remove` edit
   * the list before (every VLAN, NX-OS's default, when there is none), `except` sets every VLAN but those.
   */
  const mapAllowed = (node: NxNode, ctx: InterfaceContext): StatementDisposition => {
    const w = node.words
    const op = w.length === 6 ? w[4].toLowerCase() : undefined
    const list = w[w.length - 1]
    const field = [...switchingPath(ctx.name), 'allowedVlans']
    const current = (model.get(field) as string[] | undefined) ?? [ALL_VLANS]
    let value: string[] | null
    if (op === undefined) value = list.toLowerCase() === 'all' ? [ALL_VLANS] : list.toLowerCase() === 'none' ? [] : vlanEntries(list)
    else if (op !== 'add' && op !== 'remove' && op !== 'except') return unsupported()
    else {
      const entries = vlanEntries(list)
      const ids = new Set(entries ? vlanIds(entries) : [])
      value = !entries ? null : op === 'add' ? compactVlans([...vlanIds(current), ...ids]) : compactVlans((op === 'remove' ? vlanIds(current) : EVERY_VLAN).filter((id) => !ids.has(id)))
    }
    // The device refuses a malformed list: the list before it stays.
    if (value === null) return unsupported('not a list of VLAN IDs from 1 to 4094')
    const edits = op === 'add' || op === 'remove'
    const before = allowedStatements.get(ctx.name) ?? []
    if (!edits) for (const n of before) set(n, ignored(`superseded by line ${line(node)}`))
    allowedStatements.set(ctx.name, edits ? [...before, node] : [node])
    switchStatements.set(ctx.name, [...(switchStatements.get(ctx.name) ?? []), node])
    return mapped([model.set(field, value)])
  }

  /** `no switchport mode|access vlan|trunk native vlan|trunk allowed vlan`: back to NX-OS's default, which the model leaves out. */
  const removeSwitchport = (node: NxNode, ctx: InterfaceContext): StatementDisposition => {
    const lw = node.words.map((x) => x.toLowerCase())
    if (ctx.isSub || !isSwitchable(ctx.name)) return unsupported()
    const at = switchingPath(ctx.name)
    if (lw[2] === 'trunk' && lw[3] === 'allowed' && lw[4] === 'vlan' && lw.length === 5) {
      // Every VLAN again: the statements the list came from are undone.
      const before = allowedStatements.get(ctx.name) ?? []
      allowedStatements.delete(ctx.name)
      for (const n of before) set(n, ignored(`removed by line ${line(node)}`))
      model.remove([...at, 'allowedVlans'])
      model.removeIfEmpty(at)
      return ignored(before.length ? `removes the allowed VLANs on ${linesText(before.map(line))}: nothing to convert` : 'no allowed VLANs to remove: nothing to convert')
    }
    const field = lw[2] === 'mode' ? 'mode' : lw[2] === 'access' && lw[3] === 'vlan' ? 'accessVlan' : lw[2] === 'trunk' && lw[3] === 'native' && lw[4] === 'vlan' ? 'nativeVlan' : undefined
    if (!field) return unsupported()
    return unclaim(fieldPath(...at, field), node, field === 'mode' ? 'switch port mode' : field === 'accessVlan' ? 'access VLAN' : 'native VLAN', [...at, field], 2)
  }

  const mapInterfaceChild = (node: NxNode, ctx: InterfaceContext): StatementDisposition => {
    const w = node.words
    const lw = w.map((x) => x.toLowerCase())
    const iface = ['interfaces', ctx.name]
    const sub = subPath(ctx)
    const own = ctx.isSub ? sub : iface
    const key = (field: string) => fieldPath(...own, field)

    if (lw[0] === 'description' && w.length > 1) {
      claim(key('description'), node)
      return mapped([model.set([...own, 'description'], node.text.replace(/^\S+\s+/, ''))])
    }
    if (lw[0] === 'no' && lw[1] === 'description' && w.length === 2) return unclaim(key('description'), node, 'description', [...own, 'description'], own.length)
    if (SHUTDOWN.test(lw[0]) && w.length === 1) {
      claim(key('enabled'), node)
      return mapped([model.set([...own, 'enabled'], false)])
    }
    if (lw[0] === 'no' && w.length === 2 && SHUTDOWN.test(lw[1])) {
      claim(key('enabled'), node)
      return mapped([model.set([...own, 'enabled'], true)])
    }
    if (lw[0] === 'mtu' && w.length === 2 && INTEGER.test(w[1])) {
      if (ctx.isSub) return unsupported('the model has no MTU for a subinterface')
      claim(key('mtu'), node)
      return mapped([model.set([...iface, 'mtu'], Number(w[1]))])
    }
    if (lw[0] === 'no' && lw[1] === 'mtu' && w.length <= 3 && !ctx.isSub) return unclaim(key('mtu'), node, 'MTU', [...iface, 'mtu'], iface.length)
    if (lw[0] === 'no' && lw[1] === 'encapsulation' && lw[2] === 'dot1q' && w.length <= 4 && ctx.isSub) return unclaim(fieldPath(...sub, 'vlanId'), node, 'VLAN tag', [...sub, 'vlanId'], sub.length)
    if (lw[0] === 'encapsulation' && lw[1] === 'dot1q' && w.length === 3 && INTEGER.test(w[2])) {
      if (!ctx.isSub) return unsupported('encapsulation dot1q on a main interface')
      claim(fieldPath(...sub, 'vlanId'), node)
      return mapped([model.set([...sub, 'vlanId'], Number(w[2])), model.set([...iface, 'vlanTagging'], true)])
    }
    if ((lw[0] === 'ip' || lw[0] === 'ipv6') && lw[1] === 'address' && w.length >= 3) return mapAddress(node, ctx, lw[0] === 'ip' ? 4 : 6)
    if (lw[0] === 'no' && (lw[1] === 'ip' || lw[1] === 'ipv6') && lw[2] === 'address' && w.length > 3) return removeAddress(node, ctx, lw[1] === 'ip' ? 4 : 6)
    if (lw[0] === 'no' && (lw[1] === 'ip' || lw[1] === 'ipv6') && lw[2] === 'address' && w.length === 3) {
      const family = lw[1] === 'ip' ? 4 : 6
      const why = `removed by line ${line(node)}`
      const lines = clearAddresses(ctx, family, why)
      return ignored(lines.length ? `removes the addresses on ${linesText(lines)}: nothing to convert` : 'says the interface has no address: nothing to convert')
    }
    if (lw[0] === 'vrf' && lw[1] === 'member') return mapVrfMember(node, ctx, false)
    if (lw[0] === 'no' && lw[1] === 'vrf' && lw[2] === 'member') return mapVrfMember(node, ctx, true)
    if (lw[0] === 'no' && lw[1] === 'switchport' && w.length === 2 && !ctx.isSub && isSwitchable(ctx.name)) {
      claim(`switchport ${ctx.name}`, node)
      routedPorts.push({ node, ctx })
      clearSwitching(ctx.name, `cleared by line ${line(node)}, which makes the port routed`)
      return mapped([])
    }
    if (lw[0] === 'switchport' && w.length === 1 && !ctx.isSub && isSwitchable(ctx.name)) {
      claim(`switchport ${ctx.name}`, node)
      switchPorts.push({ node, ctx })
      return mapped([])
    }
    if (lw[0] === 'switchport') return mapSwitchport(node, ctx)
    if (lw[0] === 'no' && lw[1] === 'switchport') return removeSwitchport(node, ctx)
    if (lw[0] === 'ip' && lw[1] === 'router' && lw[2] === 'ospf') return mapOspfEnable(node, ctx)
    if (lw[0] === 'no' && lw[1] === 'ip' && lw[2] === 'router' && lw[3] === 'ospf') return removeOspfEnable(node, ctx)
    if (lw[0] === 'ip' && lw[1] === 'ospf') return mapOspfPort(node, ctx)
    if (lw[0] === 'no' && lw[1] === 'ip' && lw[2] === 'ospf') return removeOspfPort(node, ctx)
    return unsupported()
  }

  const mapInterface = (node: NxNode): void => {
    const w = node.words
    const n = interfaceName(w, 1)
    if (!n || 1 + n.used !== w.length || !isInterfaceName(n.name)) {
      unsupportedTree(node)
      return
    }
    const split = splitSubinterface(n.name)
    const ctx: InterfaceContext = split ? { name: split.parent, sub: split.index, isSub: true } : { name: n.name, sub: '0', isSub: false }
    model.object(['interfaces', ctx.name])
    const fields: string[] = []
    const type = interfaceType(ctx.name)
    // An SVI (`interface Vlan10`) routes for the VLAN its name gives, on its subinterface 0. It stays one only if the
    // VLAN is defined, which is decided once every statement is read.
    const svi = !split && type === 'vlan' ? inRange(/\d+$/.exec(ctx.name)?.[0], 1, 4094) : null
    if (svi !== null) {
      fields.push(model.set(['interfaces', ctx.name, 'type'], 'irb-or-svi'), model.set([...subPath(ctx), 'routedVlan'], svi))
      svis.push({ node, ctx, vlan: svi })
    } else if (type) fields.push(model.set(['interfaces', ctx.name, 'type'], type))
    if (split) model.object(subPath(ctx))
    // mgmt0 routes in the management VRF whether its `vrf member management` is shown or not.
    if (!split && MGMT.test(ctx.name)) {
      fields.push(model.set([...subPath(ctx), 'networkInstance'], 'management'))
      mgmtInterfaces.push(node)
    }
    set(node, mapped(fields))
    for (const child of node.children) {
      if (child.kind !== 'statement' || child.children.length) unsupportedTree(child)
      else set(child, mapInterfaceChild(child, ctx))
    }
  }

  // ---- static routes

  /** One next hop of a route, by the statement that configured it. */
  interface Hop {
    readonly node: NxNode
    /** What makes it a different route on NX-OS: the interface, address and discard. Other options are edits. */
    readonly key: string
    readonly hop: Obj
    readonly name?: string
  }
  /**
   * The words of an `ip route …` / `ipv6 route …` statement from `i` (the prefix): the prefix, the next hop and the name,
   * or why it isn't converted. A reason never repeats a word of the statement (AGENTS.md, No secrets in diagnostics).
   */
  const readRoute = (w: readonly string[], i: number, v6: boolean): { prefix: string; hop: Obj; name?: string } | { reason?: string } => {
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
      const n = interfaceName(w, i)
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
      } else if (!ROUTE_KEYWORDS.has(lower) && hop.address === undefined && hop.interface === undefined && hop.drop === undefined && n && isInterfaceName(n.name)) {
        // Only a real interface name: a malformed address (`dead::beef::bad`) or a stray word isn't one.
        if (/^null0$/i.test(n.name)) hop.drop = 'discard'
        else hop.interface = n.name
        i += n.used
      } else if (lower === 'vrf') return { reason: 'a next hop in another VRF' }
      else if (lower === 'track') return { reason: 'a route tracked by an object' }
      else return { reason: `word ${i + 1} isn't converted yet` }
    }
    return { prefix, hop, ...(name !== undefined ? { name } : {}) }
  }
  const hopKey = (hop: Obj) => `${hop.interface ?? ''}|${hop.address ?? ''}|${hop.drop ?? ''}`

  /** Per network instance and prefix, its next hops in order; the model is built from them once every route is read. */
  const routes = new Map<string, { readonly instance: string; readonly prefix: string; hops: Hop[] }>()

  /** `ip route …` / `ipv6 route …`, at the top or inside `vrf context <instance>`: one next hop of a route. */
  const mapRoute = (node: NxNode, v6: boolean, instance: string): void => {
    const r = readRoute(node.words, 2, v6)
    if (!('prefix' in r)) return set(node, unsupported(r.reason))
    if (r.hop.address === undefined && r.hop.interface === undefined && r.hop.drop === undefined) return set(node, unsupported('no next hop'))
    const routeKey = `${instance}|${r.prefix}`
    const route = routes.get(routeKey) ?? { instance, prefix: r.prefix, hops: [] }
    routes.set(routeKey, route)
    const entry: Hop = { node, key: hopKey(r.hop), hop: r.hop, ...(r.name !== undefined ? { name: r.name } : {}) }
    // The same next hop again edits it: the later statement replaces the earlier one, in its place.
    const same = route.hops.findIndex((h) => h.key === entry.key)
    if (same >= 0) {
      set(route.hops[same].node, ignored(`superseded by line ${line(node)}`))
      route.hops[same] = entry
    } else route.hops.push(entry)
    set(node, mapped([]))
  }

  /** `no ip route P [next hop]`: removes that next hop of the route, or every one when it names none. */
  const removeRoute = (node: NxNode, v6: boolean, instance: string): StatementDisposition => {
    const r = readRoute(node.words, 3, v6)
    if (!('prefix' in r)) return unsupported(r.reason)
    const route = routes.get(`${instance}|${r.prefix}`)
    const any = r.hop.address === undefined && r.hop.interface === undefined && r.hop.drop === undefined
    const removed = route?.hops.filter((h) => any || h.key === hopKey(r.hop)) ?? []
    if (!route || !removed.length) return ignored('no such route: nothing to convert')
    for (const h of removed) set(h.node, ignored(`removed by line ${line(node)}`))
    route.hops = route.hops.filter((h) => !removed.includes(h))
    return ignored(`removes the route on ${linesText(removed.map((h) => line(h.node)))}: nothing to convert`)
  }

  const buildRoutes = () => {
    for (const { instance, prefix, hops } of routes.values()) {
      const at = ['networkInstances', instance, 'staticRoutes', prefix]
      // NX-OS names each next hop; the model names the route. The first name wins: another is unsupported.
      const named = hops.find((h) => h.name !== undefined)
      let index = 0
      for (const h of hops) {
        if (named && h.name !== undefined && h.name !== named.name) {
          set(h.node, unsupported(`a second name for the route named on line ${line(named.node)}`))
          continue
        }
        const fields: string[] = []
        if (h.name !== undefined) fields.push(model.set([...at, 'description'], h.name))
        for (const [k, v] of Object.entries(h.hop)) fields.push(model.set([...at, 'nextHops', String(index), k], v))
        set(h.node, mapped(fields))
        index++
      }
    }
  }

  // ---- VRFs

  /** A `route-target import|export|both V` statement, with the directions it still sets (`no route-target` can take one). */
  type RouteTarget = { readonly node: NxNode; directions: ('import' | 'export')[]; readonly value: string }
  /**
   * Each VRF's `vrf context X` statements, so `no vrf context X` can remove them, and its route targets by address
   * family (`ipv4`, `ipv6` unicast), with the address family statements seen and the first route target statement not
   * converted: the VRF's route targets are a whole, so one left out leaves them all out.
   */
  type VrfState = { readonly contexts: NxNode[]; readonly families: Map<'ipv4' | 'ipv6', RouteTarget[]>; unconverted?: NxNode }
  const vrfs = new Map<string, VrfState>()
  const vrfOfName = (instance: string): VrfState => {
    const state = vrfs.get(instance) ?? { contexts: [], families: new Map() }
    vrfs.set(instance, state)
    return state
  }

  /**
   * `address-family ipv4|ipv6 unicast` inside `vrf context X`: its route targets. NX-OS sets them per address family;
   * the model holds one set for the VRF, so they map once every family's agree (once every statement is read).
   */
  const mapVrfFamily = (node: NxNode, instance: string, family: 'ipv4' | 'ipv6'): void => {
    const state = vrfOfName(instance)
    const targets = state.families.get(family) ?? []
    state.families.set(family, targets)
    set(node, ignored('an address family of the VRF: the model\'s VRFs carry every family'))
    for (const child of node.children) {
      const w = child.words
      const lw = w.map((x) => x.toLowerCase())
      if (child.kind !== 'statement' || child.children.length) unsupportedTree(child)
      else if (lw[0] === 'route-target' && w.length === 4 && lw[3] === 'evpn') set(child, unsupported('a route target for EVPN, which comes later'))
      else if (lw[0] === 'route-target' && w.length === 3 && (lw[1] === 'import' || lw[1] === 'export' || lw[1] === 'both') && isRouteDistinguisher(w[2])) {
        const directions: ('import' | 'export')[] = lw[1] === 'both' ? ['import', 'export'] : [lw[1]]
        targets.push({ node: child, directions, value: w[2] })
        set(child, mapped([]))
      } else if (lw[0] === 'no' && lw[1] === 'route-target' && w.length === 4 && (lw[2] === 'import' || lw[2] === 'export' || lw[2] === 'both')) {
        const directions = lw[2] === 'both' ? ['import', 'export'] : [lw[2]]
        const removed = targets.filter((t) => t.value === w[3] && t.directions.some((d) => directions.includes(d)))
        for (const t of removed) {
          t.directions = t.directions.filter((d) => !directions.includes(d))
          if (!t.directions.length) set(t.node, ignored(`removed by line ${line(child)}`))
        }
        targets.splice(0, targets.length, ...targets.filter((t) => t.directions.length))
        set(child, ignored(removed.length ? `removes the route target on ${linesText(removed.map((t) => line(t.node)))}: nothing to convert` : 'no such route target: nothing to convert'))
      } else {
        // `route-target both auto`, a malformed value: the VRF's route targets would be incomplete without it.
        set(child, unsupported(lw[0] === 'route-target' && lw[2] === 'auto' ? 'an automatic route target, which depends on the device\'s BGP AS' : undefined))
        if (lw[0] === 'route-target') state.unconverted ??= child
      }
    }
  }

  /** `vrf context X`: the VRF, with its route distinguisher, route targets and routes. */
  const mapVrfContext = (node: NxNode): void => {
    const w = node.words
    if (w.length !== 3) return unsupportedTree(node)
    const instance = w[2]
    const isDefault = instance === 'default'
    if (!isDefault) vrfOfName(instance).contexts.push(node)
    set(node, isDefault ? ignored('the global routing table, which needs no definition') : mapped([model.set(['networkInstances', instance, 'type'], 'vrf')]))
    const rd = ['networkInstances', instance, 'routeDistinguisher']
    for (const child of node.children) {
      const lw = child.words.map((x) => x.toLowerCase())
      const leaf = child.kind === 'statement' && !child.children.length
      if (!isDefault && child.kind === 'statement' && lw[0] === 'address-family' && child.words.length === 3 && (lw[1] === 'ipv4' || lw[1] === 'ipv6') && lw[2] === 'unicast') mapVrfFamily(child, instance, lw[1])
      else if (!isDefault && leaf && lw[0] === 'rd' && child.words.length === 2) {
        claim(`vrf ${instance} rd`, child, () => model.remove(rd))
        if (isRouteDistinguisher(child.words[1])) set(child, mapped([model.set(rd, child.words[1])]))
        else set(child, unsupported(lw[1] === 'auto' ? 'an automatic route distinguisher, which depends on the device\'s BGP router id' : 'not a route distinguisher in the form ASN:nn or IP:nn'))
      } else if (!isDefault && leaf && lw[0] === 'no' && lw[1] === 'rd' && child.words.length <= 3) set(child, unclaim(`vrf ${instance} rd`, child, 'route distinguisher', rd, 2))
      else if (leaf && (lw[0] === 'ip' || lw[0] === 'ipv6') && lw[1] === 'route') mapRoute(child, lw[0] === 'ipv6', instance)
      else if (child.kind === 'statement' && !child.children.length && lw[0] === 'no' && (lw[1] === 'ip' || lw[1] === 'ipv6') && lw[2] === 'route') set(child, removeRoute(child, lw[1] === 'ipv6', instance))
      else if (child.kind === 'statement' && !child.children.length && SHUTDOWN.test(lw[0]) && child.words.length === 1) {
        claim(`vrf ${instance} shutdown`, child)
        set(child, unsupported('a VRF shut down: the model has no switch for it'))
      } else if (child.kind === 'statement' && !child.children.length && lw[0] === 'no' && SHUTDOWN.test(lw[1] ?? '') && child.words.length === 2) {
        claim(`vrf ${instance} shutdown`, child)
        set(child, ignored('a VRF is up unless shut down: nothing to convert'))
      } else unsupportedTree(child)
    }
  }

  /** `no vrf context X`: removes the VRF and every route in it. */
  const removeVrfContext = (node: NxNode): StatementDisposition => {
    const w = node.words
    if (w.length !== 4 || w[3] === 'default') return unsupported()
    const instance = w[3]
    if (instance === 'management') return unsupported('the management VRF is built in: NX-OS can\'t remove it')
    const contexts = vrfs.get(instance)?.contexts ?? []
    const removed = [...contexts, ...[...routes.values()].filter((r) => r.instance === instance).flatMap((r) => r.hops.map((h) => h.node))]
    if (!removed.length) return ignored('no such VRF: nothing to convert')
    const why = ignored(`removed by line ${line(node)}`)
    // Everything inside the VRF goes with it: its route distinguisher, route targets and settings, converted or not.
    const inside = (n: NxNode): NxNode[] => n.children.flatMap((c) => (c.kind === 'comment' ? [] : [c, ...inside(c)]))
    for (const n of [...removed, ...contexts.flatMap(inside)]) set(n, why)
    for (const [key, r] of routes) if (r.instance === instance) routes.delete(key)
    for (const key of ['rd', 'shutdown']) owners.delete(`vrf ${instance} ${key}`)
    vrfs.delete(instance)
    model.prune(['networkInstances', instance], 0)
    // Its interfaces: NX-OS's guides don't say what they keep (#47), so their membership and their addresses so far are
    // left out, even if the VRF comes back; a later `vrf member` or `no vrf member` makes it certain again.
    for (const [key, m] of membership) {
      if (m.vrf !== instance || !m.node) continue
      set(m.node, uncertain(node))
      model.remove([...subPath(m.ctx), 'networkInstance'])
      for (const family of [4, 6] as const) {
        const state = addressing.get(`${m.ctx.name}|${m.ctx.sub}|${family}`)
        if (!state) continue
        for (const r of [...(state.primary ? [state.primary] : []), ...state.secondaries]) {
          if ('address' in r) model.remove([...familyPath(m.ctx, family), 'addresses', r.address])
          set(r.node, uncertain(node))
        }
        addressing.delete(`${m.ctx.name}|${m.ctx.sub}|${family}`)
        pruneFamily(m.ctx, family)
      }
      if (!m.ctx.isSub) pruneMain(m.ctx)
      membership.set(key, { ctx: m.ctx, vrf: instance, deletedBy: node })
    }
    // Its OSPF and BGP: the same holds, so what was configured in it up to here is left out too.
    dropBgp(instance, uncertain(node))
    for (const [key, s] of ospfScopes) {
      if (s.instance !== instance) continue
      for (const n of scopeStatements(s)) set(n, uncertain(node))
      ospfScopes.delete(key)
    }
    for (const [key, p] of ospfPorts) {
      if (p.enable?.value.instance !== instance) continue
      for (const n of portStatements(p)) set(n, uncertain(node))
      ospfPorts.delete(key)
    }
    return ignored(`removes the VRF and its routes (${linesText(removed.map(line).sort((a, b) => a - b))}): nothing to convert`)
  }

  // ---- DNS

  /** The statements that added each name server, by address, so `no ip name-server` can remove them. */
  const nameServerStatements = new Map<string, NxNode[]>()
  /** The servers each `ip name-server` statement added, and the fields it mapped. */
  const nameServerFields = new Map<NxNode, { keys: string[]; fields: string[] }>()

  /** `ip name-server A [B …] [use-vrf V]`: one statement can name several servers, in order. */
  const mapNameServers = (node: NxNode): StatementDisposition => {
    const w = node.words
    const lw = w.map((x) => x.toLowerCase())
    let end = w.length
    let vrf: string | undefined
    if (lw[end - 2] === 'use-vrf') {
      vrf = vrfName(w[end - 1])
      end -= 2
    }
    const addresses = w.slice(2, end)
    if (!addresses.length) return unsupported()
    const bad = addresses.find((a) => !isIpv4(a) && !isIpv6(a))
    if (bad !== undefined) return unsupported(`word ${w.indexOf(bad) + 1} isn't an address`)
    const keys = addresses.map((a) => (isIpv6(a) ? a.toLowerCase() : a))
    // The model keys servers by address alone: the same server in another VRF has nowhere to go.
    for (const key of keys) {
      const existing = model.get(['system', 'dns', 'servers', key])
      if (existing !== undefined && (existing as Obj).networkInstance !== vrf) return unsupported(`a server of line ${line(nameServerStatements.get(key)!.at(-1)!)} in another VRF: the model keys name servers by address alone`)
    }
    const fields = keys.map((key) => (vrf === undefined ? model.set(['system', 'dns', 'servers', key], model.get(['system', 'dns', 'servers', key]) ?? {}) : model.set(['system', 'dns', 'servers', key, 'networkInstance'], vrf)))
    for (const key of keys) nameServerStatements.set(key, [...(nameServerStatements.get(key) ?? []), node])
    nameServerFields.set(node, { keys, fields })
    return mapped(fields)
  }

  /** `no ip name-server A [B …] [use-vrf V]`: removes those servers, and what the statements that added them said. */
  const removeNameServers = (node: NxNode): StatementDisposition => {
    const w = node.words.slice(1)
    let end = w.length
    let vrf: string | undefined
    if (w[end - 2]?.toLowerCase() === 'use-vrf') {
      vrf = vrfName(w[end - 1])
      end -= 2
    }
    const keys = w.slice(2, end).map((a) => (isIpv6(a) ? a.toLowerCase() : a))
    if (!keys.length || !keys.every((a) => isIpv4(a) || isIpv6(a))) return unsupported()
    const lines: number[] = []
    for (const key of keys) {
      // Only the server in the VRF the `no` names (no VRF and `default` alike): one in another VRF stays.
      const existing = model.get(['system', 'dns', 'servers', key])
      if (existing === undefined || (existing as Obj).networkInstance !== vrf) continue
      for (const added of nameServerStatements.get(key) ?? []) {
        const entry = nameServerFields.get(added)!
        entry.keys = entry.keys.filter((k) => k !== key)
        entry.fields = entry.fields.filter((f) => f !== fieldPath('system', 'dns', 'servers', key) && !f.startsWith(`${fieldPath('system', 'dns', 'servers', key)}.`))
        set(added, entry.keys.length ? mapped(entry.fields) : ignored(`removed by line ${line(node)}`))
        lines.push(line(added))
      }
      nameServerStatements.delete(key)
      model.prune(['system', 'dns', 'servers', key], 0)
    }
    return ignored(lines.length ? `removes name servers configured on ${linesText([...new Set(lines)].sort((a, b) => a - b))}: nothing to convert` : 'no such name server in that VRF: nothing to convert')
  }

  /** The statement that added each search domain. */
  const searchStatements = new Map<string, NxNode>()

  const mapDomainList = (node: NxNode, remove: boolean): StatementDisposition => {
    const w = node.words.slice(remove ? 1 : 0)
    if (w.length !== 3) return unsupported()
    const domain = w[2]
    const search = (model.get(['system', 'dns', 'search']) as string[] | undefined) ?? []
    if (remove) {
      const added = searchStatements.get(domain)
      if (!added) return ignored('not in the search list: nothing to convert')
      searchStatements.delete(domain)
      set(added, ignored(`removed by line ${line(node)}`))
      const rest = search.filter((d) => d !== domain)
      if (rest.length) model.set(['system', 'dns', 'search'], rest)
      else model.prune(['system', 'dns', 'search'], 0)
      return ignored(`removes the search domain on line ${line(added)}: nothing to convert`)
    }
    if (search.includes(domain)) return ignored('already in the search list')
    searchStatements.set(domain, node)
    return mapped([model.set(['system', 'dns', 'search'], [...search, domain])])
  }

  // ---- NTP, logging, SNMP

  const mapNtp = (node: NxNode): StatementDisposition => {
    const w = node.words
    const lw = w.map((x) => x.toLowerCase())
    if (lw[1] === 'source-interface' && w.length >= 3) {
      const n = interfaceName(w, 2)
      if (!n || 2 + n.used !== w.length) return unsupported()
      claim('ntp source', node)
      return mapped([model.set(['system', 'ntp', 'sourceInterface'], n.name)])
    }
    if (lw[1] !== 'server') return unsupported()
    const address = w[2]
    if (!address || !(isIpv4(address) || isIpv6(address) || HOST.test(address))) return unsupported()
    const key = isIpv6(address) ? address.toLowerCase() : address
    const at = ['system', 'ntp', 'servers', key]
    const server: Obj = {}
    let vrfGiven = false
    for (let i = 3; i < w.length; ) {
      if (lw[i] === 'prefer' && server.prefer === undefined) {
        server.prefer = true
        i++
      } else if (lw[i] === 'use-vrf' && w[i + 1] !== undefined && !vrfGiven) {
        const vrf = vrfName(w[i + 1])
        vrfGiven = true
        if (vrf !== undefined) server.networkInstance = vrf
        i += 2
      } else return unsupported(`word ${i + 1} isn't converted yet`)
    }
    claim(fieldPath(...at), node, () => model.remove(at))
    if (!Object.keys(server).length) return mapped([model.set(at, {})])
    return mapped(Object.entries(server).map(([k, v]) => model.set([...at, k], v)))
  }

  const mapLogging = (node: NxNode): StatementDisposition => {
    const w = node.words
    const lw = w.map((x) => x.toLowerCase())
    if (lw[1] === 'source-interface' && w.length >= 3) {
      const n = interfaceName(w, 2)
      if (!n || 2 + n.used !== w.length) return unsupported()
      claim('logging source', node)
      return mapped([model.set(['system', 'logging', 'sourceInterface'], n.name)])
    }
    if (lw[1] !== 'server' || !w[2] || !(isIpv4(w[2]) || isIpv6(w[2]) || HOST.test(w[2]))) return unsupported()
    const address = isIpv6(w[2]) ? w[2].toLowerCase() : w[2]
    const server: Obj = {}
    let i = 3
    if (/^[0-7]$/.test(w[i] ?? '')) {
      server.severity = SEVERITY_LEVELS[Number(w[i])]
      i++
    }
    if (lw[i] === 'port' && INTEGER.test(w[i + 1] ?? '') && Number(w[i + 1]) >= 1 && Number(w[i + 1]) <= 65535) {
      server.port = Number(w[i + 1])
      i += 2
    }
    if (lw[i] === 'use-vrf' && w[i + 1] !== undefined) {
      const vrf = vrfName(w[i + 1])
      if (vrf !== undefined) server.networkInstance = vrf
      i += 2
    }
    if (lw[i] === 'facility' && /^[a-z][a-z0-9]*$/.test(lw[i + 1] ?? '')) {
      server.facility = lw[i + 1]
      i += 2
    }
    if (i < w.length) return unsupported(`word ${i + 1} isn't converted yet`)
    const at = ['system', 'logging', 'remoteServers', address]
    claim(fieldPath(...at), node, () => model.remove(at))
    if (!Object.keys(server).length) return mapped([model.set(at, {})])
    return mapped(Object.entries(server).map(([k, v]) => model.set([...at, k], v)))
  }

  /**
   * Every statement about each SNMP community, by name (a Map: names are any string), and the first one not converted:
   * it may limit or change the community (an access list, a group), so the community is then left out whole.
   */
  const communities = new Map<string, { nodes: NxNode[]; unconverted?: NxNode }>()
  const communityOf = (name: string) => {
    const state = communities.get(name) ?? { nodes: [] }
    communities.set(name, state)
    return state
  }

  // Community names are secrets: no disposition reason or diagnostic here repeats a word of the statement.
  const mapSnmp = (node: NxNode): StatementDisposition => {
    const w = node.words
    const lw = w.map((x) => x.toLowerCase())
    if ((lw[1] === 'location' || lw[1] === 'contact') && w.length > 2) {
      claim(`snmp ${lw[1]}`, node)
      return mapped([model.set(['system', 'snmp', lw[1]], node.text.replace(/^\S+\s+\S+\s+/, ''))])
    }
    if (lw[1] !== 'community' || w.length < 3) return unsupported()
    const name = unquote(w[2])
    const state = communityOf(name)
    state.nodes.push(node)
    const d = mapCommunity(w, lw, name, node)
    if (d.kind === 'unsupported') state.unconverted ??= node
    return d
  }

  const mapCommunity = (w: readonly string[], lw: readonly string[], name: string, node: NxNode): StatementDisposition => {
    const at = ['system', 'snmp', 'communities', name]
    // An access list in any form (`use-acl`, or `use-ipv4acl` and `use-ipv6acl` together on one line) limits it.
    if (lw.slice(3).some((x) => x === 'use-acl' || x === 'use-ipv4acl' || x === 'use-ipv6acl')) return unsupported('limits the community to some clients with an access list, which comes with filters')
    let access: 'read-only' | 'read-write' | undefined
    if (w.length === 4 && (lw[3] === 'ro' || lw[3] === 'rw')) access = lw[3] === 'ro' ? 'read-only' : 'read-write'
    else if (w.length === 5 && lw[3] === 'group' && (lw[4] === SNMP_GROUPS['read-only'] || lw[4] === SNMP_GROUPS['read-write'])) access = lw[4] === SNMP_GROUPS['read-only'] ? 'read-only' : 'read-write'
    else if (w.length === 5 && lw[3] === 'group') return unsupported('a community in a group other than network-operator or network-admin')
    else if (w.length !== 3) return unsupported()
    if (access === undefined) {
      if (model.get(at) === undefined) model.set(at, {})
      return mapped([fieldPath(...at)])
    }
    claim(`${fieldPath(...at)}.access`, node)
    return mapped([model.set([...at, 'access'], access)])
  }

  /** `no snmp-server community X`: removes the community and every statement about it before. */
  const removeCommunity = (node: NxNode): StatementDisposition => {
    const w = node.words
    if (w.length < 4) return unsupported()
    const name = unquote(w[3])
    if (w.length > 4) {
      // Removing part of a community (its access list, its group) would leave it changed in a way the model can't
      // follow: the community is left out whole.
      const state = communityOf(name)
      state.nodes.push(node)
      state.unconverted ??= node
      return unsupported('removes part of a community: the community is left out whole')
    }
    const state = communities.get(name)
    if (!state) return ignored('no such community: nothing to convert')
    for (const n of state.nodes) set(n, ignored(`removed by line ${line(node)}`))
    communities.delete(name)
    owners.delete(`${fieldPath('system', 'snmp', 'communities', name)}.access`)
    model.prune(['system', 'snmp', 'communities', name], 0)
    return ignored('removes the community configured before it: nothing to convert')
  }

  // ---- VLANs

  /** Per VLAN ID, the statements that define and name it, so `no vlan` can remove them; and the IDs each one is about. */
  const vlanStatements = new Map<number, NxNode[]>()
  const vlansOf = new Map<NxNode, number[]>()

  /** `vlan 10` or `vlan 4,6-8`, with a `name` for one VLAN: each VLAN of the list, by ID. */
  const mapVlan = (node: NxNode): void => {
    const w = node.words
    const entries = w.length === 2 ? vlanEntries(w[1]) : null
    if (!entries) return unsupportedTree(node, w.length === 2 && /^[\d,-]+$/.test(w[1]) ? 'not a list of VLAN IDs from 1 to 4094' : undefined)
    const ids = vlanIds(entries)
    const said = (n: NxNode) => {
      vlansOf.set(n, ids)
      for (const id of ids) vlanStatements.set(id, [...(vlanStatements.get(id) ?? []), n])
    }
    said(node)
    set(node, mapped(ids.map((id) => (model.get(['vlans', String(id)]) === undefined ? model.set(['vlans', String(id)], {}) : fieldPath('vlans', String(id))))))
    for (const child of node.children) {
      const cw = child.words
      const lw = cw.map((x) => x.toLowerCase())
      if (child.kind === 'comment') set(child, ignored('a comment'))
      else if (child.children.length) unsupportedTree(child)
      else if (lw[0] === 'name' && cw.length === 2) {
        if (ids.length > 1) {
          set(child, unsupported('one name for several VLANs'))
          continue
        }
        claim(`vlan ${ids[0]} name`, child)
        said(child)
        set(child, mapped([model.set(['vlans', String(ids[0]), 'name'], unquote(cw[1]))]))
      } else if (lw[0] === 'no' && lw[1] === 'name' && cw.length <= 3 && ids.length === 1) set(child, unclaim(`vlan ${ids[0]} name`, child, 'VLAN name', ['vlans', String(ids[0]), 'name'], 2))
      else unsupportedTree(child)
    }
  }

  /** `no vlan LIST`: removes those VLANs, with their names. A statement about other VLANs too keeps those. */
  const removeVlan = (node: NxNode): StatementDisposition => {
    const w = node.words
    const entries = w.length === 3 ? vlanEntries(w[2]) : null
    if (!entries) return unsupported()
    const ids = vlanIds(entries)
    if (ids.includes(1)) return unsupported('VLAN 1 is built in: NX-OS can\'t remove it')
    const removed = new Set<NxNode>()
    for (const id of ids) {
      for (const n of vlanStatements.get(id) ?? []) removed.add(n)
      vlanStatements.delete(id)
      owners.delete(`vlan ${id} name`)
      model.prune(['vlans', String(id)], 0)
    }
    if (!removed.size) return ignored('no such VLAN: nothing to convert')
    for (const n of removed) {
      if (dispositions[n.id]?.kind !== 'mapped') continue
      const left = (vlansOf.get(n) ?? []).filter((id) => vlanStatements.get(id)?.includes(n))
      set(n, left.length ? mapped(left.map((id) => fieldPath('vlans', String(id)))) : ignored(`removed by line ${line(node)}`))
    }
    return ignored(`removes what line${removed.size > 1 ? 's' : ''} ${[...new Set([...removed].map(line))].sort((a, b) => a - b).join(', ')} configured: nothing to convert`)
  }

  // ---- OSPF

  /** A setting and the statement that gave it. */
  type Said<T> = { readonly node: NxNode; readonly value: T }
  /** A later statement replaces the earlier one, as on the device. */
  const replace = <T>(previous: Said<T> | undefined, node: NxNode, value: T): Said<T> => {
    if (previous && previous.node !== node) set(previous.node, ignored(`superseded by line ${line(node)}`))
    return { node, value }
  }
  type OspfAreaState = { type?: Said<'stub' | 'nssa'>; authentication?: Said<OspfAuthentication> }
  /**
   * One OSPF process in one network instance: `router ospf TAG` for the global table, `vrf V` inside it for V. The
   * statements that open it and its settings; the model is built from them once every statement is read, since a
   * network instance has one process in the model.
   */
  type OspfScope = { readonly tag: string; readonly instance: string; readonly opened: NxNode[]; routerId?: Said<string>; passiveDefault?: NxNode; readonly areas: Map<string, OspfAreaState> }
  const ospfScopes = new Map<string, OspfScope>()
  const ospfScope = (tag: string, instance: string): OspfScope => {
    const key = JSON.stringify([tag, instance])
    const scope = ospfScopes.get(key) ?? { tag, instance, opened: [], areas: new Map() }
    ospfScopes.set(key, scope)
    return scope
  }
  const hasSettings = (s: OspfScope) => s.routerId !== undefined || s.passiveDefault !== undefined || s.areas.size > 0
  const scopeStatements = (s: OspfScope): NxNode[] => [...s.opened, ...[s.routerId?.node, s.passiveDefault, ...[...s.areas.values()].flatMap((a) => [a.type?.node, a.authentication?.node])].filter((n) => n !== undefined)]

  /** An interface's OSPF settings (`ip router ospf`, `ip ospf …`), with the network instance it was in when enabled. */
  type OspfPort = {
    readonly ctx: InterfaceContext
    enable?: Said<{ readonly tag: string; readonly area: string; readonly instance: string }>
    cost?: Said<number>
    networkType?: Said<OspfNetworkType>
    passive?: Said<true>
    noPassive?: Said<false>
    helloInterval?: Said<number>
    deadInterval?: Said<number>
    authentication?: Said<OspfAuthentication>
  }
  const PORT_SETTINGS = ['cost', 'networkType', 'passive', 'helloInterval', 'deadInterval', 'authentication'] as const
  /** The settings `no ip ospf <word>` takes back, by the word. */
  const PORT_NEGATIONS = new Map<string, 'cost' | 'helloInterval' | 'deadInterval' | 'networkType' | 'authentication'>([['cost', 'cost'], ['hello-interval', 'helloInterval'], ['dead-interval', 'deadInterval'], ['network', 'networkType'], ['authentication', 'authentication']])
  const ospfPorts = new Map<string, OspfPort>()
  const ospfPort = (ctx: InterfaceContext): OspfPort => {
    const key = `${ctx.name}|${ctx.sub}`
    const port = ospfPorts.get(key) ?? { ctx }
    ospfPorts.set(key, port)
    return port
  }
  const portStatements = (p: OspfPort): NxNode[] => [p.enable?.node, ...PORT_SETTINGS.map((k) => p[k]?.node), p.noPassive?.node].filter((n) => n !== undefined)
  /** Clears an interface's OSPF settings (moving it to another VRF deletes its Layer 3 configuration), each marked `d`. */
  const clearOspfPort = (ctx: InterfaceContext, d: StatementDisposition) => {
    const port = ospfPorts.get(`${ctx.name}|${ctx.sub}`)
    if (!port) return
    for (const n of portStatements(port)) set(n, d)
    ospfPorts.delete(`${ctx.name}|${ctx.sub}`)
  }

  /** `router ospf TAG`: the process's settings for the global table, and inside `vrf V` for V. */
  const mapRouterOspf = (node: NxNode): void => {
    const w = node.words
    if (w.length !== 3) return unsupportedTree(node)
    const scope = ospfScope(w[2], 'default')
    scope.opened.push(node)
    set(node, mapped([]))
    for (const child of node.children) {
      const cw = child.words
      if (child.kind === 'statement' && cw[0].toLowerCase() === 'vrf' && cw.length === 2 && cw[1] !== 'default') {
        const vrf = ospfScope(w[2], cw[1])
        vrf.opened.push(child)
        set(child, mapped([]))
        for (const c of child.children) mapOspfSetting(c, vrf)
      } else mapOspfSetting(child, scope)
    }
  }

  /** One of a process's settings, in the global table or a VRF. Its fields are set once the model is built. */
  const mapOspfSetting = (node: NxNode, scope: OspfScope): void => {
    if (node.kind === 'comment') return set(node, ignored('a comment'))
    if (node.children.length) return unsupportedTree(node)
    const w = node.words
    const lw = w.map((x) => x.toLowerCase())
    const no = lw[0] === 'no'
    const area = lw[no ? 1 : 0] === 'area' ? areaId(w[no ? 2 : 1] ?? '') : null
    const areaOf = (id: string) => {
      const a = scope.areas.get(id) ?? {}
      scope.areas.set(id, a)
      return a
    }
    if (lw[0] === 'router-id' && w.length === 2 && isIpv4(w[1])) {
      scope.routerId = replace(scope.routerId, node, w[1])
      return set(node, mapped([]))
    }
    if (no && lw[1] === 'router-id' && w.length <= 3) {
      const previous = scope.routerId
      scope.routerId = undefined
      if (previous) set(previous.node, ignored(`removed by line ${line(node)}`))
      return set(node, ignored(previous ? `removes the router ID on line ${line(previous.node)}: nothing to convert` : 'no router ID to remove: nothing to convert'))
    }
    if (!no && area !== null && w.length === 3 && (lw[2] === 'stub' || lw[2] === 'nssa')) {
      if (area === '0.0.0.0') return set(node, unsupported('the backbone area is never a stub or NSSA'))
      const a = areaOf(area)
      a.type = replace(a.type, node, lw[2])
      return set(node, mapped([]))
    }
    if (!no && area !== null && lw[2] === 'authentication' && (w.length === 3 || (w.length === 4 && lw[3] === 'message-digest'))) {
      const a = areaOf(area)
      a.authentication = replace(a.authentication, node, w.length === 3 ? 'simple' : 'md5')
      return set(node, mapped([]))
    }
    if (no && area !== null && (lw[3] === 'stub' || lw[3] === 'nssa' || lw[3] === 'authentication')) {
      const a = scope.areas.get(area)
      const field = lw[3] === 'authentication' ? 'authentication' : 'type'
      const previous = a?.[field]
      if (!a || !previous || (field === 'type' && previous.value !== lw[3])) return set(node, ignored('no such area setting to remove: nothing to convert'))
      a[field] = undefined
      set(previous.node, ignored(`removed by line ${line(node)}`))
      return set(node, ignored(`removes the area setting on line ${line(previous.node)}: nothing to convert`))
    }
    if (lw[0] === 'passive-interface' && lw[1] === 'default' && w.length === 2) {
      if (scope.passiveDefault) set(scope.passiveDefault, ignored(`superseded by line ${line(node)}`))
      scope.passiveDefault = node
      return set(node, mapped([]))
    }
    if (no && lw[1] === 'passive-interface' && lw[2] === 'default' && w.length === 3) {
      const previous = scope.passiveDefault
      scope.passiveDefault = undefined
      if (previous) set(previous, ignored(`removed by line ${line(node)}`))
      return set(node, ignored(previous ? `removes the passive default on line ${line(previous)}: nothing to convert` : 'no passive default to remove: nothing to convert'))
    }
    if (lw[0] === 'network') return set(node, unsupported('a network statement, which NX-OS no longer documents: OSPF is converted where an interface enables it (ip router ospf)'))
    unsupportedTree(node)
  }

  /** `no router ospf TAG`: removes the process's settings. Interfaces that enable it are left out: what they keep isn't certain. */
  const removeRouterOspf = (node: NxNode): StatementDisposition => {
    const w = node.words
    if (w.length !== 4) return unsupported()
    const tag = w[3]
    const removed: NxNode[] = []
    for (const [key, s] of ospfScopes) {
      if (s.tag !== tag) continue
      removed.push(...scopeStatements(s))
      ospfScopes.delete(key)
    }
    for (const n of removed) set(n, ignored(`removed by line ${line(node)}`))
    for (const p of ospfPorts.values()) {
      if (p.enable?.value.tag !== tag) continue
      set(p.enable.node, unsupported(`enables an OSPF process line ${line(node)} removes: what the device keeps of it isn't certain`))
      p.enable = undefined
    }
    return ignored(removed.length ? `removes the OSPF process (${linesText(removed.map(line).sort((a, b) => a - b))}): nothing to convert` : 'no such OSPF process: nothing to convert')
  }

  /** `no feature ospf`: OSPF's configuration goes with it. Whether the device keeps any is not guessed: left out. */
  const clearOspf = (node: NxNode) => {
    const why = unsupported(`OSPF's, which line ${line(node)} turns off: left out`)
    for (const s of ospfScopes.values()) for (const n of scopeStatements(s)) set(n, why)
    for (const p of ospfPorts.values()) for (const n of portStatements(p)) set(n, why)
    ospfScopes.clear()
    ospfPorts.clear()
  }

  /** `ip router ospf TAG area A`: OSPF runs on the interface, in the network instance it is in. */
  const mapOspfEnable = (node: NxNode, ctx: InterfaceContext): StatementDisposition => {
    const w = node.words
    const area = w.length === 6 && w[4].toLowerCase() === 'area' ? areaId(w[5]) : null
    if (area === null) return unsupported(w.length > 6 && w[4].toLowerCase() === 'area' ? 'word 7 isn\'t converted yet' : undefined)
    const member = vrfOf(ctx)
    if (member.deletedBy) return uncertain(member.deletedBy)
    const port = ospfPort(ctx)
    port.enable = replace(port.enable, node, { tag: w[3], area, instance: member.vrf })
    return mapped([])
  }

  /** `no ip router ospf TAG [area A]`: OSPF no longer runs on the interface. */
  const removeOspfEnable = (node: NxNode, ctx: InterfaceContext): StatementDisposition => {
    const w = node.words
    if (w.length !== 5 && !(w.length === 7 && w[5].toLowerCase() === 'area')) return unsupported()
    const port = ospfPorts.get(`${ctx.name}|${ctx.sub}`)
    const enable = port?.enable
    const area = w.length === 7 ? areaId(w[6]) : undefined
    if (!port || !enable || enable.value.tag !== w[4] || (area !== undefined && area !== enable.value.area)) return ignored('OSPF isn\'t enabled so on the interface: nothing to convert')
    port.enable = undefined
    set(enable.node, ignored(`removed by line ${line(node)}`))
    return ignored(`removes the OSPF enablement on line ${line(enable.node)}: nothing to convert`)
  }

  /** `ip ospf cost|network|passive-interface|hello-interval|dead-interval|authentication …` on an interface. */
  const mapOspfPort = (node: NxNode, ctx: InterfaceContext): StatementDisposition => {
    const w = node.words
    const lw = w.map((x) => x.toLowerCase())
    const port = ospfPort(ctx)
    const number = (field: 'cost' | 'helloInterval' | 'deadInterval'): StatementDisposition => {
      const n = w.length === 4 ? inRange(w[3], 1, 65535) : null
      if (n === null) return unsupported('not a number from 1 to 65535')
      port[field] = replace(port[field], node, n)
      return mapped([])
    }
    if (lw[2] === 'cost') return number('cost')
    if (lw[2] === 'hello-interval') return number('helloInterval')
    if (lw[2] === 'dead-interval') return number('deadInterval')
    if (lw[2] === 'network' && w.length === 4 && (lw[3] === 'point-to-point' || lw[3] === 'broadcast')) {
      port.networkType = replace(port.networkType, node, lw[3])
      return mapped([])
    }
    if (lw[2] === 'passive-interface' && w.length === 3) {
      if (port.noPassive) set(port.noPassive.node, ignored(`superseded by line ${line(node)}`))
      port.noPassive = undefined
      port.passive = replace(port.passive, node, true)
      return mapped([])
    }
    if (lw[2] === 'authentication') {
      if (lw[3] === 'null' && w.length === 4) return unsupported('no authentication on the interface, whatever its area has: the model can\'t say it')
      const kind: OspfAuthentication | undefined = w.length === 3 ? 'simple' : w.length === 4 && lw[3] === 'message-digest' ? 'md5' : w.length === 5 && lw[3] === 'key-chain' ? 'key-chain' : undefined
      if (!kind) return unsupported()
      port.authentication = replace(port.authentication, node, kind)
      return mapped([])
    }
    // The key is a secret: never carried. The model flags the authentication, and the target asks for the key.
    if (lw[2] === 'authentication-key' || lw[2] === 'message-digest-key') return ignored('an OSPF key: never carried, the target asks for it')
    return unsupported()
  }

  /** `no ip ospf …`: the setting goes back to NX-OS's default; `no ip ospf passive-interface` says the interface isn't passive. */
  const removeOspfPort = (node: NxNode, ctx: InterfaceContext): StatementDisposition => {
    const lw = node.words.map((x) => x.toLowerCase())
    if (lw[3] === 'authentication-key' || lw[3] === 'message-digest-key') return ignored('removes an OSPF key, which is never carried: nothing to convert')
    const port = ospfPort(ctx)
    if (lw[3] === 'passive-interface' && lw.length === 4) {
      // Not passive, even under `passive-interface default`: decided once every statement is read.
      if (port.passive) set(port.passive.node, ignored(`superseded by line ${line(node)}`))
      port.passive = undefined
      port.noPassive = replace(port.noPassive, node, false)
      return mapped([])
    }
    const field = PORT_NEGATIONS.get(lw[3])
    if (!field) return unsupported()
    const previous = port[field]
    if (!previous) return ignored('no such OSPF setting on the interface: nothing to convert')
    port[field] = undefined
    set(previous.node, ignored(`removed by line ${line(node)}`))
    return ignored(`removes the OSPF setting on line ${line(previous.node)}: nothing to convert`)
  }

  /** Whether a network instance exists in the model: the global table, or a VRF the text defines (and hasn't deleted). */
  const instanceDefined = (instance: string) => instance === 'default' || model.get(['networkInstances', instance, 'type']) === 'vrf'

  /**
   * OSPF into the model, once every statement is read. The model has one process per network instance: the one its
   * interfaces enable first, else the first with settings there, else the first. Another one's settings and interfaces
   * there are left out.
   */
  const buildOspf = () => {
    const scopes = [...ospfScopes.values()]
    const ports = [...ospfPorts.values()]
    const enabled = ports.filter((p) => p.enable !== undefined).sort((a, b) => line(a.enable!.node) - line(b.enable!.node))
    for (const s of scopes) if (!instanceDefined(s.instance)) for (const n of scopeStatements(s)) set(n, unsupported('an OSPF process in a VRF the configuration doesn\'t define'))
    for (const p of enabled) if (!instanceDefined(p.enable!.value.instance)) for (const n of portStatements(p)) set(n, unsupported('OSPF on an interface in a VRF the configuration doesn\'t define'))

    const owner = new Map<string, string>()
    for (const p of enabled) if (instanceDefined(p.enable!.value.instance) && !owner.has(p.enable!.value.instance)) owner.set(p.enable!.value.instance, p.enable!.value.tag)
    for (const pass of [true, false]) for (const s of scopes) if (instanceDefined(s.instance) && !owner.has(s.instance) && (!pass || hasSettings(s))) owner.set(s.instance, s.tag)
    const add = (node: NxNode, field: string) => {
      const d = dispositions[node.id]
      set(node, mapped([...(d?.kind === 'mapped' ? d.fields : []), field]))
    }

    for (const [instance, tag] of owner) {
      const at = ['networkInstances', instance, 'ospf']
      const processId = model.set([...at, 'processId'], tag)
      const scope = ospfScopes.get(JSON.stringify([tag, instance]))
      if (scope) {
        for (const n of scope.opened) add(n, processId)
        if (scope.routerId) set(scope.routerId.node, mapped([model.set([...at, 'routerId'], scope.routerId.value)]))
        for (const [id, a] of scope.areas) {
          for (const k of ['type', 'authentication'] as const) {
            const said = a[k]
            if (said) set(said.node, mapped([model.set([...at, 'areas', id, k], said.value)]))
          }
        }
      }
      const passive: string[] = []
      for (const p of enabled) {
        const { tag: t, area, instance: i } = p.enable!.value
        if (i !== instance || t !== tag) continue
        const entry = [...at, 'areas', area, 'interfaces', p.ctx.isSub ? `${p.ctx.name}.${p.ctx.sub}` : p.ctx.name]
        set(p.enable!.node, mapped([model.set([...entry, 'enabledBy'], 'interface'), ...(scope ? [] : [processId])]))
        for (const k of PORT_SETTINGS) {
          const said = p[k]
          if (said) set(said.node, mapped([model.set([...entry, k], said.value)]))
        }
        if (scope?.passiveDefault && !p.passive && !p.noPassive) passive.push(model.set([...entry, 'passive'], true))
        if (p.noPassive) set(p.noPassive.node, ignored(scope?.passiveDefault ? 'not passive, overriding passive-interface default: written back as the interface\'s own setting is' : 'not passive, as an interface is unless set: nothing to convert'))
      }
      if (scope?.passiveDefault) set(scope.passiveDefault, passive.length ? mapped(passive) : ignored('no OSPF interface for it to make passive: nothing to convert'))
    }

    for (const s of scopes) {
      if (!instanceDefined(s.instance) || owner.get(s.instance) === s.tag) continue
      if (hasSettings(s)) for (const n of scopeStatements(s)) set(n, unsupported('a second OSPF process in the same table: the model has one per network instance'))
      else for (const n of s.opened) set(n, ignored('a second OSPF process, with nothing of its own in this table: nothing to convert'))
    }
    for (const p of ports) {
      const e = p.enable?.value
      if (e && !instanceDefined(e.instance)) continue
      if (e && owner.get(e.instance) !== e.tag) for (const n of portStatements(p)) set(n, unsupported('OSPF on an interface, in a second process of its table: the model has one per network instance'))
      else if (!e) for (const n of portStatements(p)) set(n, unsupported('an OSPF setting on an interface with no ip router ospf that converts'))
    }
  }

  // ---- BGP

  /** The AS of `router bgp`, and the statement that gave it: NX-OS runs one BGP process. */
  let bgpAs: Said<number> | undefined
  const bgpPath = (instance: string) => ['networkInstances', instance, 'bgp']
  /** Per network instance, every statement that put some of its BGP in the model, so a VRF's deletion can take it out. */
  const bgpStatements = new Map<string, NxNode[]>()
  /** Per peer (a neighbor or a template), its statements, so `no neighbor` can remove them; and per peer address family. */
  const peerStatements = new Map<string, NxNode[]>()
  const peerKey = (...path: Segments) => fieldPath(...path)
  const track = (instance: string, node: NxNode, ...peers: string[]) => {
    bgpStatements.set(instance, [...(bgpStatements.get(instance) ?? []), node])
    for (const p of peers) peerStatements.set(p, [...(peerStatements.get(p) ?? []), node])
  }
  const neighborKey = (address: string) => (isIpv6(address) ? address.toLowerCase() : address)
  /** The settings `no <word>` takes back from a peer, by the word: the field and what to call it. */
  const PEER_NEGATIONS = new Map<string, [field: string, what: string]>([['remote-as', ['peerAs', 'remote AS']], ['description', ['description', 'description']], ['update-source', ['updateSource', 'update source']], ['ebgp-multihop', ['multihop', 'eBGP multihop']], ['password', ['authentication', 'password']], ['inherit', ['group', 'template']]])

  /** Takes a network instance's BGP out of the model, each statement still mapped marked `d`. */
  const dropBgp = (instance: string, d: StatementDisposition) => {
    for (const n of bgpStatements.get(instance) ?? []) if (dispositions[n.id]?.kind === 'mapped') set(n, d)
    const prefix = peerKey(...bgpPath(instance))
    for (const key of peerStatements.keys()) if (key.startsWith(`${prefix}.`) || key.startsWith(`${prefix}[`)) peerStatements.delete(key)
    bgpStatements.delete(instance)
    dropOwners(bgpPath(instance))
    model.prune(bgpPath(instance), 0)
  }

  /** `router bgp ASN`: BGP in the global table, and inside `vrf V` in V. */
  const mapRouterBgp = (node: NxNode): void => {
    const w = node.words
    const as = w.length === 3 ? asNumber(w[2]) : null
    if (as === null) return unsupportedTree(node, w.length === 3 ? 'not an AS number from 1 to 4294967295' : undefined)
    if (bgpAs && bgpAs.value !== as) return unsupportedTree(node, `a second BGP AS beside line ${line(bgpAs.node)}'s: NX-OS runs one BGP process`)
    bgpAs ??= { node, value: as }
    track('default', node)
    set(node, mapped([model.set([...bgpPath('default'), 'localAs'], as)]))
    for (const child of node.children) mapBgpChild(child, 'default', as)
  }

  const mapBgpChild = (node: NxNode, instance: string, as: number): void => {
    if (node.kind === 'comment') return set(node, ignored('a comment'))
    const w = node.words
    const lw = w.map((x) => x.toLowerCase())
    const at = bgpPath(instance)
    const leaf = !node.children.length
    if (leaf && lw[0] === 'router-id' && w.length === 2 && isIpv4(w[1])) {
      claim(fieldPath(...at, 'routerId'), node)
      track(instance, node)
      return set(node, mapped([model.set([...at, 'routerId'], w[1])]))
    }
    if (leaf && lw[0] === 'no' && lw[1] === 'router-id' && w.length <= 3) return set(node, unclaim(fieldPath(...at, 'routerId'), node, 'router ID', [...at, 'routerId'], at.length))
    if (lw[0] === 'address-family' && w.length === 3 && (lw[1] === 'ipv4' || lw[1] === 'ipv6') && lw[2] === 'unicast') {
      set(node, ignored('the address family itself: written back whenever a neighbor carries it'))
      for (const child of node.children) unsupportedTree(child)
      return
    }
    if (lw[0] === 'neighbor') return mapPeer(node, instance, 'neighbors')
    if (lw[0] === 'template' && lw[1] === 'peer' && instance === 'default') return mapPeer(node, instance, 'groups')
    if (leaf && lw[0] === 'no' && lw[1] === 'neighbor' && w.length === 3) return set(node, removePeer(node, instance, 'neighbors', neighborKey(w[2])))
    if (leaf && lw[0] === 'no' && lw[1] === 'template' && lw[2] === 'peer' && w.length === 4 && instance === 'default') return set(node, removePeer(node, instance, 'groups', w[3]))
    if (lw[0] === 'vrf' && w.length === 2 && instance === 'default' && w[1] !== 'default') {
      track(w[1], node)
      set(node, mapped([model.set([...bgpPath(w[1]), 'localAs'], as)]))
      for (const child of node.children) mapBgpChild(child, w[1], as)
      return
    }
    unsupportedTree(node)
  }

  /** `neighbor X [remote-as N]` or `template peer T`, with what is inside it. */
  const mapPeer = (node: NxNode, instance: string, kind: 'neighbors' | 'groups'): void => {
    const w = node.words
    let key: string
    let rest: readonly string[]
    if (kind === 'neighbors') {
      if (w[1] === undefined || !(isIpv4(w[1]) || isIpv6(w[1]))) return unsupportedTree(node, w[1]?.includes('/') ? 'a range of neighbors (dynamic peers), which comes later' : undefined)
      key = neighborKey(w[1])
      rest = w.slice(2)
    } else {
      if (w.length !== 3) return unsupportedTree(node)
      key = w[2]
      rest = []
    }
    let peerAs: number | undefined
    if (rest.length === 2 && rest[0].toLowerCase() === 'remote-as') {
      const n = asNumber(rest[1])
      if (n === null) return unsupportedTree(node, 'not an AS number from 1 to 4294967295')
      peerAs = n
    } else if (rest.length) return unsupportedTree(node)
    const at = [...bgpPath(instance), kind, key]
    const fields = [model.get(at) === undefined ? model.set(at, {}) : fieldPath(...at)]
    if (peerAs !== undefined) {
      claim(fieldPath(...at, 'peerAs'), node)
      fields.push(model.set([...at, 'peerAs'], peerAs))
    }
    track(instance, node, peerKey(...at))
    set(node, mapped(fields))
    for (const child of node.children) mapPeerChild(child, instance, at)
  }

  /** A setting of a neighbor or a template (`at` is its path). */
  const mapPeerChild = (node: NxNode, instance: string, at: Segments): void => {
    if (node.kind === 'comment') return set(node, ignored('a comment'))
    const w = node.words
    const lw = w.map((x) => x.toLowerCase())
    const neighbor = at[at.length - 2] === 'neighbors'
    if (lw[0] === 'address-family' && w.length === 3 && (lw[1] === 'ipv4' || lw[1] === 'ipv6') && lw[2] === 'unicast') return mapPeerFamily(node, instance, at, lw[1])
    if (node.children.length) return unsupportedTree(node)
    const say = (field: Segments, value: unknown) => {
      claim(fieldPath(...at, ...field), node)
      track(instance, node, peerKey(...at))
      set(node, mapped([model.set([...at, ...field], value)]))
    }
    const unsay = (field: string, what: string) => set(node, unclaim(fieldPath(...at, ...(field === 'multihop' ? ['multihop', 'ttl'] : [field])), node, what, [...at, field], at.length))
    if (lw[0] === 'remote-as' && w.length === 2) {
      const n = asNumber(w[1])
      return n === null ? set(node, unsupported('not an AS number from 1 to 4294967295')) : say(['peerAs'], n)
    }
    if (lw[0] === 'description' && w.length > 1) return say(['description'], node.text.replace(/^\S+\s+/, ''))
    if (lw[0] === 'update-source') {
      const n = interfaceName(w, 1)
      return n && 1 + n.used === w.length && isInterfaceName(n.name) ? say(['updateSource'], n.name) : set(node, unsupported())
    }
    if (lw[0] === 'ebgp-multihop' && w.length === 2) {
      const ttl = inRange(w[1], 2, 255)
      return ttl === null ? set(node, unsupported('not a TTL from 2 to 255')) : say(['multihop', 'ttl'], ttl)
    }
    // The password is a secret: never carried. The model flags it, and the target asks for it.
    if (lw[0] === 'password' && (w.length === 2 || w.length === 3)) return say(['authentication'], true)
    if (neighbor && lw[0] === 'inherit' && lw[1] === 'peer' && w.length === 3) return say(['group'], w[2])
    if (lw[0] === 'no' && lw[1] === 'shutdown' && w.length === 2) return set(node, ignored('a session is up unless shut down: nothing to convert'))
    if (lw[0] === 'shutdown' && w.length === 1) return set(node, unsupported('a session shut down: the model has no switch for it'))
    if (lw[0] === 'no' && lw[1] === 'address-family' && w.length === 4 && (lw[2] === 'ipv4' || lw[2] === 'ipv6') && lw[3] === 'unicast') return set(node, removePeerFamily(node, at, lw[2]))
    const negated = lw[0] === 'no' ? PEER_NEGATIONS.get(lw[1]) : undefined
    if (negated && (neighbor || negated[0] !== 'group')) return unsay(...negated)
    unsupportedTree(node)
  }

  /** `address-family ipv4|ipv6 unicast` on a peer: the family it carries, with its route maps (resolved in checkBgp()). */
  const mapPeerFamily = (node: NxNode, instance: string, at: Segments, family: 'ipv4' | 'ipv6'): void => {
    const af = [...at, 'addressFamilies', `${family}-unicast`]
    track(instance, node, peerKey(...at), peerKey(...af))
    set(node, mapped([model.get(af) === undefined ? model.set(af, {}) : fieldPath(...af)]))
    for (const child of node.children) {
      const w = child.words
      const lw = w.map((x) => x.toLowerCase())
      const no = lw[0] === 'no' ? 1 : 0
      const direction = lw[2 + no] === 'in' ? 'importPolicies' : lw[2 + no] === 'out' ? 'exportPolicies' : undefined
      if (child.kind === 'comment') set(child, ignored('a comment'))
      else if (child.children.length || lw[no] !== 'route-map' || w.length !== 3 + no || !direction) unsupportedTree(child)
      else if (no) set(child, unclaim(fieldPath(...af, direction), child, 'route map', [...af, direction], af.length))
      else {
        claim(fieldPath(...af, direction), child)
        track(instance, child, peerKey(...at), peerKey(...af))
        set(child, mapped([model.set([...af, direction], [w[1]])]))
      }
    }
  }

  /** `no address-family ipv4|ipv6 unicast` on a peer: it no longer carries the family. */
  const removePeerFamily = (node: NxNode, at: Segments, family: 'ipv4' | 'ipv6'): StatementDisposition => {
    const af = [...at, 'addressFamilies', `${family}-unicast`]
    const said = peerStatements.get(peerKey(...af)) ?? []
    if (!said.length) return ignored('no such address family on the peer: nothing to convert')
    for (const n of said) if (dispositions[n.id]?.kind === 'mapped') set(n, ignored(`removed by line ${line(node)}`))
    peerStatements.delete(peerKey(...af))
    dropOwners(af)
    model.prune(af, at.length)
    return ignored(`removes the address family on ${linesText(said.map(line))}: nothing to convert`)
  }

  /** `no neighbor X` / `no template peer T`: removes the peer and everything said about it. */
  const removePeer = (node: NxNode, instance: string, kind: 'neighbors' | 'groups', key: string): StatementDisposition => {
    const at = [...bgpPath(instance), kind, key]
    const said = peerStatements.get(peerKey(...at)) ?? []
    const what = kind === 'neighbors' ? 'neighbor' : 'peer template'
    if (!said.length) return ignored(`no such ${what}: nothing to convert`)
    for (const n of said) if (dispositions[n.id]?.kind === 'mapped') set(n, ignored(`removed by line ${line(node)}`))
    for (const k of peerStatements.keys()) if (k === peerKey(...at) || k.startsWith(`${peerKey(...at)}.`)) peerStatements.delete(k)
    dropOwners(at)
    model.prune(at, 3)
    return ignored(`removes the ${what} configured on ${linesText([...new Set(said.map(line))].sort((a, b) => a - b))}: nothing to convert`)
  }

  /** `no router bgp ASN`: removes BGP, every network instance's. */
  const removeRouterBgp = (node: NxNode): StatementDisposition => {
    const w = node.words
    const as = w.length === 4 ? asNumber(w[3]) : null
    if (as === null) return unsupported()
    if (!bgpAs || bgpAs.value !== as) return ignored('no such BGP process: nothing to convert')
    const lines = [...bgpStatements.values()].flat().filter((n) => dispositions[n.id]?.kind === 'mapped').map(line)
    for (const instance of bgpStatements.keys()) dropBgp(instance, ignored(`removed by line ${line(node)}`))
    bgpAs = undefined
    return ignored(`removes BGP (${linesText([...new Set(lines)].sort((a, b) => a - b))}): nothing to convert`)
  }

  /**
   * BGP's references, once every statement is read: a VRF's BGP needs the VRF defined, an update source an interface of
   * the model, and a neighbor's template one of its instance's, or, for a VRF neighbor, one of the whole process's,
   * which the VRF gets a copy of (copyGroup()). What doesn't resolve is left out.
   */
  const checkBgp = () => {
    for (const instance of bgpStatements.keys()) if (!instanceDefined(instance)) dropBgp(instance, unsupported('BGP in a VRF the configuration doesn\'t define'))
    const global = model.get([...bgpPath('default'), 'groups'])
    const globalGroups = isObject(global) ? global : {}
    const copies: [instance: string, name: string][] = []
    for (const [instance, ni] of Object.entries((model.get(['networkInstances']) as Obj | undefined) ?? {})) {
      const bgp = isObject(ni) && isObject(ni.bgp) ? ni.bgp : undefined
      if (!bgp) continue
      const groups = isObject(bgp.groups) ? bgp.groups : {}
      for (const kind of ['groups', 'neighbors'] as const) {
        for (const [key, peer] of Object.entries(isObject(bgp[kind]) ? (bgp[kind] as Obj) : {})) {
          if (!isObject(peer)) continue
          const at = [...bgpPath(instance), kind, key]
          const drop = (field: string, why: string, where: Segments = at) => {
            const owner = owners.get(fieldPath(...where, field))
            if (owner) set(owner, unsupported(why))
            owners.delete(fieldPath(...where, field))
            model.remove([...where, field])
          }
          if (typeof peer.updateSource === 'string' && !interfaceResolves(peer.updateSource)) drop('updateSource', 'names an interface the configuration doesn\'t define')
          if (typeof peer.group === 'string' && !Object.hasOwn(groups, peer.group)) {
            if (instance !== 'default' && Object.hasOwn(globalGroups, peer.group)) copies.push([instance, peer.group])
            else drop('group', 'names a peer template the configuration doesn\'t define')
          }
          // A route map names a policy of the model (model 0.5.0), or it isn't kept: a name alone would say nothing.
          for (const [family, af] of Object.entries(isObject(peer.addressFamilies) ? peer.addressFamilies : {})) {
            if (!isObject(af)) continue
            for (const direction of ['importPolicies', 'exportPolicies'] as const) {
              const names = af[direction]
              const name = Array.isArray(names) ? String(names[0]) : undefined
              if (name === undefined || (routingPolicy?.policies && Object.hasOwn(routingPolicy.policies, name))) continue
              drop(direction, policy.definesRouteMap(name) ? 'names a route map that isn\'t converted' : 'names a route map the configuration doesn\'t define: what NX-OS then does with the routes isn\'t converted', [...at, 'addressFamilies', family])
            }
          }
        }
      }
    }
    for (const [instance, name] of copies) copyGroup(instance, name)
  }

  /**
   * A VRF neighbor's template, one of the whole process's: the model's groups are per network instance, so the VRF gets
   * a copy of it (#71), mapped by the statements that configure the global one. The render writes it back as one template.
   */
  const copyGroup = (instance: string, name: string) => {
    const from = [...bgpPath('default'), 'groups', name]
    const to = [...bgpPath(instance), 'groups', name]
    if (model.get(to) !== undefined) return
    model.set(to, JSON.parse(JSON.stringify(model.get(from))) as unknown)
    const prefix = fieldPath(...from)
    const copied = (f: string) => (f === prefix || f.startsWith(`${prefix}.`) || f.startsWith(`${prefix}[`) ? [fieldPath(...to) + f.slice(prefix.length)] : [])
    for (const n of new Set(peerStatements.get(peerKey(...from)) ?? [])) {
      const d = dispositions[n.id]
      if (d?.kind === 'mapped') set(n, mapped([...d.fields, ...d.fields.flatMap(copied)]))
    }
  }

  /**
   * What NX-OS does with an eBGP peer's routes when no route map applies: it takes and sends them all (no RFC 8212).
   * Said, as model 0.4.1 has it, for each network instance with an eBGP neighbor that has no route map one way in a
   * family it carries (each family by its effective policy: the family's own, else the neighbor's, else the template's
   * family's, else the template's; with no family, the neighbor's or the template's), so a target that drops them warns.
   * It is the platform's default, not configuration: the instance's own statement maps it.
   */
  const sayDefaultPolicy = () => {
    for (const [instance, ni] of Object.entries((model.get(['networkInstances']) as Obj | undefined) ?? {})) {
      const bgp = isObject(ni) && isObject(ni.bgp) ? (ni.bgp as Bgp) : undefined
      const opening = bgpStatements.get(instance)?.[0]
      if (!bgp || !opening) continue
      const sides = new Set<'import' | 'export'>()
      for (const neighbor of Object.values(bgp.neighbors ?? {})) {
        const group = neighbor.group !== undefined && bgp.groups && Object.hasOwn(bgp.groups, neighbor.group) ? bgp.groups[neighbor.group] : undefined
        const peerAs = neighbor.peerAs ?? group?.peerAs
        if (peerAs === undefined || peerAs === bgp.localAs) continue
        const families = [...new Set([...Object.keys(neighbor.addressFamilies ?? {}), ...Object.keys(group?.addressFamilies ?? {})])] as BgpAddressFamilyName[]
        for (const [field, side] of [['importPolicies', 'import'], ['exportPolicies', 'export']] as const) {
          const effective = (f?: BgpAddressFamilyName) => (f ? neighbor.addressFamilies?.[f]?.[field] : undefined) ?? neighbor[field] ?? (f ? group?.addressFamilies?.[f]?.[field] : undefined) ?? group?.[field]
          if (families.length ? families.some((f) => !effective(f)?.length) : !effective()?.length) sides.add(side)
        }
      }
      const fields = [...sides].map((side) => model.set([...bgpPath(instance), 'ebgpDefaultPolicy', side], 'accept'))
      const d = dispositions[opening.id]
      if (fields.length && d?.kind === 'mapped') set(opening, mapped([...d.fields, ...fields]))
    }
  }

  /** Whether an interface reference names an interface of the model, or one of its subinterfaces (as the core checks). */
  const interfaceResolves = (ref: string): boolean => {
    if (model.get(['interfaces', ref]) !== undefined) return true
    const split = splitSubinterface(ref)
    return split !== null && model.get(['interfaces', split.parent, 'subinterfaces', split.index]) !== undefined
  }

  // ---- features

  /**
   * `no feature bgp`: BGP's configuration goes with it, and a VRF's route distinguisher and targets are BGP's. Whether
   * NX-OS keeps them is not something the model should guess, so those before it are left out.
   */
  const clearVpn = (node: NxNode) => {
    const why = unsupported(`BGP's, which line ${line(node)} turns off: left out`)
    for (const [instance, state] of vrfs) {
      const rd = owners.get(`vrf ${instance} rd`)
      if (rd) {
        owners.delete(`vrf ${instance} rd`)
        model.remove(['networkInstances', instance, 'routeDistinguisher'])
        set(rd, why)
      }
      for (const targets of state.families.values()) {
        for (const t of targets) set(t.node, why)
        targets.length = 0
      }
      if (state.unconverted) set(state.unconverted, why)
      state.unconverted = undefined
    }
  }

  /** The `feature` statement that turned each feature on, so `no feature` can undo it. */
  const features = new Map<string, NxNode>()

  const mapFeature = (node: NxNode, remove: boolean): StatementDisposition => {
    const w = node.words.slice(remove ? 1 : 0)
    if (w.length < 2) return unsupported()
    const feature = w.slice(1).join(' ')
    if (remove) {
      const on = features.get(feature)
      if (on) set(on, ignored(`turned off by line ${line(node)}`))
      features.delete(feature)
      if (feature === VPN_FEATURE) {
        clearVpn(node)
        for (const instance of bgpStatements.keys()) dropBgp(instance, unsupported(`BGP's, which line ${line(node)} turns off: left out`))
        bgpAs = undefined
      }
      if (feature === OSPF_FEATURE) clearOspf(node)
      return unsupported('turns a feature off: the model holds no features')
    }
    features.set(feature, node)
    // Needed only when BGP, a VRF's route distinguisher or targets, or OSPF are converted: decided once every statement
    // is read.
    if (feature === VPN_FEATURE || feature === OSPF_FEATURE) return unsupported('turns on a feature whose configuration isn\'t converted yet')
    const required = REQUIRED_FEATURES.find(([f]) => f === feature)
    if (required) return ignored(`needed by ${required[2]}: written whenever one is`)
    return unsupported('turns on a feature whose configuration isn\'t converted yet')
  }

  // ---- the top level

  const mapTop = (node: NxNode): void => {
    if (node.kind === 'comment') return set(node, ignored('a comment'))
    const lines = node.span.endLine - node.span.startLine + 1
    if (node.kind === 'banner') return set(node, unsupported(`a ${BANNER_TYPES.has(node.words[1]?.toLowerCase()) ? node.words[1].toLowerCase() : 'motd'} banner, ${lines} line${lines === 1 ? '' : 's'}, kept verbatim`))

    if (policy.top(node)) return
    const w = node.words
    const lw = w.map((x) => x.toLowerCase())
    if (lw[0] === 'interface') return mapInterface(node)
    if (lw[0] === 'vrf' && lw[1] === 'context') return mapVrfContext(node)
    if (lw[0] === 'vlan') return mapVlan(node)
    if (lw[0] === 'router' && lw[1] === 'ospf') return mapRouterOspf(node)
    if (lw[0] === 'router' && lw[1] === 'bgp') return mapRouterBgp(node)
    if (node.children.length) return unsupportedTree(node)
    if (lw[0] === 'no' && lw[1] === 'vlan') return set(node, removeVlan(node))
    if (lw[0] === 'no' && lw[1] === 'router' && lw[2] === 'ospf') return set(node, removeRouterOspf(node))
    if (lw[0] === 'no' && lw[1] === 'router' && lw[2] === 'bgp') return set(node, removeRouterBgp(node))
    if (lw[0] === 'ip' && lw[1] === 'route') return mapRoute(node, false, 'default')
    if (lw[0] === 'ipv6' && lw[1] === 'route') return mapRoute(node, true, 'default')
    if (lw[0] === 'no' && (lw[1] === 'ip' || lw[1] === 'ipv6') && lw[2] === 'route') return set(node, removeRoute(node, lw[1] === 'ipv6', 'default'))
    if (lw[0] === 'no' && lw[1] === 'vrf' && lw[2] === 'context') return set(node, removeVrfContext(node))

    let d: StatementDisposition = unsupported()
    if ((lw[0] === 'hostname' || lw[0] === 'switchname') && w.length === 2) {
      claim('hostname', node)
      d = mapped([model.set(['system', 'hostname'], w[1])])
    } else if (lw[0] === 'no' && (lw[1] === 'hostname' || lw[1] === 'switchname') && w.length <= 3) d = unclaim('hostname', node, 'hostname', ['system', 'hostname'], 0)
    else if (lw[0] === 'ip' && lw[1] === 'domain-name' && w.length === 3) {
      claim('domain name', node)
      d = mapped([model.set(['system', 'domainName'], w[2])])
    } else if (lw[0] === 'no' && lw[1] === 'ip' && lw[2] === 'domain-name' && w.length <= 4) d = unclaim('domain name', node, 'domain name', ['system', 'domainName'], 0)
    else if (lw[0] === 'ip' && lw[1] === 'name-server') d = mapNameServers(node)
    else if (lw[0] === 'no' && lw[1] === 'ip' && lw[2] === 'name-server') d = removeNameServers(node)
    else if (lw[0] === 'ip' && lw[1] === 'domain-list') d = mapDomainList(node, false)
    else if (lw[0] === 'no' && lw[1] === 'ip' && lw[2] === 'domain-list') d = mapDomainList(node, true)
    else if (lw[0] === 'ntp') d = mapNtp(node)
    else if (lw[0] === 'no' && lw[1] === 'ntp' && lw[2] === 'source-interface') d = unclaim('ntp source', node, 'NTP source interface', ['system', 'ntp', 'sourceInterface'], 0)
    else if (lw[0] === 'no' && lw[1] === 'logging' && lw[2] === 'source-interface') d = unclaim('logging source', node, 'syslog source interface', ['system', 'logging', 'sourceInterface'], 0)
    else if (lw[0] === 'no' && lw[1] === 'snmp-server' && (lw[2] === 'contact' || lw[2] === 'location')) d = unclaim(`snmp ${lw[2]}`, node, `SNMP ${lw[2]}`, ['system', 'snmp', lw[2]], 0)
    else if (lw[0] === 'no' && lw[1] === 'ntp' && lw[2] === 'server' && w.length >= 4) {
      const key = isIpv6(w[3]) ? w[3].toLowerCase() : w[3]
      d = unclaim(fieldPath('system', 'ntp', 'servers', key), node, 'NTP server', ['system', 'ntp', 'servers', key], 0)
    } else if (lw[0] === 'logging') d = mapLogging(node)
    else if (lw[0] === 'no' && lw[1] === 'logging' && lw[2] === 'server' && w.length >= 4) {
      const key = isIpv6(w[3]) ? w[3].toLowerCase() : w[3]
      d = unclaim(fieldPath('system', 'logging', 'remoteServers', key), node, 'syslog server', ['system', 'logging', 'remoteServers', key], 0)
    } else if (lw[0] === 'snmp-server') d = mapSnmp(node)
    else if (lw[0] === 'no' && lw[1] === 'snmp-server' && lw[2] === 'community') d = removeCommunity(node)
    else if (lw[0] === 'feature') d = mapFeature(node, false)
    else if (lw[0] === 'no' && lw[1] === 'feature') d = mapFeature(node, true)
    else if (lw[0] === 'version' && w.length >= 2) d = ignored('the software version the configuration was written by')
    else if (lw[0] === 'end' && w.length === 1) d = ignored('the end of the configuration')
    set(node, d)
  }

  /** A statement nothing maps, and everything inside it; `reason` says why for the statement itself. */
  const unsupportedTree = (node: NxNode, reason?: string): void => {
    set(node, node.kind === 'comment' ? ignored('a comment') : unsupported(reason))
    for (const child of node.children) unsupportedTree(child)
  }

  for (const node of nodes) mapTop(node)
  buildRoutes()
  // Routing policy (model 0.5.0), once every list a route map names is read; BGP's route maps resolve to it (checkBgp).
  const routingPolicy = policy.finish()
  if (routingPolicy) model.set(['routingPolicy'], routingPolicy)

  // A VRF's route targets: one set in the model, so every address family's must agree (a family with none disagrees
  // with one with some), and none may be left out.
  for (const [instance, state] of vrfs) {
    const all = [...state.families.values()].flat()
    if (!all.length) continue
    const lists = [...state.families.values()].map((targets) => ({
      import: [...new Set(targets.filter((t) => t.directions.includes('import')).map((t) => t.value))],
      export: [...new Set(targets.filter((t) => t.directions.includes('export')).map((t) => t.value))]
    }))
    // The same set in each direction, in any order: the model keeps the first family's order.
    const sorted = (values: string[]) => JSON.stringify([...values].sort())
    const same = lists.every((l) => sorted(l.import) === sorted(lists[0].import) && sorted(l.export) === sorted(lists[0].export))
    if (state.unconverted || !same) {
      const why = state.unconverted
        ? `left out whole: line ${line(state.unconverted)} about the VRF's route targets isn't converted`
        : 'route targets that differ between IPv4 and IPv6: the model holds one set for the VRF'
      for (const t of all) set(t.node, unsupported(why))
      continue
    }
    const at = ['networkInstances', instance, 'routeTargets']
    for (const direction of ['import', 'export'] as const) if (lists[0][direction].length) model.set([...at, direction], lists[0][direction])
    for (const t of all) set(t.node, mapped(t.directions.map((d) => fieldPath(...at, d))))
  }

  // A subinterface in a VRF the text doesn't define (or removes) would name a network instance the model doesn't
  // have: its membership and its addresses, which would otherwise land in the global table, are left out. The
  // management VRF is built in: mgmt0 declares it when the text doesn't.
  if (mgmtInterfaces.length && model.get(['networkInstances', 'management']) === undefined) {
    const field = model.set(['networkInstances', 'management', 'type'], 'vrf')
    for (const node of mgmtInterfaces) {
      const d = dispositions[node.id]
      if (d.kind === 'mapped') set(node, mapped([...d.fields, field]))
    }
  }
  for (const { ctx, vrf, node } of membership.values()) {
    if (!node || model.get(['networkInstances', vrf]) !== undefined) continue
    model.remove([...subPath(ctx), 'networkInstance'])
    set(node, unsupported('names a VRF the configuration doesn\'t define'))
    for (const family of [4, 6] as const) {
      const state = addressing.get(`${ctx.name}|${ctx.sub}|${family}`)
      if (!state) continue
      for (const r of [...(state.primary ? [state.primary] : []), ...state.secondaries]) {
        if ('address' in r) model.remove([...familyPath(ctx, family), 'addresses', r.address])
        set(r.node, unsupported(`an address in the VRF of line ${line(node)}, which the configuration doesn't define`))
      }
      addressing.delete(`${ctx.name}|${ctx.sub}|${family}`)
      pruneFamily(ctx, family)
    }
    if (!ctx.isSub) pruneMain(ctx)
  }

  // A community with a statement not converted anywhere in the text (an access list, another group) is left out whole:
  // mapped without it, it could answer clients or allow access the source doesn't.
  for (const [name, state] of communities) {
    if (!state.unconverted) continue
    model.prune(['system', 'snmp', 'communities', name], 0)
    for (const n of state.nodes) if (dispositions[n.id]?.kind === 'mapped') set(n, unsupported(`left out whole: line ${line(state.unconverted)} about the same community isn't converted, and may limit or change it`))
  }

  for (const state of addressing.values()) {
    const at = familyPath(state.ctx, state.family)
    if (!state.secondaries.length) continue
    if (!state.primary || !('address' in state.primary)) {
      // The model can mark an address primary but not secondary: without a primary, a secondary would come back as one.
      for (const s of state.secondaries) {
        model.remove([...at, 'addresses', s.address])
        set(s.node, unsupported(state.primary ? 'a secondary address beside an address from DHCP' : 'a secondary address with no primary address: the model can\'t say an address is secondary'))
      }
      pruneFamily(state.ctx, state.family)
      continue
    }
    // A primary address is marked only beside secondaries: alone, it is simply the address.
    const path = model.set([...at, 'addresses', state.primary.address, 'primary'], true)
    const d = dispositions[state.primary.node.id]
    if (d.kind === 'mapped') dispositions[state.primary.node.id] = mapped([...d.fields, path])
  }

  // An interface carries tagged subinterfaces while one of them has a tag: `no encapsulation` can take the last away.
  for (const [name, iface] of Object.entries((model.get(['interfaces']) as Obj | undefined) ?? {})) {
    if (!isObject(iface) || iface.vlanTagging === undefined) continue
    const subs = isObject(iface.subinterfaces) ? Object.values(iface.subinterfaces) : []
    if (!subs.some((sub) => isObject(sub) && sub.vlanId !== undefined)) model.remove(['interfaces', name, 'vlanTagging'])
  }

  buildOspf()
  checkBgp()
  sayDefaultPolicy()

  // `no switchport` makes a routed port: the render writes it back for an interface with IP configuration. Without
  // any, the model can't say the port is routed rather than switched.
  /** The interfaces OSPF runs on, by reference: OSPF on a port makes it routed, as an address does. */
  const ospfOn = new Set(
    Object.values((model.get(['networkInstances']) as Obj | undefined) ?? {}).flatMap((i) => {
      const areas = isObject(i) && isObject(i.ospf) && isObject(i.ospf.areas) ? Object.values(i.ospf.areas) : []
      return areas.flatMap((a) => (isObject(a) && isObject(a.interfaces) ? Object.keys(a.interfaces) : []))
    })
  )
  /** Whether a port has IP configuration (an address, a VRF, subinterfaces, OSPF), which makes it routed. */
  const isRouted = (name: string) => {
    const subs = (model.get(['interfaces', name, 'subinterfaces']) as Obj | undefined) ?? {}
    return Object.values(subs).some((s) => isObject(s) && (s.ipv4 !== undefined || s.ipv6 !== undefined || s.networkInstance !== undefined)) || Object.keys(subs).some((k) => k !== '0') || ospfOn.has(name)
  }
  for (const { node, ctx } of routedPorts) {
    if (owners.get(`switchport ${ctx.name}`) !== node) continue
    set(node, isRouted(ctx.name) ? ignored('a routed port, as its IP configuration says: written back with it') : unsupported('a routed port with no IP configuration the model holds: the model can\'t say it'))
  }

  // `switchport` alone makes a switch port, which the render writes on every Ethernet and port-channel interface with
  // no IP configuration. NX-OS refuses IP configuration on one, and switch port settings on a routed port.
  for (const { node, ctx } of switchPorts) {
    if (owners.get(`switchport ${ctx.name}`) !== node) continue
    set(node, isRouted(ctx.name) ? unsupported('a switch port with IP configuration, which NX-OS refuses') : ignored('a switch port: written back on every port with no IP configuration'))
  }
  for (const [name, statements] of switchStatements) {
    if (!isRouted(name)) continue
    for (const n of statements) if (dispositions[n.id]?.kind === 'mapped') set(n, unsupported('a switch port setting on a routed port, which NX-OS refuses'))
    switchStatements.delete(name)
    allowedStatements.delete(name)
    model.remove(switchingPath(name))
  }

  // VLAN 1 is built in: an SVI or a switch port uses it without the text defining it, and the model then has it.
  const addField = (node: NxNode, field: string) => {
    const d = dispositions[node.id]
    if (d?.kind === 'mapped' && !d.fields.includes(field)) set(node, mapped([...d.fields, field]))
  }
  const hasVlan = (id: number) => model.get(['vlans', String(id)]) !== undefined
  const ports = Object.entries((model.get(['interfaces']) as Obj | undefined) ?? {}).flatMap(([name, i]) => (isObject(i) && isObject(i.switching) ? [[name, i.switching] as const] : []))
  const usesVlan1: NxNode[] = [
    ...svis.filter((s) => s.vlan === 1).map((s) => s.node),
    ...ports.flatMap(([name, s]) => [
      ...(['accessVlan', 'nativeVlan'] as const).flatMap((f) => (s[f] === 1 ? [owners.get(fieldPath(...switchingPath(name), f))] : [])),
      ...(Array.isArray(s.allowedVlans) && s.allowedVlans.includes('1') ? (allowedStatements.get(name) ?? []) : [])
    ])
  ].filter((n) => n !== undefined)
  if (usesVlan1.length && !hasVlan(1)) {
    const field = model.set(['vlans', '1'], {})
    for (const n of usesVlan1) addField(n, field)
  }

  // A switch port's VLANs must be defined: one that isn't is left out, with the statement that names it.
  for (const [name, s] of ports) {
    const at = switchingPath(name)
    for (const f of ['accessVlan', 'nativeVlan'] as const) {
      if (typeof s[f] !== 'number' || hasVlan(s[f])) continue
      const owner = owners.get(fieldPath(...at, f))
      if (owner) set(owner, unsupported('names a VLAN the configuration doesn\'t define'))
      owners.delete(fieldPath(...at, f))
      model.remove([...at, f])
    }
    if (Array.isArray(s.allowedVlans) && s.allowedVlans.some((e) => typeof e === 'string' && !e.includes('-') && !hasVlan(Number(e)))) {
      for (const n of allowedStatements.get(name) ?? []) set(n, unsupported('the allowed VLANs name one the configuration doesn\'t define'))
      allowedStatements.delete(name)
      model.remove([...at, 'allowedVlans'])
    }
    model.removeIfEmpty(at)
  }

  // An SVI routes for its VLAN only when the VLAN is defined: without it, it is an interface of type `vlan`, as before
  // model 0.4.0, with no routed VLAN.
  for (const { node, ctx, vlan } of svis) {
    if (hasVlan(vlan) || model.get(['interfaces', ctx.name]) === undefined) continue
    const type = model.set(['interfaces', ctx.name, 'type'], 'vlan')
    const routed = fieldPath(...subPath(ctx), 'routedVlan')
    model.remove([...subPath(ctx), 'routedVlan'])
    pruneMain(ctx)
    const d = dispositions[node.id]
    if (d?.kind === 'mapped') set(node, mapped([type, ...d.fields.filter((f) => f !== type && f !== routed)]))
  }

  // `feature ospf` and `feature bgp` are needed by what they turn on: written back with it. With nothing converted that
  // needs one, it turns on a service the model doesn't hold, and stays unsupported.
  const instances = Object.values((model.get(['networkInstances']) as Obj | undefined) ?? {}).filter(isObject)
  const ospfFeature = features.get(OSPF_FEATURE)
  if (ospfFeature && instances.some((i) => i.ospf !== undefined)) set(ospfFeature, ignored('needed by OSPF: written whenever OSPF is'))
  const bgpFeature = features.get(VPN_FEATURE)
  if (bgpFeature && instances.some((i) => i.bgp !== undefined)) set(bgpFeature, ignored('needed by BGP: written whenever BGP is'))
  else if (bgpFeature && instances.some((i) => i.routeDistinguisher !== undefined || i.routeTargets !== undefined)) set(bgpFeature, ignored('needed by VRF route distinguishers and targets: written whenever one is'))

  return { tree: nodes, model: model.root as Device, dispositions, diagnostics }
}
