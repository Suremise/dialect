// IOS-XR text → the shared model, for the phase 1 areas: system (hostname, domain name, DNS), interfaces and
// subinterfaces with their addresses and VRF, VRFs (`vrf X`) with their route targets, static routes (`router static`),
// NTP, logging and SNMP. Every statement of the tree gets a disposition: `mapped` when everything it says went into the
// model, `ignored-by-design` with why, or `unsupported` (its text kept in the tree). A statement is mapped only when every
// option on it is understood: one with an option the model can't hold (`server 192.0.2.1 key 1`) is unsupported as a
// whole, never half-converted. Route policies and sets are recognised and kept whole (tree.ts), not translated yet.
// Later statements act on earlier ones as on the device: a second setting supersedes the first, and `no …` forms and
// `vrf V` on an interface clear what they remove. No reason or diagnostic repeats a word of the configuration
// (AGENTS.md, No secrets in diagnostics): they give line numbers and word positions instead.
import { fieldPath, isRouteDistinguisher, type Context, type Device, type Diagnostic, type ParseResult, type StatementDisposition, type SyslogSeverity } from '@dialect/core'
import { ipv4Prefix, ipv6Prefix, isIpv4, isIpv6, maskLength } from './addresses'
import { interfaceType, isInterfaceName, splitSubinterface } from './names'
import { parseTree, unquote, type XrNode } from './tree'

type Obj = { [key: string]: unknown }
type Segments = readonly string[]

/** IOS-XR's syslog severity words (`logging 192.0.2.1 severity info`), with the CLI's other spellings, by model severity. */
export const SEVERITY_WORDS: Readonly<Record<string, SyslogSeverity>> = {
  emergencies: 'emergency',
  alerts: 'alert',
  critical: 'critical',
  error: 'error',
  errors: 'error',
  warning: 'warning',
  warnings: 'warning',
  notifications: 'notice',
  info: 'informational',
  informational: 'informational',
  debugging: 'debug'
}

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

/** The ranges IOS-XR takes numbers in, so a value it would refuse (or one too long to be exact) is never mapped. */
export const VLAN_ID = { min: 1, max: 4094 } as const
export const MTU = { min: 64, max: 65535 } as const
export const ROUTE_TAG = { min: 1, max: 4294967295 } as const
export const PORT = { min: 1, max: 65535 } as const
/** Whether `value` (a word of digits, or a number from a model) is a whole number within `range`. */
export const inRange = (value: string | number, range: { readonly min: number; readonly max: number }): boolean => {
  const n = typeof value === 'number' ? value : /^\d{1,10}$/.test(value) ? Number(value) : NaN
  return Number.isInteger(n) && n >= range.min && n <= range.max
}
const SHUTDOWN = /^shut(?:d(?:o(?:w(?:n)?)?)?)?$/
/**
 * A VRF named on a statement, or undefined for the global table: `vrf default` is the same thing as no VRF, and the
 * model leaves it out the same way (a render can't bring it back).
 */
const vrfName = (name: string): string | undefined => (name === 'default' ? undefined : name)
const HOST = /^[A-Za-z0-9][\w.-]*$/
/** An address as the model keys it: IPv6 lowercased. */
const addressKey = (a: string) => (isIpv6(a) ? a.toLowerCase() : a)

/** Where an interface statement's settings go: subinterface `0` for the main interface's addresses. */
interface InterfaceContext {
  readonly name: string
  readonly sub: string
  readonly isSub: boolean
}

/** Parses IOS-XR `text` into the model, with a disposition for every statement of its tree. */
export function parse(text: string, _context: Context): ParseResult {
  const { nodes, diagnostics: treeDiagnostics } = parseTree(text)
  const diagnostics: Diagnostic[] = [...treeDiagnostics]
  const model = new ModelBuilder()
  const dispositions: Record<string, StatementDisposition> = {}
  const set = (node: XrNode, disposition: StatementDisposition) => {
    dispositions[node.id] = disposition
  }
  const line = (node: XrNode) => node.span.startLine
  const linesText = (lines: number[]) => `line${lines.length > 1 ? 's' : ''} ${lines.join(', ')}`

  /** The statement that last set a single-valued setting, by key: a later one supersedes it, as on the device. */
  const owners = new Map<string, XrNode>()
  const claim = (key: string, node: XrNode, onSupersede?: () => void) => {
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
  const unclaim = (key: string, node: XrNode, what: string, path: Segments, keep: number): StatementDisposition => {
    const previous = owners.get(key)
    if (!previous) return ignored(`no ${what} to remove: nothing to convert`)
    owners.delete(key)
    model.prune(path, keep)
    set(previous, ignored(`removed by line ${line(node)}`))
    return ignored(`removes the ${what} on line ${line(previous)}: nothing to convert`)
  }

  /** A statement nothing maps, and everything inside it. */
  const unsupportedTree = (node: XrNode, reason?: string): void => {
    set(node, node.kind === 'comment' ? ignored('a comment') : unsupported(reason))
    for (const child of node.children) unsupportedTree(child)
  }

  // ---- interfaces

  type AddressStatement = { readonly node: XrNode; readonly address: string }
  /**
   * Per subinterface and family (`name|sub|4`): its addresses, by statement. IPv4 has one primary (or `dhcp`) and
   * secondaries; IPv6 addresses are all alike, kept in `secondaries` with no primary.
   */
  /** A primary not in the model: from DHCP, or with an option the model can't hold. `what` says which, for reasons. */
  type UnconvertedPrimary = { readonly node: XrNode; readonly what: string }
  type Addressing = { readonly ctx: InterfaceContext; readonly family: 4 | 6; primary?: AddressStatement | UnconvertedPrimary; secondaries: AddressStatement[] }
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

  /** Removes a family's addresses, each statement marked with `why`; the statements' lines, in order. */
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

  /** An address and its length from `ipv4 address A M|A/L` or `ipv6 address A/L`, or null. */
  const readAddress = (args: readonly string[], family: 4 | 6): { address: string; length: number } | null => {
    // IOS-XR shows `A/L`; it also takes the length as a word of its own.
    if (family === 6) return args.length === 1 ? ipv6Prefix(args[0]) : args.length === 2 && INTEGER.test(args[1]) ? ipv6Prefix(`${args[0]}/${args[1]}`) : null
    const prefix = args.length === 2 ? ipv4Prefix(args[0], args[1]) : args.length === 1 ? ipv4Prefix(args[0]) : null
    if (!prefix) return null
    const [address, length] = prefix.split('/')
    return { address, length: Number(length) }
  }

  /**
   * `ipv4 address …` / `ipv6 address …`. IPv4: a primary replaces the one before it, `secondary` adds one, `dhcp`
   * replaces all. IPv6 has no primary: each address adds one (`link-local`, `eui-64` and `route-tag` aren't converted).
   */
  const mapAddress = (node: XrNode, ctx: InterfaceContext, family: 4 | 6): StatementDisposition => {
    const w = node.words
    const lw = w.map((x) => x.toLowerCase())
    const at = familyPath(ctx, family)
    if (family === 4 && lw[2] === 'dhcp' && w.length === 3) {
      // An address from DHCP replaces the static ones before it, as on the device.
      const lines = clearAddresses(ctx, family, `replaced by the address from DHCP on line ${line(node)}`)
      addressingOf(ctx, family).primary = { node, what: 'an address from DHCP' }
      return unsupported(`an address from DHCP${lines.length ? `, replacing the address${lines.length > 1 ? 'es' : ''} on ${linesText(lines)}` : ''}`)
    }
    const secondary = family === 4 && lw[w.length - 1] === 'secondary'
    const args = w.slice(2, secondary ? -1 : undefined)
    const read = readAddress(args, family)
    if (!read) {
      if (lw.includes('route-tag')) {
        // Still an address of the interface, as on the device: it replaces the primary, or edits the same address.
        const tagged = lw.indexOf('route-tag')
        const loose = w.slice(2, tagged)
        const looseSecondary = family === 4 && loose[loose.length - 1]?.toLowerCase() === 'secondary'
        const address = readAddress(looseSecondary ? loose.slice(0, -1) : loose, family)?.address
        if (address !== undefined) {
          const state = addressingOf(ctx, family)
          const why = ignored(`replaced by line ${line(node)}`)
          if (family === 4 && !looseSecondary) {
            if (state.primary) {
              if ('address' in state.primary) model.remove([...at, 'addresses', state.primary.address])
              set(state.primary.node, why)
            }
            state.primary = { node, what: 'a primary address that isn\'t converted' }
          } else {
            for (const s of state.secondaries.filter((x) => x.address === address)) {
              model.remove([...at, 'addresses', s.address])
              set(s.node, why)
            }
            state.secondaries = state.secondaries.filter((x) => x.address !== address)
          }
          pruneFamily(ctx, family)
        }
        return unsupported('an address with a route tag, which the model can\'t hold')
      }
      if (lw.includes('link-local')) return unsupported('a link-local address, which the model can\'t hold')
      if (lw.includes('eui-64')) return unsupported('an address made from the interface\'s MAC address (EUI-64), which the model can\'t hold')
      return unsupported(family === 4 && args.length === 2 && isIpv4(args[0]) && maskLength(args[1]) === null ? 'not a contiguous mask' : undefined)
    }
    const { address, length } = read
    const state = addressingOf(ctx, family)
    if (family === 6 || secondary) {
      // The same address again is an edit of it.
      const same = state.secondaries.findIndex((s) => s.address === address)
      if (same >= 0) {
        set(state.secondaries[same].node, ignored(`superseded by line ${line(node)}`))
        state.secondaries.splice(same, 1)
      }
      state.secondaries.push({ node, address })
    } else {
      const previous = state.primary
      if (previous && previous.node !== node) {
        if ('address' in previous && previous.address !== address) model.remove([...at, 'addresses', previous.address])
        set(previous.node, ignored(`replaced by line ${line(node)}`))
      }
      state.primary = { node, address }
    }
    return mapped([model.set([...at, 'addresses', address, 'prefixLength'], length)])
  }

  /** `no ipv4 address A M [secondary]` / `no ipv6 address A/L`: removes that one address. */
  const removeAddress = (node: XrNode, ctx: InterfaceContext, family: 4 | 6): StatementDisposition => {
    const w = node.words
    const args = w.slice(3, family === 4 && w[w.length - 1].toLowerCase() === 'secondary' ? -1 : undefined)
    const read = readAddress(args, family)
    if (!read) return unsupported()
    const state = addressing.get(`${ctx.name}|${ctx.sub}|${family}`)
    const entries = state ? [...(state.primary && 'address' in state.primary ? [state.primary] : []), ...state.secondaries] : []
    const removed = entries.filter((e) => e.address === read.address)
    if (!state || !removed.length) return ignored('no such address on the interface: nothing to convert')
    for (const r of removed) set(r.node, ignored(`removed by line ${line(node)}`))
    if (state.primary && removed.includes(state.primary as AddressStatement)) delete state.primary
    state.secondaries = state.secondaries.filter((e) => !removed.includes(e))
    model.remove([...familyPath(ctx, family), 'addresses', read.address])
    pruneFamily(ctx, family)
    return ignored(`removes the address on ${linesText(removed.map((r) => line(r.node)))}: nothing to convert`)
  }

  /** Per interface (`name|sub`): the VRF it is in and the `vrf` statement that put it there. */
  const membership = new Map<string, { readonly ctx: InterfaceContext; readonly vrf: string; readonly node?: XrNode }>()
  const vrfOf = (ctx: InterfaceContext): { vrf: string; node?: XrNode } => membership.get(`${ctx.name}|${ctx.sub}`) ?? { vrf: 'default' }

  /**
   * `vrf V` / `no vrf [V]` on an interface: the subinterface's `networkInstance` (subinterface `0` for a main
   * interface). Moving an interface to another VRF clears its addresses, as on the device, so only addresses after it
   * stay.
   */
  const mapVrfMember = (node: XrNode, ctx: InterfaceContext, remove: boolean): StatementDisposition => {
    const w = node.words.slice(remove ? 1 : 0)
    if (w.length > 2 || (!remove && w.length !== 2)) return unsupported()
    const current = vrfOf(ctx)
    const target = remove ? 'default' : w[1]
    const at = [...subPath(ctx), 'networkInstance']
    if (remove && w[1] !== undefined && w[1] !== current.vrf) return ignored('not in that VRF: nothing to convert')
    if (target === current.vrf) return ignored(target === 'default' ? 'already in the default VRF: nothing to convert' : `already in that VRF${current.node ? ` (line ${line(current.node)})` : ''}`)
    const why = `removed by line ${line(node)}, which moves the interface to another VRF`
    const lines = [...clearAddresses(ctx, 4, why), ...clearAddresses(ctx, 6, why)].sort((a, b) => a - b)
    const cleared = lines.length ? `, clearing the addresses on ${linesText(lines)}` : ''
    if (current.node) set(current.node, ignored(`undone by line ${line(node)}`))
    // The global table: the model says it by leaving networkInstance out.
    if (target === 'default') {
      membership.set(`${ctx.name}|${ctx.sub}`, { ctx, vrf: 'default' })
      model.remove(at)
      if (!ctx.isSub) pruneMain(ctx)
      return ignored(`returns the interface to the default VRF${cleared}: nothing to convert`)
    }
    membership.set(`${ctx.name}|${ctx.sub}`, { ctx, vrf: target, node })
    return mapped([model.set(at, target)])
  }

  const mapInterfaceChild = (node: XrNode, ctx: InterfaceContext): StatementDisposition => {
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
      if (!inRange(w[1], MTU)) return unsupported(`an MTU outside ${MTU.min} to ${MTU.max}`)
      claim(key('mtu'), node)
      return mapped([model.set([...iface, 'mtu'], Number(w[1]))])
    }
    if (lw[0] === 'no' && lw[1] === 'mtu' && w.length <= 3 && !ctx.isSub) return unclaim(key('mtu'), node, 'MTU', [...iface, 'mtu'], iface.length)
    if (lw[0] === 'no' && lw[1] === 'encapsulation' && lw[2] === 'dot1q' && w.length <= 4 && ctx.isSub) return unclaim(fieldPath(...sub, 'vlanId'), node, 'VLAN tag', [...sub, 'vlanId'], sub.length)
    if (lw[0] === 'encapsulation' && lw[1] === 'dot1q' && w.length === 3 && INTEGER.test(w[2])) {
      if (!ctx.isSub) return unsupported('encapsulation dot1q on a main interface')
      if (!inRange(w[2], VLAN_ID)) return unsupported(`a VLAN ID outside ${VLAN_ID.min} to ${VLAN_ID.max}`)
      claim(fieldPath(...sub, 'vlanId'), node)
      return mapped([model.set([...sub, 'vlanId'], Number(w[2])), model.set([...iface, 'vlanTagging'], true)])
    }
    if ((lw[0] === 'ipv4' || lw[0] === 'ipv6') && lw[1] === 'address' && w.length >= 3) return mapAddress(node, ctx, lw[0] === 'ipv4' ? 4 : 6)
    if (lw[0] === 'no' && (lw[1] === 'ipv4' || lw[1] === 'ipv6') && lw[2] === 'address' && w.length > 3) return removeAddress(node, ctx, lw[1] === 'ipv4' ? 4 : 6)
    if (lw[0] === 'no' && (lw[1] === 'ipv4' || lw[1] === 'ipv6') && lw[2] === 'address' && w.length === 3) {
      const lines = clearAddresses(ctx, lw[1] === 'ipv4' ? 4 : 6, `removed by line ${line(node)}`)
      return ignored(lines.length ? `removes the addresses on ${linesText(lines)}: nothing to convert` : 'says the interface has no address: nothing to convert')
    }
    if (lw[0] === 'vrf') return mapVrfMember(node, ctx, false)
    if (lw[0] === 'no' && lw[1] === 'vrf') return mapVrfMember(node, ctx, true)
    if (lw[0] === 'bundle') return unsupported('a bundle member: link aggregation comes later')
    return unsupported()
  }

  /** Interfaces that are Layer 2 (`interface X.1 l2transport`): a later `interface X.1` is the same one, still Layer 2. */
  const l2transport = new Set<string>()

  const mapInterface = (node: XrNode): void => {
    const w = node.words
    const name = w[1]
    if (w.length === 3 && w[2].toLowerCase() === 'l2transport' && name !== undefined && isInterfaceName(name)) {
      l2transport.add(name)
      return unsupportedTree(node, 'a Layer 2 subinterface: Layer 2 comes later')
    }
    if (w.length !== 2 || !isInterfaceName(name)) return unsupportedTree(node)
    if (l2transport.has(name)) return unsupportedTree(node, `a Layer 2 subinterface: Layer 2 comes later`)
    const split = splitSubinterface(name)
    const ctx: InterfaceContext = split ? { name: split.parent, sub: split.index, isSub: true } : { name, sub: '0', isSub: false }
    model.object(['interfaces', ctx.name])
    const fields: string[] = []
    const type = interfaceType(ctx.name)
    if (type) fields.push(model.set(['interfaces', ctx.name, 'type'], type))
    if (split) model.object(subPath(ctx))
    set(node, mapped(fields))
    for (const child of node.children) {
      if (child.kind === 'comment') set(child, ignored('a comment'))
      else if (child.kind !== 'statement' || child.children.length) unsupportedTree(child)
      else set(child, mapInterfaceChild(child, ctx))
    }
  }

  // ---- static routes

  /** One next hop of a route, by the statement that configured it. */
  interface Hop {
    readonly node: XrNode
    /** What makes it a different route on IOS-XR: the interface, address and discard. Other options are edits. */
    readonly key: string
    readonly hop: Obj
    readonly description?: string
  }
  /**
   * The words of a route line from `i` (the prefix): the prefix, the next hop and the description, or why it isn't
   * converted. `lenient` (for `no …`, which IOS-XR matches by prefix and next hop alone) stops at the first word it
   * doesn't know instead. A reason never repeats a word of the statement.
   */
  const readRoute = (w: readonly string[], i: number, v6: boolean, lenient = false): { prefix: string; hop: Obj; description?: string } | { reason?: string } => {
    const p = w[i] === undefined ? null : v6 ? ipv6Prefix(w[i]) : ipv4Prefix(w[i])
    const prefix = p === null ? null : typeof p === 'string' ? p : `${p.address}/${p.length}`
    if (!prefix) return {}
    i++
    const hop: Obj = {}
    let description: string | undefined
    const hasHop = () => hop.address !== undefined || hop.interface !== undefined || hop.drop !== undefined
    while (i < w.length) {
      const word = w[i]
      const lower = word.toLowerCase()
      if (lower === 'tag' && inRange(w[i + 1] ?? '', ROUTE_TAG) && hop.tag === undefined) {
        hop.tag = Number(w[i + 1])
        i += 2
      } else if (lower === 'description' && w[i + 1] !== undefined && description === undefined) {
        description = unquote(w[i + 1])
        i += 2
      } else if ((v6 ? isIpv6(word) : isIpv4(word)) && hop.address === undefined && hop.preference === undefined) {
        hop.address = addressKey(word)
        i++
      } else if (INTEGER.test(word) && hop.preference === undefined && hasHop() && Number(word) >= 1 && Number(word) <= 254) {
        hop.preference = Number(word)
        i++
      } else if (lower !== 'vrf' && hop.address === undefined && hop.interface === undefined && hop.drop === undefined && isInterfaceName(word)) {
        // Only a real interface name: a malformed address or a stray word isn't one.
        if (/^null0$/i.test(word)) hop.drop = 'discard'
        else hop.interface = word
        i++
      } else if (lenient) break
      else if (lower === 'vrf') return { reason: 'a next hop in another VRF' }
      else if (lower === 'track') return { reason: 'a route tracked by an object' }
      else if (lower === 'bfd') return { reason: 'a route watched by BFD' }
      else return { reason: `word ${i + 1} isn't converted yet` }
    }
    return { prefix, hop, ...(description !== undefined ? { description } : {}) }
  }
  const hopKey = (hop: Obj) => `${hop.interface ?? ''}|${hop.address ?? ''}|${hop.drop ?? ''}`

  /** Per network instance and prefix, its next hops in order; the model is built from them once every route is read. */
  const routes = new Map<string, { readonly instance: string; readonly prefix: string; hops: Hop[] }>()
  /**
   * Route lines not converted (`… track 2`), by network instance, prefix and next hop: a later line for the same next
   * hop edits them, and `no …` removes them, as on the device.
   */
  const unconvertedRoutes = new Map<string, { readonly node: XrNode; readonly instance: string; readonly prefix: string }>()
  /** An unconverted route line's key: names and prefixes as a JSON list, so no two run together. */
  const unconvertedKey = (instance: string, prefix: string, hop: Obj) => JSON.stringify([instance, prefix, hopKey(hop)])
  /** Marks the unconverted line for this next hop (if any) with `why`; whether there was one. */
  const takeUnconverted = (key: string, why: StatementDisposition): boolean => {
    const entry = unconvertedRoutes.get(key)
    if (!entry) return false
    set(entry.node, why)
    unconvertedRoutes.delete(key)
    return true
  }

  /** A route line inside `router static` (`[vrf V] address-family ipv4|ipv6 unicast`): one next hop of a route. */
  const mapRoute = (node: XrNode, v6: boolean, instance: string): void => {
    const r = readRoute(node.words, 0, v6)
    if (!('prefix' in r)) {
      // Still a next hop of a route, which later lines can edit or remove.
      const loose = readRoute(node.words, 0, v6, true)
      if ('prefix' in loose) {
        const key = unconvertedKey(instance, loose.prefix, loose.hop)
        takeUnconverted(key, ignored(`superseded by line ${line(node)}`))
        const same = routes.get(`${instance}|${loose.prefix}`)?.hops.find((h) => h.key === hopKey(loose.hop))
        if (same) {
          set(same.node, ignored(`superseded by line ${line(node)}`))
          const route = routes.get(`${instance}|${loose.prefix}`)!
          route.hops = route.hops.filter((h) => h !== same)
        }
        unconvertedRoutes.set(key, { node, instance, prefix: loose.prefix })
      }
      return set(node, unsupported(r.reason))
    }
    if (r.hop.address === undefined && r.hop.interface === undefined && r.hop.drop === undefined) return set(node, unsupported('no next hop'))
    takeUnconverted(unconvertedKey(instance, r.prefix, r.hop), ignored(`superseded by line ${line(node)}`))
    const routeKey = `${instance}|${r.prefix}`
    const route = routes.get(routeKey) ?? { instance, prefix: r.prefix, hops: [] }
    routes.set(routeKey, route)
    const entry: Hop = { node, key: hopKey(r.hop), hop: r.hop, ...(r.description !== undefined ? { description: r.description } : {}) }
    // The same next hop again edits it: the later statement replaces the earlier one, in its place.
    const same = route.hops.findIndex((h) => h.key === entry.key)
    if (same >= 0) {
      set(route.hops[same].node, ignored(`superseded by line ${line(node)}`))
      route.hops[same] = entry
    } else route.hops.push(entry)
    set(node, mapped([]))
  }

  /** `no P [next hop] …`: removes that next hop of the route, or every one when it names none. */
  const removeRoute = (node: XrNode, v6: boolean, instance: string): StatementDisposition => {
    const r = readRoute(node.words, 1, v6, true)
    if (!('prefix' in r)) return unsupported(r.reason)
    const route = routes.get(`${instance}|${r.prefix}`)
    const any = r.hop.address === undefined && r.hop.interface === undefined && r.hop.drop === undefined
    const removed = route?.hops.filter((h) => any || h.key === hopKey(r.hop)) ?? []
    const why = ignored(`removed by line ${line(node)}`)
    const lines = removed.map((h) => line(h.node))
    for (const [key, u] of unconvertedRoutes) {
      if (key === unconvertedKey(instance, r.prefix, r.hop) || (any && u.instance === instance && u.prefix === r.prefix)) {
        lines.push(line(u.node))
        takeUnconverted(key, why)
      }
    }
    if (!lines.length) return ignored('no such route: nothing to convert')
    for (const h of removed) set(h.node, why)
    if (route) route.hops = route.hops.filter((h) => !removed.includes(h))
    return ignored(`removes the route on ${linesText(lines.sort((a, b) => a - b))}: nothing to convert`)
  }

  /**
   * `no router static`, `no vrf V` inside it, or `no address-family ipv4|ipv6 unicast` (inside it or its `vrf V`): every
   * route in that scope goes, converted or not, and no other. `instance` and `v6` narrow the scope when given.
   */
  const clearRoutes = (node: XrNode, instance?: string, v6?: boolean): StatementDisposition => {
    const inScope = (r: { instance: string; prefix: string }) => (instance === undefined || r.instance === instance) && (v6 === undefined || r.prefix.includes(':') === v6)
    const why = ignored(`removed by line ${line(node)}`)
    const lines: number[] = []
    for (const [key, r] of routes) {
      if (!inScope(r)) continue
      for (const h of r.hops) {
        set(h.node, why)
        lines.push(line(h.node))
      }
      routes.delete(key)
    }
    for (const [key, u] of unconvertedRoutes) {
      if (!inScope(u)) continue
      lines.push(line(u.node))
      takeUnconverted(key, why)
    }
    return ignored(lines.length ? `removes the routes on ${linesText(lines.sort((a, b) => a - b))}: nothing to convert` : 'no such routes: nothing to convert')
  }
  /** `no address-family ipv4|ipv6 unicast`'s family, or null when it isn't one. */
  const removedFamily = (words: readonly string[]): boolean | null => {
    const lw = words.map((x) => x.toLowerCase())
    return lw[0] === 'no' && lw[1] === 'address-family' && (lw[2] === 'ipv4' || lw[2] === 'ipv6') && lw[3] === 'unicast' && words.length === 4 ? lw[2] === 'ipv6' : null
  }

  /** `address-family ipv4|ipv6 unicast` inside `router static` (or its `vrf V`): its routes. */
  const mapStaticFamily = (node: XrNode, instance: string): void => {
    const lw = node.words.map((x) => x.toLowerCase())
    if (node.words.length !== 3 || (lw[1] !== 'ipv4' && lw[1] !== 'ipv6') || lw[2] !== 'unicast') return unsupportedTree(node)
    const v6 = lw[1] === 'ipv6'
    set(node, mapped([]))
    for (const child of node.children) {
      const clw = child.words.map((x) => x.toLowerCase())
      if (child.kind === 'comment') set(child, ignored('a comment'))
      else if (child.kind !== 'statement' || child.children.length) unsupportedTree(child)
      else if (clw[0] === 'no') set(child, removeRoute(child, v6, instance))
      else mapRoute(child, v6, instance)
    }
  }

  /** `router static`: address families of the global table's routes, and `vrf V` with a VRF's. */
  const mapRouterStatic = (node: XrNode): void => {
    set(node, mapped([]))
    for (const child of node.children) {
      const lw = child.words.map((x) => x.toLowerCase())
      const family = child.kind === 'statement' && !child.children.length ? removedFamily(child.words) : null
      if (child.kind === 'comment') set(child, ignored('a comment'))
      else if (lw[0] === 'address-family') mapStaticFamily(child, 'default')
      else if (family !== null) set(child, clearRoutes(child, 'default', family))
      else if (lw[0] === 'no' && lw[1] === 'vrf' && child.words.length === 3 && child.kind === 'statement' && !child.children.length) set(child, clearRoutes(child, child.words[2]))
      else if (lw[0] === 'vrf' && child.words.length === 2 && child.kind === 'statement') {
        const instance = child.words[1]
        set(child, mapped([]))
        for (const grandchild of child.children) {
          const removed = grandchild.kind === 'statement' && !grandchild.children.length ? removedFamily(grandchild.words) : null
          if (grandchild.kind === 'comment') set(grandchild, ignored('a comment'))
          else if (grandchild.words[0]?.toLowerCase() === 'address-family') mapStaticFamily(grandchild, instance)
          else if (removed !== null) set(grandchild, clearRoutes(grandchild, instance, removed))
          else unsupportedTree(grandchild)
        }
      } else unsupportedTree(child)
    }
  }

  const buildRoutes = () => {
    for (const { instance, prefix, hops } of routes.values()) {
      const at = ['networkInstances', instance, 'staticRoutes', prefix]
      // IOS-XR describes each next hop; the model describes the route. The first description wins: another is
      // unsupported.
      const described = hops.find((h) => h.description !== undefined)
      let index = 0
      for (const h of hops) {
        if (described && h.description !== undefined && h.description !== described.description) {
          set(h.node, unsupported(`a second description for the route described on line ${line(described.node)}`))
          continue
        }
        const fields: string[] = []
        if (h.description !== undefined) fields.push(model.set([...at, 'description'], h.description))
        for (const [k, v] of Object.entries(h.hop)) fields.push(model.set([...at, 'nextHops', String(index), k], v))
        set(h.node, mapped(fields))
        index++
      }
    }
  }

  // ---- VRFs

  /** A route target statement (a one-line `import route-target V`, or one value inside the block form). */
  type RouteTarget = { readonly node: XrNode; readonly direction: 'import' | 'export'; readonly value: string }
  /**
   * Each VRF's `vrf X` statements, so `no vrf X` can remove them, and its route targets by address family (`ipv4`,
   * `ipv6` unicast), with the first route target statement not converted: the VRF's route targets are a whole, so one
   * left out leaves them all out.
   */
  type VrfState = { readonly definitions: XrNode[]; readonly families: Map<'ipv4' | 'ipv6', RouteTarget[]>; unconverted?: XrNode }
  const vrfs = new Map<string, VrfState>()
  const vrfOfName = (instance: string): VrfState => {
    const state = vrfs.get(instance) ?? { definitions: [], families: new Map() }
    vrfs.set(instance, state)
    return state
  }

  /** One route target value: taken, or the whole VRF's left out (`stitching`, a form the model doesn't have). */
  const routeTarget = (node: XrNode, state: VrfState, targets: RouteTarget[], direction: 'import' | 'export', words: readonly string[]) => {
    if (words.length === 1 && isRouteDistinguisher(words[0])) {
      targets.push({ node, direction, value: words[0] })
      set(node, mapped([]))
    } else {
      set(node, unsupported(words.length > 1 ? 'a route target with an option that isn\'t converted yet' : 'not a route target in the form ASN:nn, IP:nn or ASN4:nn'))
      state.unconverted ??= node
    }
  }

  /**
   * `address-family ipv4|ipv6 unicast` inside `vrf X`: its route targets, one per line or listed in a block. IOS-XR sets
   * them per address family; the model holds one set for the VRF, so they map once every family's agree (once every
   * statement is read).
   */
  const mapVrfFamily = (node: XrNode, instance: string, family: 'ipv4' | 'ipv6'): void => {
    const state = vrfOfName(instance)
    const targets = state.families.get(family) ?? []
    state.families.set(family, targets)
    set(node, ignored('an address family of the VRF: the model\'s VRFs carry every family'))
    for (const child of node.children) {
      const w = child.words
      const lw = w.map((x) => x.toLowerCase())
      if (child.kind === 'comment') set(child, ignored('a comment'))
      else if (child.kind === 'statement' && (lw[0] === 'import' || lw[0] === 'export') && lw[1] === 'route-target') {
        const direction = lw[0]
        if (w.length > 2) {
          routeTarget(child, state, targets, direction, w.slice(2))
          for (const inner of child.children) unsupportedTree(inner)
        } else {
          // The block form: each value on a line of its own.
          set(child, child.children.length ? mapped([]) : ignored('no route targets: nothing to convert'))
          for (const value of child.children) {
            if (value.kind === 'comment') set(value, ignored('a comment'))
            else if (value.kind !== 'statement' || value.children.length) {
              unsupportedTree(value)
              state.unconverted ??= value
            } else routeTarget(value, state, targets, direction, value.words)
          }
        }
      } else if (child.kind === 'statement' && (lw[0] === 'import' || lw[0] === 'export')) unsupportedTree(child, 'a VRF\'s import or export policy: route policies come later')
      else {
        unsupportedTree(child)
        if (lw.includes('route-target')) state.unconverted ??= child
      }
    }
  }

  /** `vrf X` at the top: the VRF, with its route targets. Its route distinguisher is BGP's (`router bgp`), not here. */
  const mapVrf = (node: XrNode): void => {
    const w = node.words
    if (w.length !== 2 || w[1] === 'default') return unsupportedTree(node)
    const instance = w[1]
    vrfOfName(instance).definitions.push(node)
    set(node, mapped([model.set(['networkInstances', instance, 'type'], 'vrf')]))
    for (const child of node.children) {
      const lw = child.words.map((x) => x.toLowerCase())
      if (child.kind === 'comment') set(child, ignored('a comment'))
      else if (child.kind === 'statement' && lw[0] === 'address-family' && child.words.length === 3 && (lw[1] === 'ipv4' || lw[1] === 'ipv6') && lw[2] === 'unicast') mapVrfFamily(child, instance, lw[1])
      else if (lw[0] === 'description') unsupportedTree(child, 'the model has no description for a VRF')
      else unsupportedTree(child)
    }
  }

  /** `no vrf X`: removes the VRF, its route targets and every route in it. */
  const removeVrf = (node: XrNode): StatementDisposition => {
    const w = node.words
    if (w.length !== 3 || w[2] === 'default') return unsupported()
    const instance = w[2]
    const definitions = vrfs.get(instance)?.definitions ?? []
    const removed = [...definitions, ...[...routes.values()].filter((r) => r.instance === instance).flatMap((r) => r.hops.map((h) => h.node))]
    if (!removed.length) return ignored('no such VRF: nothing to convert')
    const why = ignored(`removed by line ${line(node)}`)
    // Everything inside the VRF goes with it: its route targets and settings, converted or not.
    const inside = (n: XrNode): XrNode[] => n.children.flatMap((c) => (c.kind === 'comment' ? [] : [c, ...inside(c)]))
    for (const n of [...removed, ...definitions.flatMap(inside)]) set(n, why)
    for (const [key, r] of routes) if (r.instance === instance) routes.delete(key)
    for (const [key, u] of unconvertedRoutes) if (u.instance === instance) takeUnconverted(key, why)
    vrfs.delete(instance)
    model.prune(['networkInstances', instance], 0)
    return ignored(`removes the VRF and its routes (${linesText(removed.map(line).sort((a, b) => a - b))}): nothing to convert`)
  }

  // ---- DNS

  /** The statements that added each name server, by address, so `no domain name-server` can remove them. */
  const nameServers = new Map<string, XrNode>()

  /** `domain [vrf V] name-server A`: one server per statement. */
  const mapNameServer = (node: XrNode, address: string, vrf: string | undefined): StatementDisposition => {
    if (!isIpv4(address) && !isIpv6(address)) return unsupported(`word ${node.words.length} isn't an address`)
    const key = addressKey(address)
    const at = ['system', 'dns', 'servers', key]
    // The model keys servers by address alone: the same server in another VRF has nowhere to go.
    const existing = model.get(at)
    if (existing !== undefined && (existing as Obj).networkInstance !== vrf) return unsupported(`a server of line ${line(nameServers.get(key)!)} in another VRF: the model keys name servers by address alone`)
    const previous = nameServers.get(key)
    if (previous) set(previous, ignored(`repeated on line ${line(node)}`))
    nameServers.set(key, node)
    return mapped([vrf === undefined ? model.set(at, {}) : model.set([...at, 'networkInstance'], vrf)])
  }

  /** `no domain [vrf V] name-server A`: removes the server only in the VRF it names (no VRF and `default` alike). */
  const removeNameServer = (node: XrNode, address: string, vrf: string | undefined): StatementDisposition => {
    const key = addressKey(address)
    const existing = model.get(['system', 'dns', 'servers', key])
    const added = nameServers.get(key)
    if (existing === undefined || !added || (existing as Obj).networkInstance !== vrf) return ignored('no such name server in that VRF: nothing to convert')
    nameServers.delete(key)
    model.prune(['system', 'dns', 'servers', key], 0)
    set(added, ignored(`removed by line ${line(node)}`))
    return ignored(`removes the name server on line ${line(added)}: nothing to convert`)
  }

  /** The statement that added each search domain. */
  const searchStatements = new Map<string, XrNode>()

  const mapDomainList = (node: XrNode, domain: string, remove: boolean): StatementDisposition => {
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

  /** `[no] domain …`: the domain name, name servers (globally or in a VRF) and the search list. */
  const mapDomain = (node: XrNode, remove: boolean): StatementDisposition => {
    const w = node.words.slice(remove ? 1 : 0)
    const lw = w.map((x) => x.toLowerCase())
    if (lw[1] === 'name' && w.length === 3) {
      if (remove) return unclaim('domain name', node, 'domain name', ['system', 'domainName'], 0)
      claim('domain name', node)
      return mapped([model.set(['system', 'domainName'], w[2])])
    }
    if (lw[1] === 'name' && w.length === 2 && remove) return unclaim('domain name', node, 'domain name', ['system', 'domainName'], 0)
    if (lw[1] === 'name-server' && w.length === 3) return remove ? removeNameServer(node, w[2], undefined) : mapNameServer(node, w[2], undefined)
    if (lw[1] === 'vrf' && lw[3] === 'name-server' && w.length === 5) return remove ? removeNameServer(node, w[4], vrfName(w[2])) : mapNameServer(node, w[4], vrfName(w[2]))
    if (lw[1] === 'list' && w.length === 3) return mapDomainList(node, w[2], remove)
    if (lw[1] === 'vrf' && w.length >= 4 && vrfName(w[2]) !== undefined) return unsupported('a VRF\'s own DNS settings: the model has one DNS configuration')
    if (lw[1] === 'lookup') return unsupported('turns DNS lookups off or sets their source, which the model doesn\'t hold')
    return unsupported()
  }

  // ---- NTP, logging, SNMP

  /**
   * Servers IOS-XR keys by address and VRF (NTP servers, syslog hosts), which the model keys by address alone. One
   * entry per address: the statement that set it, its VRF, and whether it was converted. A later statement for the same
   * address and VRF replaces it, converted or not (an edit adding an authentication key leaves the server out, rather
   * than mapped without its key); one for the same address in another VRF is a second server the model can't hold, and
   * is unsupported; `no …` removes the server only in the VRF it names (no VRF and `default` alike).
   */
  const scopedServers = (one: string, noun: string, plural: string, base: Segments) => {
    const servers = new Map<string, { readonly node: XrNode; readonly vrf: string | undefined }>()
    return {
      /** A statement for `address` in `vrf`: `server` is what it says, or null when it isn't converted (`reason`). */
      add(node: XrNode, address: string, vrf: string | undefined, server: Obj | null, reason?: string): StatementDisposition {
        const at = [...base, address]
        const existing = servers.get(address)
        if (existing && existing.vrf !== vrf) return unsupported(server ? `${one} of line ${line(existing.node)} in another VRF: the model keys ${plural} by address alone` : reason)
        if (existing) {
          set(existing.node, ignored(`superseded by line ${line(node)}`))
          model.prune(at, 0)
        }
        servers.set(address, { node, vrf })
        if (!server) return unsupported(reason)
        if (vrf !== undefined) server.networkInstance = vrf
        if (!Object.keys(server).length) return mapped([model.set(at, {})])
        return mapped(Object.entries(server).map(([k, v]) => model.set([...at, k], v)))
      },
      remove(node: XrNode, address: string, vrf: string | undefined): StatementDisposition {
        const existing = servers.get(address)
        if (!existing || existing.vrf !== vrf) return ignored(`no such ${noun} in that VRF: nothing to convert`)
        servers.delete(address)
        model.prune([...base, address], 0)
        set(existing.node, ignored(`removed by line ${line(node)}`))
        return ignored(`removes the ${noun} on line ${line(existing.node)}: nothing to convert`)
      }
    }
  }
  const ntpServers = scopedServers('an NTP server', 'NTP server', 'NTP servers', ['system', 'ntp', 'servers'])
  const syslogHosts = scopedServers('a syslog host', 'syslog host', 'syslog hosts', ['system', 'logging', 'remoteServers'])

  /**
   * An NTP command, inside the `ntp` block or after `ntp` on one line: `server [vrf V] A [prefer] [version N]`,
   * `source IF`, and their `no` forms. `words` is the command's own words; `offset` how many came before them.
   */
  const mapNtpCommand = (node: XrNode, w: readonly string[], offset: number): StatementDisposition => {
    const lw = w.map((x) => x.toLowerCase())
    if (lw[0] === 'source' && w.length === 2 && isInterfaceName(w[1])) {
      claim('ntp source', node)
      return mapped([model.set(['system', 'ntp', 'sourceInterface'], w[1])])
    }
    if (lw[0] === 'source' && lw[1] === 'vrf') return unsupported('a source interface for one VRF: the model has one for NTP')
    if (lw[0] === 'no' && lw[1] === 'source' && w.length <= 3) return unclaim('ntp source', node, 'NTP source interface', ['system', 'ntp', 'sourceInterface'], 0)
    const remove = lw[0] === 'no'
    const s = remove ? 1 : 0
    if (lw[s] !== 'server') return unsupported()
    let i = s + 1
    let vrf: string | undefined
    if (lw[i] === 'vrf' && w[i + 1] !== undefined) {
      vrf = vrfName(w[i + 1])
      i += 2
    }
    const address = w[i]
    if (!address || !(isIpv4(address) || isIpv6(address) || HOST.test(address))) return unsupported()
    const key = addressKey(address)
    // `no server A …` names the server by its VRF and address; anything after them is IOS-XR's to ignore.
    if (remove) return ntpServers.remove(node, key, vrf)
    const server: Obj = {}
    for (i++; i < w.length; ) {
      if (lw[i] === 'prefer' && server.prefer === undefined) {
        server.prefer = true
        i++
      } else if (lw[i] === 'version' && /^[1-4]$/.test(w[i + 1] ?? '') && server.version === undefined) {
        server.version = Number(w[i + 1])
        i += 2
      } else if (lw[i] === 'key') return ntpServers.add(node, key, vrf, null, 'a server with an authentication key, which doesn\'t carry over')
      else return ntpServers.add(node, key, vrf, null, `word ${offset + i + 1} isn't converted yet`)
    }
    return ntpServers.add(node, key, vrf, server)
  }

  /** The `ntp` block: each command inside it. */
  const mapNtpBlock = (node: XrNode): void => {
    set(node, mapped([]))
    for (const child of node.children) {
      if (child.kind === 'comment') set(child, ignored('a comment'))
      else if (child.kind !== 'statement' || child.children.length) unsupportedTree(child)
      else set(child, mapNtpCommand(child, child.words, 0))
    }
  }

  const mapLogging = (node: XrNode): StatementDisposition => {
    const w = node.words
    const lw = w.map((x) => x.toLowerCase())
    if (lw[1] === 'source-interface' && w.length >= 3 && isInterfaceName(w[2])) {
      if (w.length === 5 && lw[3] === 'vrf' && vrfName(w[4]) !== undefined) return unsupported('a source interface for one VRF: the model has one for syslog')
      if (w.length !== 3 && !(w.length === 5 && lw[3] === 'vrf')) return unsupported()
      claim('logging source', node)
      return mapped([model.set(['system', 'logging', 'sourceInterface'], w[2])])
    }
    // A host is an address: a name could be one of the many `logging` keywords.
    if (!w[1] || !(isIpv4(w[1]) || isIpv6(w[1]))) return unsupported()
    const address = addressKey(w[1])
    // Its VRF, wherever it is on the line: a statement not converted still names the host it edits.
    const at = lw.indexOf('vrf', 2)
    const vrf = at > 0 && w[at + 1] !== undefined ? vrfName(w[at + 1]) : undefined
    const server: Obj = {}
    let vrfGiven = false
    for (let i = 2; i < w.length; ) {
      if (lw[i] === 'vrf' && w[i + 1] !== undefined && !vrfGiven) {
        vrfGiven = true
        i += 2
      } else if (lw[i] === 'severity' && Object.hasOwn(SEVERITY_WORDS, lw[i + 1] ?? '') && server.severity === undefined) {
        server.severity = SEVERITY_WORDS[lw[i + 1]]
        i += 2
      } else if (lw[i] === 'port' && lw[i + 1] === 'default' && server.port === undefined) {
        // The default port, 514: nothing to say.
        i += 2
      } else if (lw[i] === 'port' && inRange(w[i + 1] ?? '', PORT) && server.port === undefined) {
        server.port = Number(w[i + 1])
        i += 2
      } else return syslogHosts.add(node, address, vrf, null, `word ${i + 1} isn't converted yet`)
    }
    return syslogHosts.add(node, address, vrf, server)
  }

  /** `no logging A [vrf V]` and `no logging source-interface`. */
  const removeLogging = (node: XrNode): StatementDisposition => {
    const w = node.words
    const lw = w.map((x) => x.toLowerCase())
    if (lw[2] === 'source-interface') return unclaim('logging source', node, 'syslog source interface', ['system', 'logging', 'sourceInterface'], 0)
    if (!w[2] || !(isIpv4(w[2]) || isIpv6(w[2]))) return unsupported()
    const at = lw.indexOf('vrf', 3)
    return syslogHosts.remove(node, addressKey(w[2]), at > 0 && w[at + 1] !== undefined ? vrfName(w[at + 1]) : undefined)
  }

  /**
   * Every statement about each SNMP community, by name (a Map: names are any string), and the first one not converted:
   * it may limit or change the community (an access list, SystemOwner), so the community is then left out whole.
   */
  const communities = new Map<string, { nodes: XrNode[]; unconverted?: XrNode }>()
  const communityOf = (name: string) => {
    const state = communities.get(name) ?? { nodes: [] }
    communities.set(name, state)
    return state
  }

  // Community names are secrets: no disposition reason or diagnostic here repeats a word of the statement.
  const mapSnmp = (node: XrNode): StatementDisposition => {
    const w = node.words
    const lw = w.map((x) => x.toLowerCase())
    if ((lw[1] === 'location' || lw[1] === 'contact') && w.length > 2) {
      claim(`snmp ${lw[1]}`, node)
      return mapped([model.set(['system', 'snmp', lw[1]], node.text.replace(/^\S+\s+\S+\s+/, ''))])
    }
    if (lw[1] !== 'community' || w.length < 3) return unsupported()
    if (lw[2] === 'encrypted') return unsupported('an encrypted community, which doesn\'t carry over')
    const n = lw[2] === 'clear' ? 3 : 2
    if (w[n] === undefined) return unsupported()
    const name = unquote(w[n])
    const state = communityOf(name)
    state.nodes.push(node)
    const rest = lw.slice(n + 1)
    const at = ['system', 'snmp', 'communities', name]
    let d: StatementDisposition
    if (rest.length === 1 && (rest[0] === 'ro' || rest[0] === 'rw')) {
      claim(`${fieldPath(...at)}.access`, node)
      d = mapped([model.set([...at, 'access'], rest[0] === 'ro' ? 'read-only' : 'read-write')])
    } else if (!rest.length) {
      if (model.get(at) === undefined) model.set(at, {})
      d = mapped([fieldPath(...at)])
    } else if (rest.some((x) => x === 'ipv4' || x === 'ipv6') || rest.length > 2) d = unsupported('limits the community to some clients with an access list, which comes with filters')
    else if (rest.some((x) => x === 'systemowner' || x === 'sdrowner')) d = unsupported('a community with owner access, which the model can\'t say')
    else d = unsupported('limits the community to some clients with an access list, which comes with filters')
    if (d.kind === 'unsupported') state.unconverted ??= node
    return d
  }

  /** `no snmp-server community X`: removes the community and every statement about it before. */
  const removeCommunity = (node: XrNode): StatementDisposition => {
    const w = node.words
    const n = w[3]?.toLowerCase() === 'clear' ? 4 : 3
    if (w.length < n + 1) return unsupported()
    const name = unquote(w[n])
    if (w.length > n + 1) {
      // Removing part of a community would leave it changed in a way the model can't follow: it is left out whole.
      const state = communityOf(name)
      state.nodes.push(node)
      state.unconverted ??= node
      return unsupported('removes part of a community: the community is left out whole')
    }
    const state = communities.get(name)
    if (!state) return ignored('no such community: nothing to convert')
    for (const s of state.nodes) set(s, ignored(`removed by line ${line(node)}`))
    communities.delete(name)
    owners.delete(`${fieldPath('system', 'snmp', 'communities', name)}.access`)
    model.prune(['system', 'snmp', 'communities', name], 0)
    return ignored('removes the community configured before it: nothing to convert')
  }

  // ---- the top level

  const mapTop = (node: XrNode): void => {
    if (node.kind === 'comment') return set(node, ignored('a comment'))
    const lines = node.span.endLine - node.span.startLine + 1
    const size = `${lines} line${lines === 1 ? '' : 's'}`
    if (node.kind === 'banner') {
      // Its type isn't named: a word of the configuration, it could be a secret's value reused.
      return set(node, unsupported(`a banner, ${size}, kept verbatim`))
    }
    if (node.kind === 'policy') return set(node, unsupported(`a route policy, ${size}, kept whole: route policies come later`))
    if (node.kind === 'set') return set(node, unsupported(`a set for route policies, ${size}, kept whole: route policies come later`))

    const w = node.words
    const lw = w.map((x) => x.toLowerCase())
    if (lw[0] === 'interface') return mapInterface(node)
    if (lw[0] === 'vrf') return mapVrf(node)
    if (lw[0] === 'router' && lw[1] === 'static' && w.length === 2) return mapRouterStatic(node)
    if (lw[0] === 'ntp' && w.length === 1) return mapNtpBlock(node)
    if (node.children.length) return unsupportedTree(node)

    let d: StatementDisposition = unsupported()
    if (lw[0] === 'hostname' && w.length === 2) {
      claim('hostname', node)
      d = mapped([model.set(['system', 'hostname'], w[1])])
    } else if (lw[0] === 'no' && lw[1] === 'hostname' && w.length <= 3) d = unclaim('hostname', node, 'hostname', ['system', 'hostname'], 0)
    else if (lw[0] === 'domain') d = mapDomain(node, false)
    else if (lw[0] === 'no' && lw[1] === 'domain') d = mapDomain(node, true)
    else if (lw[0] === 'ntp') d = mapNtpCommand(node, w.slice(1), 1)
    else if (lw[0] === 'no' && lw[1] === 'ntp') d = mapNtpCommand(node, ['no', ...w.slice(2)], 1)
    else if (lw[0] === 'logging') d = mapLogging(node)
    else if (lw[0] === 'no' && lw[1] === 'logging') d = removeLogging(node)
    else if (lw[0] === 'no' && lw[1] === 'snmp-server' && (lw[2] === 'contact' || lw[2] === 'location')) d = unclaim(`snmp ${lw[2]}`, node, `SNMP ${lw[2]}`, ['system', 'snmp', lw[2]], 0)
    else if (lw[0] === 'snmp-server') d = mapSnmp(node)
    else if (lw[0] === 'no' && lw[1] === 'snmp-server' && lw[2] === 'community') d = removeCommunity(node)
    else if (lw[0] === 'no' && lw[1] === 'vrf') d = removeVrf(node)
    else if (lw[0] === 'no' && lw[1] === 'router' && lw[2] === 'static' && w.length === 3) d = clearRoutes(node)
    else if (lw[0] === 'end' && w.length === 1) d = ignored('the end of the configuration')
    else if (lw[0] === 'exit' && w.length === 1) d = ignored('leaves a configuration mode: nothing to convert')
    else if (node.text === 'Building configuration...') d = ignored('show running-config\'s header')
    set(node, d)
  }

  for (const node of nodes) mapTop(node)
  buildRoutes()

  // A VRF's route targets: one set in the model, so every address family's must agree (a family with none disagrees
  // with one with some), and none may be left out.
  for (const [instance, state] of vrfs) {
    const all = [...state.families.values()].flat()
    if (!all.length) continue
    const lists = [...state.families.values()].map((targets) => ({
      import: [...new Set(targets.filter((t) => t.direction === 'import').map((t) => t.value))],
      export: [...new Set(targets.filter((t) => t.direction === 'export').map((t) => t.value))]
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
    for (const t of all) set(t.node, mapped([fieldPath(...at, t.direction)]))
  }

  // A subinterface in a VRF the text doesn't define (or removes) would name a network instance the model doesn't
  // have: its membership and its addresses, which would otherwise land in the global table, are left out.
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

  // A community with a statement not converted anywhere in the text (an access list, owner access) is left out whole:
  // mapped without it, it could answer clients or allow access the source doesn't.
  for (const [name, state] of communities) {
    if (!state.unconverted) continue
    model.prune(['system', 'snmp', 'communities', name], 0)
    for (const n of state.nodes) if (dispositions[n.id]?.kind === 'mapped') set(n, unsupported(`left out whole: line ${line(state.unconverted)} about the same community isn't converted, and may limit or change it`))
  }

  for (const state of addressing.values()) {
    if (state.family === 6) continue
    const at = familyPath(state.ctx, state.family)
    if (!state.secondaries.length) continue
    if (!state.primary || !('address' in state.primary)) {
      // The model can mark an address primary but not secondary: without a primary, a secondary would come back as one.
      for (const s of state.secondaries) {
        model.remove([...at, 'addresses', s.address])
        set(s.node, unsupported(state.primary ? `a secondary address beside ${state.primary.what}` : 'a secondary address with no primary address: the model can\'t say an address is secondary'))
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

  return { tree: nodes, model: model.root as Device, dispositions, diagnostics }
}
