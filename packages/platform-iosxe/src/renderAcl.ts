// The model's `filters` (model 0.5.1) → IOS access lists: `ip access-list standard|extended NAME` and `ipv6 access-list
// NAME`, an entry a term, at its sequence number, with its description as a `remark` before it (model 0.5.3). Planned
// before the interfaces, which apply an ACL (`ip access-group`, `ipv6 traffic-filter`) only when it is written.
//
// A term is written whole or not at all (the per-term rule): one IOS can't say in one entry (several prefixes or
// protocols, a prefix list, either-way addresses or ports, an initial fragment, a counter-only term) is left out whole,
// and the whole ACL with it unless that is safe (filterTermSkipSafe(): the last, or a term that decides nothing). An
// IOS ACL ends in a deny: a source whose filters discard silently (Junos), or a filter that relies on its end, gets a
// semantic warning. A `reject` is written as `deny`, with a warning: IOS sends the ICMP unreachable by the interface's
// `ip unreachables`, on by default.
import { fieldPath, filterReliesOnImplicitAction, filterTermSkipSafe, isPortRange, parsePrefix, type Diagnostic, type Filter, type FilterTerm, type Filters } from '@dialect/core'
import { inRange, lengthMask } from './addresses'
import { matchLeaves, numberedKind } from './acl'

type Segments = readonly (string | number)[]
type Family = 'ipv4' | 'ipv6'

export interface AclLine {
  readonly text: string
  readonly fields: readonly Segments[]
  readonly warnings?: readonly Omit<Diagnostic, 'span'>[]
}

export interface AclPlan {
  readonly lines: readonly AclLine[]
  /** The ACLs written, by family, which interfaces may apply. */
  readonly written: Readonly<Record<Family, ReadonlySet<string>>>
}

/** IOS's words for the protocols it names, by number (IPv4; IPv6's `icmp` is 58). */
const PROTOCOL_NAMES: Readonly<Record<number, string>> = { 1: 'icmp', 6: 'tcp', 17: 'udp' }

/** An address as IOS writes it: `any`, `host A`, or a prefix (IPv4 with its wildcard). */
function address(family: Family, prefixes: readonly string[] | undefined): string | null {
  if (prefixes === undefined) return 'any'
  if (prefixes.length !== 1) return null
  const p = parsePrefix(prefixes[0])
  if (!p || p.family !== family) return null
  const [a] = prefixes[0].split('/')
  if (p.length === 0) return 'any'
  if (p.length === (family === 'ipv4' ? 32 : 128)) return `host ${a}`
  if (family === 'ipv6') return prefixes[0]
  const wildcard = lengthMask(p.length).split('.').map((o) => String(255 - Number(o))).join('.')
  return `${a} ${wildcard}`
}

/** Ports as one IOS operator: `eq P`, `range A B`, `gt P`, `lt P`, or `neq P` for the two ranges around one port. */
function ports(ranges: readonly string[] | undefined): string | null | undefined {
  if (ranges === undefined) return undefined
  if (!ranges.every(isPortRange)) return null
  const bounds = ranges.map((r) => r.split('-').map(Number)).map(([a, b]) => [a, b ?? a] as const)
  if (bounds.length === 1) {
    const [a, b] = bounds[0]
    // lt and gt only where they stay in range: 0-65535 is a range.
    return a === b ? `eq ${a}` : a === 0 && b < 65535 ? `lt ${b + 1}` : b === 65535 && a > 0 ? `gt ${a - 1}` : `range ${a} ${b}`
  }
  // neq P: everything but P, as 0-(P-1) and (P+1)-65535.
  if (bounds.length === 2) {
    const [[a1, b1], [a2, b2]] = [...bounds].sort((x, y) => x[0] - y[0])
    if (a1 === 0 && b2 === 65535 && a2 === b1 + 2) return `neq ${b1 + 1}`
  }
  return null
}

/** One term's entry, or why IOS can't write it in one. */
function entry(family: Family, standard: boolean, term: FilterTerm): string | { why: string } {
  const a = term.actions
  const action = a?.action === 'accept' ? 'permit' : a?.action === 'discard' || a?.action === 'reject' ? 'deny' : undefined
  if (!action) return { why: 'a term that only counts or logs: an IOS entry permits or denies' }
  const m = term.matches ?? {}
  for (const leaf of Object.keys(m)) if (!['sourcePrefixes', 'destinationPrefixes', 'protocols', 'sourcePorts', 'destinationPorts', 'icmpTypes', 'icmpCodes', 'tcpEstablished', 'tcpFlags', 'fragment', 'dscp'].includes(leaf)) return { why: leaf.endsWith('PrefixLists') || leaf === 'prefixLists' ? 'a prefix list: an IOS entry matches addresses' : 'a match an IOS entry has no words for (addresses or ports either way)' }
  const source = address(family, m.sourcePrefixes)
  const destination = address(family, m.destinationPrefixes)
  if (source === null || destination === null) return { why: 'several addresses, or one not of the family: an IOS entry has one each way' }
  if (standard) {
    if (Object.keys(m).some((leaf) => leaf !== 'sourcePrefixes')) return { why: 'a standard access list matches a source address only' }
    return `${action} ${source}${a.log ? ' log' : ''}`
  }
  if (m.protocols !== undefined && m.protocols.length !== 1) return { why: 'several protocols: an IOS entry has one' }
  const protocol = m.protocols?.[0]
  if (protocol !== undefined && inRange(String(protocol), 0, 255) === null) return { why: 'not a protocol from 0 to 255' }
  const tcp = protocol === 6
  const words = family === 'ipv6' && protocol === 58 ? 'icmp' : protocol === undefined ? (family === 'ipv4' ? 'ip' : 'ipv6') : family === 'ipv4' && PROTOCOL_NAMES[protocol] ? PROTOCOL_NAMES[protocol] : protocol === 6 ? 'tcp' : protocol === 17 ? 'udp' : String(protocol)
  const out = [action, words, source]
  const portful = protocol === 6 || protocol === 17
  const sp = ports(m.sourcePorts)
  const dp = ports(m.destinationPorts)
  if (sp === null || dp === null || ((sp !== undefined || dp !== undefined) && !portful)) return { why: 'ports IOS can\'t write in one entry, or on a protocol other than TCP or UDP' }
  if (sp) out.push(sp)
  out.push(destination)
  if (dp) out.push(dp)
  const icmp = (family === 'ipv4' && protocol === 1) || (family === 'ipv6' && protocol === 58)
  if (m.icmpTypes !== undefined || m.icmpCodes !== undefined) {
    if (!icmp || m.icmpTypes?.length !== 1 || (m.icmpCodes !== undefined && m.icmpCodes.length !== 1)) return { why: 'ICMP types or codes IOS can\'t write in one entry' }
    out.push(String(m.icmpTypes[0]), ...(m.icmpCodes ? [String(m.icmpCodes[0])] : []))
  }
  if (m.tcpEstablished !== undefined) {
    if (!tcp || m.tcpEstablished !== true) return { why: 'established is for TCP' }
    out.push('established')
  }
  if (m.tcpFlags !== undefined) {
    const flags = [...(m.tcpFlags.set ?? []).map((f) => `+${f}`), ...(m.tcpFlags.clear ?? []).map((f) => `-${f}`)]
    if (!tcp || !flags.length || flags.some((f) => !['ack', 'fin', 'psh', 'rst', 'syn', 'urg'].includes(f.slice(1)))) return { why: 'TCP flags IOS has no words for' }
    out.push('match-all', ...flags)
  }
  if (m.dscp !== undefined) {
    if (m.dscp.length !== 1) return { why: 'several DSCP values: an IOS entry has one' }
    out.push('dscp', String(m.dscp[0]))
  }
  if (m.fragment !== undefined) {
    if (m.fragment !== 'non-initial') return { why: 'an initial fragment: IOS matches later fragments only (fragments)' }
    out.push('fragments')
  }
  if (a.log) out.push('log')
  return out.join(' ')
}

/**
 * Plans the access lists' lines. `skip` marks a field unsupported or not applicable, `skipAll` every populated leaf under
 * a path; a field written is marked by the line that carries it.
 */
export function planFilters(filters: Filters | undefined, skip: (field: Segments, kind: 'unsupported' | 'not-applicable', reason: string) => void, skipAll: (value: unknown, at: Segments, reason: string) => void): AclPlan {
  const lines: AclLine[] = []
  const written: Record<Family, Set<string>> = { ipv4: new Set(), ipv6: new Set() }
  if (!filters) return { lines, written }
  const empty = (value: object | undefined, at: Segments) => {
    if (value !== undefined && !Object.keys(value).length) skip(at, 'not-applicable', 'configured empty: nothing to write')
  }
  empty(filters, ['filters'])
  for (const family of ['ipv4', 'ipv6'] as const) {
    empty(filters[family], ['filters', family])
    for (const [name, filter] of Object.entries(filters[family] ?? {})) planFilter(family, name, filter)
  }
  return { lines, written }

  function planFilter(family: Family, name: string, filter: Filter) {
    const at = ['filters', family, name]
    // A number names a standard or an extended IPv4 list by its range; any other name is written as an extended one.
    const kind = family === 'ipv4' && /^\d+$/.test(name) ? numberedKind(name) : 'extended'
    if (!/^[^\s"]+$/.test(name) || kind === null || (family === 'ipv6' && /^\d+$/.test(name))) return skipAll(filter, at, 'not an access list name IOS takes')
    const terms = Object.entries(filter.terms ?? {})
    const planned = terms.map(([key, term]) => {
      const seq = inRange(key, 1, 2147483647)
      const e = seq === null ? { why: 'not a sequence number IOS takes (1 to 2147483647)' } : entry(family, kind === 'standard', term)
      if (typeof e !== 'string' || term.description === undefined || (typeof term.description === 'string' && !/[\r\n]/.test(term.description))) return { key, term, e }
      return { key, term, e: { why: 'a description IOS can\'t write as one remark' } }
    })
    const unsafe = planned.find((p) => typeof p.e !== 'string' && !filterTermSkipSafe(filter, p.key))
    const kept = planned.filter((p) => typeof p.e === 'string')
    if (unsafe || !kept.length) {
      // No term key in a reason: a key of the config can be a secret's value reused (AGENTS.md).
      skipAll(filter, at, unsafe ? `left out whole: one of its terms can't be written (${(unsafe.e as { why: string }).why}), and leaving it out would change what the terms after it see` : 'no term IOS can write: an access list with no entries lets every packet through')
      return
    }
    const out: AclLine[] = [{ text: family === 'ipv4' ? `ip access-list ${kind} ${name}` : `ipv6 access-list ${name}`, fields: [] }]
    if (filter.description !== undefined) skip([...at, 'description'], 'unsupported', 'IOS access lists have remarks per entry, not a description')
    for (const p of planned) {
      const termAt = [...at, 'terms', p.key]
      if (typeof p.e !== 'string') {
        skipAll(p.term, termAt, p.e.why)
        continue
      }
      const t = p.term
      if (t.description !== undefined) out.push({ text: ` remark ${t.description}`, fields: [[...termAt, 'description']] })
      const fields: Segments[] = [[...termAt, 'actions', 'action'], ...matchLeaves(t).map((leaf) => [...termAt, 'matches', ...leaf])]
      if (t.actions.log !== undefined) fields.push([...termAt, 'actions', 'log'])
      if (t.name !== undefined) skip([...termAt, 'name'], 'not-applicable', 'IOS access list entries have no names: the sequence number orders them')
      if (t.actions.count !== undefined) skip([...termAt, 'actions', 'count'], 'not-applicable', 'IOS counts each entry\'s matches itself (show access-lists): the counter\'s name isn\'t kept')
      if (t.matches !== undefined && !Object.keys(t.matches).length) skip([...termAt, 'matches'], 'not-applicable', 'configured empty: nothing to write')
      const reject = t.actions.action === 'reject'
      const text = family === 'ipv4' ? ` ${p.key} ${p.e}` : ` sequence ${p.key} ${p.e}`
      out.push({ text, fields, ...(reject ? { warnings: [{ severity: 'warning', category: 'semantic', code: 'iosxe.filter-reject', message: 'A term that rejects with an ICMP unreachable is written as deny: IOS sends the unreachable by the interface\'s "ip unreachables", on by default.', field: fieldPath(...termAt, 'actions', 'action') }] } : {}) })
    }
    // The end of the list: IOS denies what no entry decides.
    const implicit = [...at, 'implicitAction']
    const relies = filterReliesOnImplicitAction(filter)
    if (filter.implicitAction !== 'deny' && filter.implicitAction !== 'discard') skip(implicit, 'unsupported', 'not an implicit action the model has')
    else {
      skip(implicit, 'not-applicable', 'an IOS access list denies what no entry decides')
      if (relies || filter.implicitAction !== 'deny')
        out[0] = {
          ...out[0],
          warnings: [{
            severity: 'warning',
            category: 'semantic',
            code: 'iosxe.filter-implicit-deny',
            message: filter.implicitAction === 'deny' ? 'The access list relies on its implicit deny for packets no entry decides, as the source does.' : 'The source drops packets no term decides silently; the IOS access list denies them, and the interface may send an ICMP unreachable ("ip unreachables").',
            field: fieldPath(...at)
          }]
        }
      // An IPv6 list's end isn't the same on every IOS platform: some permit neighbor discovery before the implicit deny.
      if (family === 'ipv6' && relies) out[0] = { ...out[0], warnings: [...(out[0].warnings ?? []), { severity: 'warning', category: 'semantic', code: 'iosxe.ipv6-acl-neighbor-discovery', message: 'An IPv6 access list relies on its implicit end, where some IOS platforms first permit neighbor discovery (nd-na, nd-ns), which the source may not: give it a final entry deciding every packet to make it the same everywhere.', field: fieldPath(...at) }] }
    }
    lines.push(...out)
    written[family].add(name)
  }
}
