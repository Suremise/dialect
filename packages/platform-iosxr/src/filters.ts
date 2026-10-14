// IOS-XR access lists → the model's filters (model 0.5.1, #88): one access list entry (`10 permit tcp any host
// 192.0.2.1 eq 22`) as a filter term, or why it isn't converted. An entry is converted whole or not at all, and the
// list's statements and attachments are settled in parse.ts (the per-term rule, the implicit deny). The model holds
// prefixes, never wildcard masks: a contiguous wildcard is a prefix, and an entry with a non-contiguous one isn't
// converted, never approximated. No reason repeats a word of the configuration (AGENTS.md).
import { parsePrefix, type FilterActions, type FilterMatches, type FilterTerm } from '@dialect/core'
import { isIpv4, isIpv6 } from './addresses'

type Family = 'ipv4' | 'ipv6'

/** IOS-XR's protocol names, by number, per family; `ipv4`/`ipv6` (any protocol) is none. */
export const PROTOCOLS: Readonly<Record<Family, Readonly<Record<string, number>>>> = {
  ipv4: { icmp: 1, igmp: 2, tcp: 6, udp: 17, gre: 47, esp: 50, ahp: 51, eigrp: 88, ospf: 89, pim: 103, sctp: 132 },
  ipv6: { tcp: 6, udp: 17, gre: 47, esp: 50, ahp: 51, icmpv6: 58, eigrp: 88, ospf: 89, pim: 103, sctp: 132 }
}

/** IOS-XR's port names, by number. */
export const PORTS: Readonly<Record<string, number>> = { 'ftp-data': 20, ftp: 21, ssh: 22, telnet: 23, smtp: 25, domain: 53, tftp: 69, www: 80, pop3: 110, ntp: 123, snmp: 161, bgp: 179, ldap: 389, https: 443, syslog: 514 }

/** IOS-XR's ICMP type names, as a type and, for some, a code, per family. */
export const ICMP: Readonly<Record<Family, Readonly<Record<string, readonly [number, number?]>>>> = {
  ipv4: { 'echo-reply': [0], unreachable: [3], redirect: [5], echo: [8], 'time-exceeded': [11], 'parameter-problem': [12], 'net-unreachable': [3, 0], 'host-unreachable': [3, 1], 'port-unreachable': [3, 3] },
  ipv6: { unreachable: [1], 'address-unreachable': [1, 3], 'port-unreachable': [1, 4], 'packet-too-big': [2], 'time-exceeded': [3], 'parameter-problem': [4], echo: [128], 'echo-reply': [129] }
}

/** DSCP names, by value. */
export const DSCP: Readonly<Record<string, number>> = { default: 0, cs1: 8, af11: 10, af12: 12, af13: 14, cs2: 16, af21: 18, af22: 20, af23: 22, cs3: 24, af31: 26, af32: 28, af33: 30, cs4: 32, af41: 34, af42: 36, af43: 38, cs5: 40, ef: 46, cs6: 48, cs7: 56 }

const number = (s: string | undefined, max: number): number | null => (s !== undefined && /^\d{1,10}$/.test(s) && Number(s) <= max ? Number(s) : null)

/** `A W` (address and wildcard) as a prefix, or null when the wildcard isn't contiguous or the address has host bits. */
function wildcardPrefix(address: string, wildcard: string): string | null {
  if (!isIpv4(address) || !isIpv4(wildcard)) return null
  const bits = wildcard.split('.').map((o) => Number(o).toString(2).padStart(8, '0')).join('')
  if (!/^0*1*$/.test(bits)) return null
  const length = bits.indexOf('1') === -1 ? 32 : bits.indexOf('1')
  return parsePrefix(`${address}/${length}`) ? `${address}/${length}` : null
}

/**
 * An access list entry's words after its sequence number, as a term, or why it isn't converted: `permit|deny protocol
 * source [ports] destination [ports|icmp type [code]] [options]`.
 */
export function readEntry(words: readonly string[], family: Family): FilterTerm | string {
  const w = words.map((x) => x.toLowerCase())
  let i = 0
  const action = w[i] === 'permit' ? 'accept' : w[i] === 'deny' ? 'discard' : undefined
  if (!action) return 'not a permit or deny'
  i++
  const m: { -readonly [K in keyof FilterMatches]: FilterMatches[K] } = {}
  const proto = w[i++]
  if (proto === undefined) return 'no protocol'
  const anyProtocol = family === 'ipv4' ? proto === 'ipv4' || proto === 'ip' : proto === 'ipv6'
  const protocol = anyProtocol ? undefined : Object.hasOwn(PROTOCOLS[family], proto) ? PROTOCOLS[family][proto] : number(proto, 255)
  if (!anyProtocol && protocol === null) return 'a protocol the model has no number for'
  if (protocol !== undefined && protocol !== null) m.protocols = [protocol]
  const ported = protocol === 6 || protocol === 17 || protocol === 132

  /** An address: `any`, `host A`, `A/L` or (IPv4) `A W`; null when the entry has none here, a reason when it can't be one. */
  const address = (): string | null | undefined => {
    const a = words[i]
    if (a === undefined) return 'an entry with no address'
    if (w[i] === 'any') {
      i++
      return null
    }
    if (w[i] === 'host') {
      const host = words[i + 1]
      i += 2
      if (family === 'ipv4' ? !isIpv4(host ?? '') : !isIpv6(host ?? '')) return 'not a host address of the list\'s family'
      return `${host!.toLowerCase()}/${family === 'ipv4' ? 32 : 128}`
    }
    if (a.includes('/')) {
      i++
      const p = parsePrefix(a.toLowerCase())
      return p && p.family === family ? a.toLowerCase() : 'not a prefix of the list\'s family with no host bits set'
    }
    if (family === 'ipv4' && isIpv4(a) && words[i + 1] !== undefined && isIpv4(words[i + 1])) {
      const p = wildcardPrefix(a, words[i + 1])
      i += 2
      return p ?? 'a non-contiguous wildcard, or an address with host bits: no prefix says it, and it isn\'t approximated'
    }
    return 'an address the model has no form for (an object group, or another word)'
  }
  /** Ports after an address: `eq P`, `gt P`, `lt P`, `range P Q`; null when none, a reason when they can't be. */
  const ports = (): string | null | undefined => {
    const op = w[i]
    if (op !== 'eq' && op !== 'gt' && op !== 'lt' && op !== 'range' && op !== 'neq') return null
    if (!ported) return 'ports for a protocol with none'
    const port = (s: string | undefined) => (s !== undefined && Object.hasOwn(PORTS, s) ? PORTS[s] : number(s, 65535))
    const a = port(w[i + 1])
    if (op === 'neq') return 'neq: two ranges the simple form doesn\'t write'
    if (op === 'range') {
      const b = port(w[i + 2])
      i += 3
      if (a === null || b === null || a > b) return 'not a range of ports'
      return a === b ? String(a) : `${a}-${b}`
    }
    i += 2
    if (a === null) return 'not a port'
    if (op === 'eq') return String(a)
    if (op === 'gt') return a >= 65535 ? 'no port is greater' : a + 1 === 65535 ? '65535' : `${a + 1}-65535`
    return a === 0 ? 'no port is less' : a - 1 === 0 ? '0' : `0-${a - 1}`
  }

  const source = address()
  if (typeof source === 'string' && !source.includes('/')) return source
  if (source) m.sourcePrefixes = [source]
  const sourcePorts = ports()
  if (sourcePorts !== null && sourcePorts !== undefined && !/^\d/.test(sourcePorts)) return sourcePorts
  if (sourcePorts) m.sourcePorts = [sourcePorts]
  const destination = address()
  if (typeof destination === 'string' && !destination.includes('/')) return destination
  if (destination) m.destinationPrefixes = [destination]
  const destinationPorts = ports()
  if (destinationPorts !== null && destinationPorts !== undefined && !/^\d/.test(destinationPorts)) return destinationPorts
  if (destinationPorts) m.destinationPorts = [destinationPorts]

  // An ICMP type (and code) after the destination: a number or a name of the family's.
  const icmp = family === 'ipv4' ? protocol === 1 : protocol === 58
  if (icmp && w[i] !== undefined) {
    const named = Object.hasOwn(ICMP[family], w[i]) ? ICMP[family][w[i]] : undefined
    const type = named ? named[0] : number(w[i], 255)
    if (type !== null) {
      i++
      m.icmpTypes = [type]
      const code = named ? named[1] : number(w[i], 255) ?? undefined
      if (!named && code !== undefined) i++
      if (code !== undefined) m.icmpCodes = [code]
    }
  }

  const a: { -readonly [K in keyof FilterActions]: FilterActions[K] } = { action }
  while (i < w.length) {
    const option = w[i]
    if (option === 'established' && protocol === 6 && !m.tcpEstablished) m.tcpEstablished = true
    else if (option === 'fragments' && !m.fragment) m.fragment = 'non-initial'
    else if (option === 'dscp' && !m.dscp) {
      const value = Object.hasOwn(DSCP, w[i + 1] ?? '') ? DSCP[w[i + 1]] : number(w[i + 1], 63)
      if (value === null) return 'a DSCP value the model has no number for'
      m.dscp = [value]
      i++
    } else if (option === 'log' && !a.log) a.log = true
    else if (option === 'counter' && words[i + 1] !== undefined && /^[\w.-]{1,64}$/.test(words[i + 1]) && !a.count) {
      a.count = words[i + 1]
      i++
    } else return `an option the model doesn't have (word ${i + 2} of the entry): an object group, ABF, ttl, precedence, capture or another`
    i++
  }
  return { ...(Object.keys(m).length ? { matches: m } : {}), actions: a }
}
