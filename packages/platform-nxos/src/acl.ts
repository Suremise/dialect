// NX-OS access lists → the model's `filters` (model 0.5.1): `ip access-list NAME` and `ipv6 access-list NAME`, and
// their attachment to interfaces (`ip access-group NAME in|out`, `ipv6 traffic-filter NAME in|out`, and on a switch
// port `ip port access-group NAME in`, `ipv6 port traffic-filter NAME in`). Read statement by statement, as the device
// applies them, then put in the model once the whole text is read, since an interface can name an ACL defined after
// it. This is IOS-XE's reader (packages/platform-iosxe/src/acl.ts) with NX-OS's syntax: keep the two alike.
//
// An entry is a term, keyed by its sequence number (written, or 10 after the highest, a remark's included, as NX-OS
// numbers remarks too), converted whole or not at all (the per-term rule): an entry with anything the model can't
// hold (an address or port group, a packet length, a TTL) is left out whole, and the whole ACL with it unless it is
// the last (filterTermSkipSafe(): a permit or deny decides). Addresses are prefixes (`A/len`), or a wildcard, which is
// a prefix only when it is contiguous: a non-contiguous one leaves its entry out, never approximated. Every ACL ends in
// NX-OS's implicit deny. An ACL with no entries, or one the text doesn't define, lets every packet through when
// applied, which the model can't say: an interface applying one is left out.
import { fieldPath, filterReliesOnImplicitAction, filterTermSkipSafe, parsePrefix, type Filter, type FilterMatches, type FilterTerm, type Diagnostic, type StatementDisposition } from '@dialect/core'
import { inRange, ipv6Prefix, isIpv4, maskLength } from './addresses'
import type { NxNode } from './tree'

type Obj = { [key: string]: unknown }
type Family = 'ipv4' | 'ipv6'
type Direction = 'input' | 'output'

/** Sets an own property, so a name like `__proto__` is a key like any other. */
const putOwn = (o: Obj, key: string, value: unknown) => Object.defineProperty(o, key, { value, enumerable: true, writable: true, configurable: true })
function keyed<T>(entries: Iterable<readonly [string, T]>): Record<string, T> {
  const o: Obj = {}
  for (const [k, v] of entries) putOwn(o, k, v)
  return o as Record<string, T>
}

const mapped = (fields: string[]): StatementDisposition => ({ kind: 'mapped', fields })
const unsupported = (reason: string): StatementDisposition => ({ kind: 'unsupported', reason })
const ignored = (reason: string): StatementDisposition => ({ kind: 'ignored-by-design', reason })
const line = (node: NxNode) => node.span.startLine
const all = (n: NxNode): NxNode[] => [n, ...n.children.flatMap(all)]
const linesText = (nodes: readonly NxNode[]) => {
  const lines = [...new Set(nodes.filter((n) => n.kind !== 'comment').map(line))].sort((a, b) => a - b)
  return `line${lines.length > 1 ? 's' : ''} ${lines.join(', ')}`
}

/** IP protocols by NX-OS's names (IPv4; an IPv6 ACL's `icmp` is ICMPv6, 58). */
export const PROTOCOLS: Readonly<Record<string, number>> = { icmp: 1, igmp: 2, ipinip: 4, tcp: 6, udp: 17, gre: 47, esp: 50, ahp: 51, eigrp: 88, ospf: 89, nos: 94, pim: 103, pcp: 108, sctp: 132 }
/** TCP and UDP ports by NX-OS's names. */
export const PORTS: Readonly<Record<'tcp' | 'udp', Readonly<Record<string, number>>>> = {
  tcp: { bgp: 179, chargen: 19, cmd: 514, daytime: 13, discard: 9, domain: 53, echo: 7, exec: 512, finger: 79, ftp: 21, 'ftp-data': 20, gopher: 70, hostname: 101, ident: 113, irc: 194, klogin: 543, kshell: 544, login: 513, lpd: 515, nntp: 119, pop2: 109, pop3: 110, smtp: 25, sunrpc: 111, tacacs: 49, talk: 517, telnet: 23, time: 37, uucp: 540, whois: 43, www: 80 },
  udp: { biff: 512, bootpc: 68, bootps: 67, discard: 9, dnsix: 195, domain: 53, echo: 7, isakmp: 500, 'mobile-ip': 434, nameserver: 42, 'netbios-dgm': 138, 'netbios-ns': 137, 'netbios-ss': 139, 'non500-isakmp': 4500, ntp: 123, rip: 520, snmp: 161, snmptrap: 162, sunrpc: 111, syslog: 514, tacacs: 49, talk: 517, tftp: 69, time: 37, who: 513, xdmcp: 177 }
}
/** ICMP message names, as a type and maybe a code. */
const ICMP4: Readonly<Record<string, readonly [number, number?]>> = {
  'echo-reply': [0], unreachable: [3], 'net-unreachable': [3, 0], 'host-unreachable': [3, 1], 'protocol-unreachable': [3, 2], 'port-unreachable': [3, 3], 'packet-too-big': [3, 4], 'administratively-prohibited': [3, 13],
  'source-quench': [4], redirect: [5], echo: [8], 'router-advertisement': [9], 'router-solicitation': [10], 'time-exceeded': [11], 'ttl-exceeded': [11, 0], 'reassembly-timeout': [11, 1], 'parameter-problem': [12],
  'timestamp-request': [13], 'timestamp-reply': [14], 'information-request': [15], 'information-reply': [16], 'mask-request': [17], 'mask-reply': [18], traceroute: [30]
}
const ICMP6: Readonly<Record<string, readonly [number, number?]>> = {
  unreachable: [1], 'packet-too-big': [2], 'time-exceeded': [3], 'parameter-problem': [4], 'echo-request': [128], 'echo-reply': [129], 'mld-query': [130], 'mld-report': [131], 'mld-reduction': [132],
  'router-solicitation': [133], 'router-advertisement': [134], 'nd-ns': [135], 'nd-na': [136], mldv2: [143]
}
/** DSCP values by name. */
export const DSCP: Readonly<Record<string, number>> = { default: 0, af11: 10, af12: 12, af13: 14, af21: 18, af22: 20, af23: 22, af31: 26, af32: 28, af33: 30, af41: 34, af42: 36, af43: 38, cs1: 8, cs2: 16, cs3: 24, cs4: 32, cs5: 40, cs6: 48, cs7: 56, ef: 46 }
const TCP_FLAGS = new Set(['ack', 'fin', 'psh', 'rst', 'syn', 'urg'])

/** A prefix length's wildcard (`24` is `0.0.0.255`). */
const lengthWildcard = (length: number) => [24, 16, 8, 0].map((shift) => String(255 - (Math.floor((length === 0 ? 0 : (0xffffffff - (2 ** (32 - length) - 1)) >>> 0) / 2 ** shift) % 256))).join('.')

/** An IPv4 address and contiguous wildcard as a prefix, the address's wildcard bits cleared (as NX-OS does), or why not. */
function wildcardPrefix(address: string, wildcard: string): string | { why: string } {
  if (!isIpv4(address) || !isIpv4(wildcard)) return { why: 'not an address and wildcard' }
  const inverse = wildcard.split('.').map((o) => String(255 - Number(o))).join('.')
  const length = maskLength(inverse)
  if (length === null) return { why: 'a non-contiguous wildcard: the model holds prefixes, and approximating it would match other packets' }
  const mask = inverse.split('.').map(Number)
  return `${address.split('.').map((o, i) => Number(o) & mask[i]).join('.')}/${length}`
}

/** Reads an address (`any`, `host A`, `A/len`, `A WILDCARD`) at `w[i]`: its prefix (none for any) and the words used. */
function readAddress(family: Family, w: readonly string[], i: number): { prefix?: string; used: number } | { why: string } {
  const lw = w[i]?.toLowerCase()
  if (lw === undefined) return { why: 'an entry with no address' }
  if (lw === 'any') return { used: 1 }
  if (lw === 'host') {
    const a = w[i + 1]
    if (family === 'ipv4') return a !== undefined && isIpv4(a) ? { prefix: `${a}/32`, used: 2 } : { why: 'not a host address' }
    const p = a !== undefined ? ipv6Prefix(`${a}/128`) : null
    return p ? { prefix: `${p.address}/128`, used: 2 } : { why: 'not a host address' }
  }
  if (lw === 'object-group' || lw === 'addrgroup') return { why: 'an object group, which the model has no form for' }
  if (family === 'ipv6') {
    const p = ipv6Prefix(w[i])
    const prefix = p ? `${p.address}/${p.length}` : undefined
    return prefix !== undefined && parsePrefix(prefix)?.family === 'ipv6' ? { prefix, used: 1 } : { why: 'not an IPv6 prefix with no host bits set' }
  }
  // `A/len`, its host bits cleared, as NX-OS matches it.
  const m = /^([\d.]+)\/(\d{1,2})$/.exec(w[i])
  if (m) {
    const length = inRange(m[2], 0, 32)
    if (!isIpv4(m[1]) || length === null) return { why: 'not an IPv4 prefix' }
    const p = wildcardPrefix(m[1], lengthWildcard(length))
    return typeof p === 'string' ? { prefix: p, used: 1 } : p
  }
  const p = wildcardPrefix(w[i], w[i + 1] ?? '')
  return typeof p === 'string' ? { prefix: p, used: 2 } : p
}

/** Reads a port operator (`eq`, `neq`, `gt`, `lt`, `range`) at `w[i]`, for TCP or UDP: the ranges and the words used. */
function readPorts(protocol: 'tcp' | 'udp', w: readonly string[], i: number): { ranges: string[]; used: number } | { why: string } | undefined {
  const op = w[i]?.toLowerCase()
  if (op !== 'eq' && op !== 'neq' && op !== 'gt' && op !== 'lt' && op !== 'range') return undefined
  const port = (s: string | undefined) => (s === undefined ? null : Object.hasOwn(PORTS[protocol], s.toLowerCase()) ? PORTS[protocol][s.toLowerCase()] : inRange(s, 0, 65535))
  const a = port(w[i + 1])
  if (a === null) return { why: 'not a port NX-OS takes (a number from 0 to 65535 or a name of its own)' }
  if (op === 'range') {
    const b = port(w[i + 2])
    if (b === null || b < a) return { why: 'not a port range NX-OS takes' }
    return { ranges: [a === b ? String(a) : `${a}-${b}`], used: 3 }
  }
  const range = (x: number, y: number) => (x === y ? String(x) : `${x}-${y}`)
  if (op === 'eq') return { ranges: [String(a)], used: 2 }
  if (op === 'gt') return a < 65535 ? { ranges: [range(a + 1, 65535)], used: 2 } : { why: 'no port is greater' }
  if (op === 'lt') return a > 0 ? { ranges: [range(0, a - 1)], used: 2 } : { why: 'no port is less' }
  return { ranges: [...(a > 0 ? [range(0, a - 1)] : []), ...(a < 65535 ? [range(a + 1, 65535)] : [])], used: 2 }
}

/**
 * An entry's words after its sequence number (`permit tcp any host 192.0.2.1 eq 22 log`): its term, or why the model
 * can't hold it.
 */
export function readEntry(family: Family, words: readonly string[]): FilterTerm | { why: string } {
  const lw = words.map((x) => x.toLowerCase())
  const action = lw[0] === 'permit' ? 'accept' : lw[0] === 'deny' ? 'discard' : undefined
  if (!action) return { why: 'not an access list entry the model has' }
  const matches: { -readonly [K in keyof FilterMatches]: FilterMatches[K] } = {}
  let log = false
  let i = 1
  {
    const proto = lw[1]
    let protocol: number | undefined
    if (proto === (family === 'ipv4' ? 'ip' : 'ipv6')) protocol = undefined
    else if (family === 'ipv6' && proto === 'icmp') protocol = 58
    else if (proto !== undefined && Object.hasOwn(PROTOCOLS, proto) && (family === 'ipv4' || !['igmp', 'ipinip', 'gre', 'eigrp', 'ospf', 'nos', 'pim', 'pcp', 'icmp'].includes(proto))) protocol = PROTOCOLS[proto]
    else {
      const n = inRange(proto, 0, 255)
      if (n === null) return { why: proto === 'object-group' ? 'an object group, which the model has no form for' : 'not a protocol the model has a number for' }
      protocol = n
    }
    if (protocol !== undefined) matches.protocols = [protocol]
    const portProtocol = protocol === 6 ? 'tcp' : protocol === 17 ? 'udp' : undefined
    i = 2
    for (const side of ['source', 'destination'] as const) {
      const a = readAddress(family, words, i)
      if ('why' in a) return a
      // A /0 matches every address, as `any` does: the model says it the same way, by leaving it out.
      if (a.prefix !== undefined && !a.prefix.endsWith('/0')) matches[side === 'source' ? 'sourcePrefixes' : 'destinationPrefixes'] = [a.prefix]
      i += a.used
      const ports = portProtocol ? readPorts(portProtocol, words, i) : undefined
      if (ports && 'why' in ports) return ports
      if (ports) {
        matches[side === 'source' ? 'sourcePorts' : 'destinationPorts'] = ports.ranges
        i += ports.used
      }
    }
    // ICMP: a type and maybe a code, by number or name.
    const icmp = protocol === 1 ? ICMP4 : protocol === 58 ? ICMP6 : undefined
    if (icmp && i < words.length) {
      const named = Object.hasOwn(icmp, lw[i]) ? icmp[lw[i]] : undefined
      const type = named ? named[0] : inRange(words[i], 0, 255)
      if (type !== null) {
        matches.icmpTypes = [type]
        i++
        const code = named ? named[1] : inRange(words[i], 0, 255) ?? undefined
        if (code !== undefined && code !== null) {
          matches.icmpCodes = [code]
          if (!named) i++
        }
      }
    }
    const set: string[] = []
    const clear: string[] = []
    while (i < words.length) {
      const o = lw[i]
      if (o === 'log' && !log) log = true
      else if (o === 'established' && portProtocol === 'tcp' && !matches.tcpEstablished) matches.tcpEstablished = true
      else if (o === 'fragments' && matches.fragment === undefined) matches.fragment = 'non-initial'
      else if (o === 'dscp' && matches.dscp === undefined) {
        const v = Object.hasOwn(DSCP, lw[i + 1] ?? '') ? DSCP[lw[i + 1]] : inRange(words[i + 1], 0, 63)
        if (v === null) return { why: 'not a DSCP value from 0 to 63' }
        matches.dscp = [v]
        i++
      } else if (o === 'match-all' && portProtocol === 'tcp' && !set.length && !clear.length) {
        // `match-all +syn -ack`: every flag after it, set or clear.
        while (i + 1 < words.length && /^[+-]/.test(words[i + 1]) && TCP_FLAGS.has(lw[i + 1].slice(1))) {
          ;(lw[i + 1][0] === '+' ? set : clear).push(lw[i + 1].slice(1))
          i++
        }
        if (!set.length && !clear.length) return { why: 'match-all with no flags' }
      } else if (TCP_FLAGS.has(o) && portProtocol === 'tcp' && !set.includes(o)) set.push(o)
      else return { why: o === 'log-input' ? 'log-input: the model logs a packet, not its input interface' : 'an option the model has no form for' }
      i++
    }
    if (set.length || clear.length) matches.tcpFlags = { ...(set.length ? { set } : {}), ...(clear.length ? { clear } : {}) } as FilterMatches['tcpFlags']
  }
  return { ...(Object.keys(matches).length ? { matches } : {}), actions: { action, ...(log ? { log: true } : {}) } }
}

/** A term's match leaves, as paths under `matches`: `tcpFlags` has two, `set` and `clear`. */
export const matchLeaves = (t: FilterTerm): string[][] => Object.entries(t.matches ?? {}).flatMap(([leaf, v]) => (leaf === 'tcpFlags' && typeof v === 'object' && v !== null && !Array.isArray(v) ? Object.keys(v).map((k) => [leaf, k]) : [[leaf]]))

/** A remark's text: everything after `remark` on its line, as written. */
const remarkText = (node: NxNode): string => node.text.trim().replace(/^.*?\bremark\b\s*/i, '').trim()

/** An ACL as read: its entries by sequence number, and every statement about it. */
interface AclState {
  readonly family: Family
  readonly headers: NxNode[]
  readonly nodes: NxNode[]
  readonly entries: Map<number, { readonly node: NxNode; readonly term?: FilterTerm; readonly why?: string; readonly remarks: readonly NxNode[] }>
  /** Remarks read since the last entry: they describe the next one. */
  remarks: NxNode[]
  /** The sequence numbers remarks take, as NX-OS numbers them: no entry may have one. */
  readonly remarkSeqs: Map<number, NxNode>
  /** The first statement about it that isn't converted: the ACL is left out whole. */
  unconverted?: NxNode
}

/** An interface's `ip access-group` or `ipv6 traffic-filter` (or their port forms), by subinterface path, family and direction. */
interface Attachment {
  readonly node: NxNode
  readonly sub: readonly string[]
  readonly family: Family
  readonly direction: Direction
  readonly name: string
}

/**
 * Reads NX-OS's access lists as they come (`top()`) and interfaces' attachments (`attach()`), and puts what they
 * leave in the model once the text is read (`finish()`). Dispositions go in `dispositions`, by statement id.
 */
export function createAclReader(dispositions: Record<string, StatementDisposition>) {
  const set = (node: NxNode, d: StatementDisposition) => {
    dispositions[node.id] = d
  }
  const demote = (node: NxNode, reason: string) => {
    if (dispositions[node.id]?.kind === 'mapped') set(node, unsupported(reason))
  }
  const acls = new Map<string, AclState>()
  const keyOf = (family: Family, name: string) => `${family}|${name}`
  const stateOf = (family: Family, name: string): AclState => {
    const s = acls.get(keyOf(family, name)) ?? { family, headers: [], nodes: [], entries: new Map(), remarks: [], remarkSeqs: new Map() }
    acls.set(keyOf(family, name), s)
    return s
  }
  const removeAcl = (family: Family, name: string, node: NxNode): StatementDisposition => {
    const state = acls.get(keyOf(family, name))
    if (!state?.nodes.length) return ignored('no such access list: nothing to convert')
    for (const n of state.nodes) set(n, n.kind === 'comment' ? ignored('a comment') : ignored(`removed by line ${line(node)}`))
    acls.delete(keyOf(family, name))
    return ignored(`removes the access list configured on ${linesText(state.nodes)}: nothing to convert`)
  }

  /** One entry line (`[N] permit …`, `[N] remark …`, `no N`) of an ACL. */
  const readLine = (state: AclState, node: NxNode, words: readonly string[]): void => {
    const lw = words.map((x) => x.toLowerCase())
    state.nodes.push(node)
    if (lw[0] === 'no') {
      const seq = inRange(words[1], 1, 4294967295)
      if (seq === null || words.length !== 2) {
        state.unconverted ??= node
        return set(node, unsupported('takes an entry out by what it says, which isn\'t converted: by its sequence number it is'))
      }
      const remark = state.remarkSeqs.get(seq)
      if (remark) {
        state.unconverted ??= node
        return set(node, unsupported('takes a remark out, which isn\'t converted'))
      }
      const found = state.entries.get(seq)
      if (!found) return set(node, ignored('no such entry: nothing to convert'))
      // A remark before it stays on the device, but describes an entry that is gone.
      for (const n of [found.node, ...found.remarks]) set(n, ignored(`removed by line ${line(node)}`))
      state.entries.delete(seq)
      return set(node, ignored(`removes the entry on line ${line(found.node)}: nothing to convert`))
    }
    // The sequence number, written first, or 10 after the highest (a remark's counts: NX-OS numbers remarks too).
    const written = /^\d+$/.test(words[0] ?? '')
    const seq = written ? inRange(words[0], 1, 4294967295) : Math.max(0, ...state.entries.keys(), ...state.remarkSeqs.keys()) + 10
    const rest = written ? words.slice(1) : words
    if (seq === null || seq > 4294967294 || state.entries.has(seq) || state.remarkSeqs.has(seq)) {
      state.unconverted ??= node
      return set(node, unsupported(seq === null || seq > 4294967294 ? 'not a sequence number NX-OS takes' : 'a sequence number the access list already has: NX-OS refuses the entry'))
    }
    // A remark describes the entry after it: its text is that entry's description (model 0.5.3).
    if (rest[0]?.toLowerCase() === 'remark') {
      state.remarks.push(node)
      state.remarkSeqs.set(seq, node)
      return set(node, ignored('a remark: it describes the entry after it'))
    }
    const read = readEntry(state.family, rest)
    const remarks = state.remarks
    state.remarks = []
    if ('why' in read) {
      state.entries.set(seq, { node, why: read.why, remarks })
      for (const r of remarks) set(r, unsupported(`describes the entry on line ${line(node)}, which isn't converted`))
      return set(node, unsupported(read.why))
    }
    const description = remarks.map(remarkText).filter((t) => t !== '').join(' ')
    state.entries.set(seq, { node, term: description ? { description, ...read } : read, remarks })
    set(node, mapped([]))
  }

  /** Reads a top-level statement if it is an access list, with its disposition; false when it isn't. */
  const top = (node: NxNode): boolean => {
    const w = node.words
    const lw = w.map((x) => x.toLowerCase())
    const remove = lw[0] === 'no'
    const a = remove ? lw.slice(1) : lw
    const aw = remove ? w.slice(1) : w
    // `ip access-list NAME`, `ipv6 access-list NAME`, with their entries inside.
    if (!((a[0] === 'ip' || a[0] === 'ipv6') && a[1] === 'access-list')) return false
    const family: Family = a[0] === 'ip' ? 'ipv4' : 'ipv6'
    const name = aw[2]
    const refuse = (reason: string) => {
      for (const n of all(node)) set(n, n.kind === 'comment' ? ignored('a comment') : unsupported(reason))
      return true
    }
    if (name === undefined || aw.length !== 3 || !/^[^\s"]{1,64}$/.test(name)) return refuse('not an access list statement the model has')
    if (remove) {
      if (node.children.length) return refuse('not an access list statement the model has')
      set(node, removeAcl(family, name, node))
      return true
    }
    const state = stateOf(family, name)
    state.headers.push(node)
    state.nodes.push(node)
    set(node, mapped([]))
    for (const child of node.children) {
      const cw = child.words.map((x) => x.toLowerCase())
      if (child.kind === 'comment') set(child, ignored('a comment'))
      else if (child.children.length) {
        state.unconverted ??= child
        for (const n of all(child)) set(n, unsupported('not an access list entry the model has'))
      } else if (cw.length === 2 && cw[0] === 'statistics' && cw[1] === 'per-entry') {
        state.nodes.push(child)
        set(child, ignored('counts each entry\'s matches: the model\'s counters are named, and NX-OS\'s aren\'t'))
      } else readLine(state, child, child.words)
    }
    return true
  }

  const attachments = new Map<string, Attachment>()
  /**
   * An interface's `[no] ip access-group NAME in|out` or `[no] ipv6 traffic-filter NAME in|out`, or on a switch port
   * `[no] ip port access-group NAME in` or `[no] ipv6 port traffic-filter NAME in`, on the subinterface at `sub` (`0`
   * for a main interface); undefined when the statement is none of them. The model says the same of a port ACL and a
   * routed one (the render writes the form the interface takes). A later one of a direction replaces the earlier, as
   * on the device.
   */
  const attach = (node: NxNode, sub: readonly string[]): StatementDisposition | undefined => {
    const w = node.words
    const lw = w.map((x) => x.toLowerCase())
    const remove = lw[0] === 'no'
    const port = lw[remove ? 2 : 1] === 'port'
    // The words without `no` and `port`: `ip access-group NAME in`.
    const words = w.filter((_, i) => !(remove && i === 0) && !(port && i === (remove ? 2 : 1)))
    const a = words.map((x) => x.toLowerCase())
    const family: Family | undefined = a[0] === 'ip' && a[1] === 'access-group' ? 'ipv4' : a[0] === 'ipv6' && a[1] === 'traffic-filter' ? 'ipv6' : undefined
    if (!family) return undefined
    if (port && a[a.length - 1] !== 'in') return unsupported('a port access list filters what comes in only')
    const directionWord = a[a.length - 1]
    const direction: Direction | undefined = directionWord === 'in' ? 'input' : directionWord === 'out' ? 'output' : undefined
    const key = `${sub.join('|')}|${family}|${direction}`
    if (!direction || (!remove && words.length !== 4) || (remove && words.length !== 3 && words.length !== 4)) return unsupported('not an access list attachment the model has')
    const previous = attachments.get(key)
    if (remove) {
      if (!previous || (words.length === 4 && words[2] !== previous.name)) return ignored('no such access list on the interface that way: nothing to convert')
      attachments.delete(key)
      set(previous.node, ignored(`removed by line ${line(node)}`))
      return ignored(`takes off the access list applied on line ${line(previous.node)}: nothing to convert`)
    }
    if (previous) set(previous.node, ignored(`superseded by line ${line(node)}`))
    attachments.set(key, { node, sub, family, direction, name: words[2] })
    return mapped([])
  }

  /** The ACLs left in the model, and each attachment's path and value (to set) or why it can't be kept. */
  const finish = (): { filters?: { ipv4?: Record<string, Filter>; ipv6?: Record<string, Filter> }; attachments: { node: NxNode; path: readonly string[]; name: string; why?: string }[]; diagnostics: Diagnostic[] } => {
    const out: Record<Family, [string, Filter][]> = { ipv4: [], ipv6: [] }
    const diagnostics: Diagnostic[] = []
    const converted = new Set<string>()
    for (const [key, state] of acls) {
      const name = key.slice(5)
      const at = ['filters', state.family, name]
      for (const r of state.remarks) set(r, ignored('a remark after the last entry: there is no entry for it to describe'))
      if (state.unconverted) {
        for (const n of state.nodes) demote(n, `left out whole: line ${line(state.unconverted)} about the same access list isn't converted`)
        for (const [, e] of state.entries) if (e.term) for (const r of e.remarks) set(r, unsupported(`left out whole: line ${line(state.unconverted)} about the same access list isn't converted`))
        continue
      }
      const entries = [...state.entries].sort(([x], [y]) => x - y)
      if (!entries.length) {
        for (const n of state.nodes) demote(n, 'an access list with no entries: NX-OS lets every packet through it, which the model can\'t say')
        continue
      }
      // The per-term rule: an entry left out whole, and the ACL with it unless that is safe (only the last can be).
      const probe: Filter = { implicitAction: 'deny', terms: keyed(entries.map(([seq, e]) => [String(seq), e.term ?? { actions: { action: 'accept' } }])) }
      const unsafe = entries.find(([seq, e]) => e.why !== undefined && !filterTermSkipSafe(probe, String(seq)))
      const kept = entries.filter(([, e]) => e.term)
      if (unsafe || !kept.length) {
        const reason = unsafe ? `left out whole: the entry on line ${line(unsafe[1].node)} isn't converted, and the entries after it would see the packets it decides` : 'left out whole: none of its entries is converted'
        for (const n of state.nodes) demote(n, reason)
        for (const [, e] of entries) if (e.term) for (const r of e.remarks) set(r, unsupported(reason))
        continue
      }
      for (const [seq, e] of kept) {
        const t = e.term!
        // The entry maps its description too: a term's statements are its entry's alone, as the remarks before it sit
        // beside the other entries in the access list.
        const fields = [fieldPath(...at, 'terms', String(seq), 'actions', 'action'), ...(t.actions.log ? [fieldPath(...at, 'terms', String(seq), 'actions', 'log')] : []), ...matchLeaves(t).map((leaf) => fieldPath(...at, 'terms', String(seq), 'matches', ...leaf)), ...(t.description !== undefined ? [fieldPath(...at, 'terms', String(seq), 'description')] : [])]
        set(e.node, mapped(fields))
        for (const r of e.remarks) set(r, ignored(t.description !== undefined ? `carried as the description of the entry on line ${line(e.node)}` : 'an empty remark: nothing to convert'))
      }
      // The first header (or numbered line) also says the ACL's implicit deny.
      // (A numbered list's first line may be a remark: then its first entry says it.)
      const head = state.headers.find((h) => dispositions[h.id]?.kind === 'mapped') ?? kept[0][1].node
      const d = dispositions[head.id]
      if (d?.kind === 'mapped') set(head, mapped([...d.fields, fieldPath(...at, 'implicitAction')]))
      const filter: Filter = { terms: keyed(kept.map(([seq, e]) => [String(seq), e.term!])), implicitAction: 'deny' }
      out[state.family].push([name, filter])
      // An IPv6 list's end isn't the same on every platform: some permit neighbor discovery before the implicit deny.
      // The model keeps the deny, so a list that relies on its end says so. A final catch-all makes it the same everywhere.
      if (state.family === 'ipv6' && filterReliesOnImplicitAction(filter)) diagnostics.push({ severity: 'warning', category: 'semantic', code: 'nxos.ipv6-acl-neighbor-discovery', message: 'An IPv6 access list relies on its implicit end, where some NX-OS platforms first permit neighbor discovery (nd-na, nd-ns): the model keeps only the deny. End it with an explicit entry to make it the same everywhere.', field: fieldPath(...at), statement: head.id })
      converted.add(key)
    }
    const filters: Obj = {}
    for (const family of ['ipv4', 'ipv6'] as const) if (out[family].length) filters[family] = keyed(out[family])
    const attached = [...attachments.values()].map((x) => ({
      node: x.node,
      path: [...x.sub, 'filters', x.family, x.direction],
      name: x.name,
      ...(converted.has(keyOf(x.family, x.name)) ? {} : { why: acls.has(keyOf(x.family, x.name)) ? 'names an access list that isn\'t converted' : 'names an access list the configuration doesn\'t define: NX-OS lets every packet through then, which the model can\'t say' })
    }))
    return { ...(Object.keys(filters).length ? { filters: filters as { ipv4?: Record<string, Filter>; ipv6?: Record<string, Filter> } } : {}), attachments: attached, diagnostics }
  }

  return { top, attach, finish }
}
