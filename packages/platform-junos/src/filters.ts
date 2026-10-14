// Junos firewall filters → the model's filters (model 0.5.1): `firewall family inet|inet6 filter F` (and the older
// `firewall filter F`, which is inet), and the units that apply them (`interfaces X unit N family inet filter input F`).
// parse.ts hands each statement to `map()` or `mapAttachment()`, which record it and return a placeholder (or
// `unsupported` for what is never converted); `settle()` builds the model once every statement is read, after the
// routing policy, whose prefix lists a filter can name.
//
// A filter's terms are converted whole or not at all (the per-term rule): a term with a condition or action the model
// has no word for (a policer, `routing-instance`, `next-ip`, an `-except` match, `address … except`, a mask that isn't a
// prefix length) is `unsupported`, and when leaving it out could change what a later term sees (core's
// filterTermSkipSafe(): it isn't the last, and decides the packet), the whole filter is, and a unit applying it applies
// nothing. Junos reads some words another way than the model: a term's addresses and prefix lists of one direction are
// one list to it (where the model would need both to match), so such a term isn't converted. A term with no `then`
// accepts, as Junos does; a filter's end is Junos's implicit `discard`. Reasons never quote the configuration.
import { fieldPath, filterTermSkipSafe, type Filter, type FilterAction, type FilterTerm, type TcpFlag } from '@dialect/core'
import { parsePrefix, prefixKey } from './addresses'
import { ignored, mapped, unsupported, type Mutable } from './dispositions'
import type { Expanded } from './expand'
import type { ModelBuilder, Segments } from './model'
import { isModelPrefix } from './prefixes'
import { startsWith } from './statements'

export interface FilterContext {
  readonly statements: readonly Expanded[]
  readonly results: Mutable[]
  readonly model: ModelBuilder
  readonly claim: (key: string, index: number) => boolean
  readonly reshaped: readonly { readonly path: readonly string[]; readonly line: number }[]
  /** parse.ts's: makes sure of a unit's interface and subinterface, returning the fields that says. */
  readonly ensureUnit: (name: string, unit: string) => string[]
}

type Family = 'ipv4' | 'ipv6'

/** IP protocol numbers by Junos's names, for `protocol` (inet) and `next-header` (inet6). */
export const PROTOCOL_NUMBERS: Readonly<Record<string, number>> = {
  icmp: 1, igmp: 2, ipip: 4, tcp: 6, egp: 8, udp: 17, rsvp: 46, gre: 47, esp: 50, ah: 51, icmp6: 58, icmpv6: 58, ospf: 89, pim: 103, vrrp: 112, sctp: 132,
  'hop-by-hop': 0, routing: 43, fragment: 44, 'no-next-header': 59, dstopts: 60
}
/** Port numbers by Junos's names (`destination-port ssh`). */
export const PORT_NUMBERS: Readonly<Record<string, number>> = {
  'ftp-data': 20, ftp: 21, ssh: 22, telnet: 23, smtp: 25, tacacs: 49, domain: 53, bootps: 67, dhcp: 67, bootpc: 68, tftp: 69, finger: 79, http: 80,
  'kerberos-sec': 88, pop3: 110, sunrpc: 111, ident: 113, nntp: 119, ntp: 123, 'netbios-ns': 137, 'netbios-dgm': 138, 'netbios-ssn': 139, imap: 143,
  snmp: 161, snmptrap: 162, bgp: 179, ldap: 389, https: 443, syslog: 514, printer: 515, rip: 520, ldp: 646, socks: 1080, pptp: 1723, radius: 1812,
  radacct: 1813, nfsd: 2049
}
/** ICMP types by Junos's names, per family. */
export const ICMP_TYPES: Readonly<Record<Family, Readonly<Record<string, number>>>> = {
  ipv4: {
    'echo-reply': 0, unreachable: 3, 'source-quench': 4, redirect: 5, 'echo-request': 8, 'router-advertisement': 9, 'router-solicit': 10, 'time-exceeded': 11,
    'parameter-problem': 12, timestamp: 13, 'timestamp-reply': 14, 'info-request': 15, 'info-reply': 16, 'mask-request': 17, 'mask-reply': 18
  },
  ipv6: {
    'destination-unreachable': 1, 'packet-too-big': 2, 'time-exceeded': 3, 'parameter-problem': 4, 'echo-request': 128, 'echo-reply': 129, 'membership-query': 130,
    'membership-report': 131, 'membership-termination': 132, 'router-solicit': 133, 'router-advertisement': 134, 'neighbor-solicit': 135, 'neighbor-advertisement': 136,
    redirect: 137, 'node-information-query': 139, 'node-information-reply': 140
  }
}
/** DSCP code points by Junos's names. */
export const DSCP_VALUES: Readonly<Record<string, number>> = {
  be: 0, cs0: 0, cs1: 8, cs2: 16, cs3: 24, cs4: 32, cs5: 40, cs6: 48, cs7: 56, ef: 46,
  af11: 10, af12: 12, af13: 14, af21: 18, af22: 20, af23: 22, af31: 26, af32: 28, af33: 30, af41: 34, af42: 36, af43: 38
}
/** TCP flags by Junos's names in `tcp-flags`. */
export const TCP_FLAGS: Readonly<Record<string, TcpFlag>> = { fin: 'fin', syn: 'syn', rst: 'rst', push: 'psh', ack: 'ack', urgent: 'urg' }

const number = (s: string | undefined, max: number): number | null => (s !== undefined && /^\d+$/.test(s) && Number(s) <= max ? Number(s) : null)

type ListField = 'sourcePrefixes' | 'destinationPrefixes' | 'prefixes' | 'sourcePrefixLists' | 'destinationPrefixLists' | 'prefixLists' | 'protocols' | 'sourcePorts' | 'destinationPorts' | 'ports' | 'icmpTypes' | 'icmpCodes' | 'dscp'

/** One statement of a term, settled into it once every statement is read. */
type Part =
  | { readonly index: number; readonly kind: 'none' }
  | { readonly index: number; readonly kind: 'list'; readonly field: ListField; readonly values: readonly (string | number)[] }
  | { readonly index: number; readonly kind: 'single'; readonly side: 'matches' | 'actions'; readonly field: string; readonly value: unknown }

interface TermState {
  readonly name: string
  readonly statements: number[]
  readonly parts: Part[]
  readonly singles: Map<string, Part>
  /** Whether the term has an action the model has no word for, which may decide the packet (a policer, a routing instance…). */
  decides: boolean
  problem?: string
}

interface FilterState {
  readonly name: string
  readonly family: Family
  readonly statements: number[]
  readonly own: number[]
  readonly terms: Map<string, TermState>
  problem?: string
}

const NOT_CONVERTED_TERM = "the term has a condition or action that isn't converted, so none of it is (a term converts whole)"

/** A Junos address match (`192.0.2.1`, `10.0.0.0/8`) as a prefix of the family, or why it isn't one. */
function address(value: string, family: Family): string | { why: string } {
  if (/^[\da-f.:]+\/\d+\.\d+\.\d+\.\d+$/i.test(value)) return { why: 'an address with a mask, which the model has only as a prefix length' }
  const p = parsePrefix(value.includes('/') ? value : `${value}/${family === 'ipv6' ? 128 : 32}`)
  if (!p || p.v6 !== (family === 'ipv6')) return { why: "not an address or prefix of the filter's family" }
  const prefix = prefixKey(p)
  return isModelPrefix(prefix) ? prefix : { why: 'a prefix with host bits set' }
}

/**
 * A Junos port match (`22`, `ssh`, `ftp-data`, `1024-65535`, `ftp-data-ssh`) as the model's port or range, or null.
 * Port names have hyphens of their own, so a whole name is one port, and a range is the one split at a hyphen whose
 * two sides are each a port.
 */
export function port(value: string): string | null {
  const one = (s: string) => (Object.hasOwn(PORT_NUMBERS, s) ? PORT_NUMBERS[s] : number(s, 65535))
  const whole = one(value)
  if (whole !== null) return String(whole)
  const ranges = [...value.matchAll(/-/g)].map((m) => [one(value.slice(0, m.index)), one(value.slice(m.index + 1))]).filter(([a, b]) => a !== null && b !== null) as [number, number][]
  // Two splits that both read (a name ending where another begins) would be a guess: none is taken.
  if (ranges.length !== 1) return null
  const [first, last] = ranges[0]
  return first < last ? `${first}-${last}` : null
}

/** Numbers or a range of them (`10-20`), or a name of `names`, each from 0 to `max`: every value, or null. */
function values(value: string, max: number, names: Readonly<Record<string, number>> = {}): number[] | null {
  if (Object.hasOwn(names, value)) return [names[value]]
  const m = /^(\d+)(?:-(\d+))?$/.exec(value)
  if (!m) return null
  const first = number(m[1], max)
  const last = m[2] === undefined ? first : number(m[2], max)
  if (first === null || last === null || first > last) return null
  return Array.from({ length: last - first + 1 }, (_, k) => first + k)
}

/** `tcp-flags "syn & !ack"`: flags joined by `&`, each set or (with `!`) clear; null for anything else. */
function tcpFlags(value: string): { set: TcpFlag[]; clear: TcpFlag[] } | null {
  const set: TcpFlag[] = []
  const clear: TcpFlag[] = []
  for (const raw of value.split('&').map((s) => s.trim())) {
    const negated = raw.startsWith('!')
    const name = negated ? raw.slice(1).trim() : raw
    if (!Object.hasOwn(TCP_FLAGS, name)) return null
    const flag = TCP_FLAGS[name]
    if (set.includes(flag) || clear.includes(flag)) return null
    ;(negated ? clear : set).push(flag)
  }
  return set.length || clear.length ? { set, clear } : null
}

export function filterMapper(ctx: FilterContext) {
  const { statements, results, model, claim } = ctx
  const filters = new Map<string, FilterState>()
  const attachments: { readonly index: number; readonly name: string; readonly unit: string; readonly family: Family; readonly direction: 'input' | 'output'; readonly filter: string }[] = []
  const key = (family: Family, name: string) => `${family}\u0000${name}`

  /** `firewall …`: a filter's statement, with its family and words after the filter's name. */
  const map = (w: readonly string[], i: number): Mutable => {
    let family: Family
    let rest: readonly string[]
    if (w[1] === 'filter') {
      family = 'ipv4'
      rest = w.slice(2)
    } else if (w[1] === 'family' && (w[2] === 'inet' || w[2] === 'inet6') && w[3] === 'filter') {
      family = w[2] === 'inet' ? 'ipv4' : 'ipv6'
      rest = w.slice(4)
    } else if (w[1] === 'family') return unsupported('filters of families other than inet and inet6 come later')
    else return unsupported(w[1] === 'policer' ? 'policers come later' : 'firewall settings other than inet and inet6 filters come later')
    const [name, ...r] = rest
    if (name === undefined) return unsupported()
    const filter: FilterState = filters.get(key(family, name)) ?? { name, family, statements: [], own: [], terms: new Map() }
    filters.set(key(family, name), filter)
    filter.statements.push(i)
    if (!r.length) {
      filter.own.push(i)
      return mapped([])
    }
    // interface-specific gives each interface its own counters and policers: which packets the filter decides how is the
    // same, so the filter still converts, and only the statement says what isn't.
    if (r[0] === 'interface-specific' && r.length === 1) return unsupported('interface-specific (counters and policers per interface) comes later: the filter converts without it')
    if (r[0] !== 'term' || r[1] === undefined) {
      filter.problem ??= "a setting of the filter that isn't converted"
      return unsupported()
    }
    const termName = r[1]
    const term: TermState = filter.terms.get(termName) ?? { name: termName, statements: [], parts: [], singles: new Map(), decides: false }
    filter.terms.set(termName, term)
    term.statements.push(i)
    const t = r.slice(2)
    const bad = (reason?: string): Mutable => {
      term.problem ??= NOT_CONVERTED_TERM
      return unsupported(reason ?? (t[0] === 'then' ? 'an action the model has no word for' : 'a condition the model has no word for'))
    }
    const part = (p: Part): Mutable => {
      term.parts.push(p)
      return mapped([])
    }
    const list = (field: ListField, v: readonly (string | number)[]) => part({ index: i, kind: 'list', field, values: v })
    const single = (side: 'matches' | 'actions', field: string, value: unknown, setting = field): Mutable => {
      if (claim(`filter\u0000${family}\u0000${name}\u0000${termName}\u0000${side}.${setting}`, i)) term.singles.set(`${side}.${setting}`, { index: i, kind: 'single', side, field, value })
      return mapped([])
    }
    if (!t.length) return part({ index: i, kind: 'none' })
    if (t[0] === 'filter') {
      term.decides = true
      return bad('a term that runs another filter comes later')
    }
    const [what, ...args] = t.slice(1)
    if (what === undefined) return bad()
    const one = args.length === 1 ? args[0] : undefined

    if (t[0] === 'then') {
      if ((what === 'accept' || what === 'discard' || what === 'reject') && !args.length) return single('actions', 'action', what)
      if (what === 'next' && one === 'term') return single('actions', 'action', 'next-term')
      if (what === 'count' && one !== undefined) return single('actions', 'count', one)
      if ((what === 'log' || what === 'syslog') && !args.length) return single('actions', 'log', true)
      // What it does with the packet isn't known: it may decide it.
      term.decides = true
      if (what === 'reject') return bad('a reject with a particular ICMP message, which the model has no word for')
      return bad(what === 'policer' ? 'policers come later' : undefined)
    }
    if (t[0] !== 'from') return bad("a to condition isn't converted")

    const direction = what.startsWith('source-') ? 'source' : what.startsWith('destination-') ? 'destination' : ''
    const base = direction ? what.slice(direction.length + 1) : what
    if (base === 'address' && args.length >= 1) {
      if (args.length > 1) return bad(args[1] === 'except' ? 'an address excepted from the match (except), which the model has no word for' : undefined)
      const p = address(args[0], family)
      if (typeof p !== 'string') return bad(p.why)
      return list(direction ? (`${direction}Prefixes` as ListField) : 'prefixes', [p])
    }
    if (base === 'prefix-list' && args.length >= 1) {
      if (args.length > 1) return bad(args[1] === 'except' ? 'a prefix list excepted from the match (except), which the model has no word for' : undefined)
      return list(direction ? (`${direction}PrefixLists` as ListField) : 'prefixLists', [args[0]])
    }
    if (base === 'port' && one !== undefined) {
      const p = port(one)
      return p === null ? bad('not a port from 0 to 65535, a range of them or a port name') : list(direction ? (`${direction}Ports` as ListField) : 'ports', [p])
    }
    if (((what === 'protocol' && family === 'ipv4') || (what === 'next-header' && family === 'ipv6')) && one !== undefined) {
      const v = values(one, 255, PROTOCOL_NUMBERS)
      return v && v.length === 1 ? list('protocols', v) : bad('not a protocol from 0 to 255 or a protocol name')
    }
    if (what === 'icmp-type' && one !== undefined) {
      const v = values(one, 255, ICMP_TYPES[family])
      return v ? list('icmpTypes', v) : bad('not an ICMP type from 0 to 255, a range of them or a type name')
    }
    if (what === 'icmp-code' && one !== undefined) {
      const v = values(one, 255)
      return v ? list('icmpCodes', v) : bad('not an ICMP code from 0 to 255 or a range of them (code names come later)')
    }
    if (((what === 'dscp' && family === 'ipv4') || (what === 'traffic-class' && family === 'ipv6')) && one !== undefined) {
      const v = values(one, 63, DSCP_VALUES)
      return v ? list('dscp', v) : bad('not a DSCP value from 0 to 63 or a code point name')
    }
    if (what === 'tcp-established' && !args.length) return single('matches', 'tcpEstablished', true)
    if (what === 'tcp-initial' && !args.length) return single('matches', 'tcpFlags', { set: ['syn'], clear: ['ack'] }, 'tcp-flags')
    if (what === 'tcp-flags' && one !== undefined) {
      const flags = tcpFlags(one)
      if (!flags) return bad('a tcp-flags expression other than flags joined by & (each maybe negated with !)')
      return single('matches', 'tcpFlags', { ...(flags.set.length ? { set: flags.set } : {}), ...(flags.clear.length ? { clear: flags.clear } : {}) }, 'tcp-flags')
    }
    if ((what === 'first-fragment' || what === 'is-fragment') && !args.length) return single('matches', 'fragment', what === 'first-fragment' ? 'initial' : 'non-initial')
    return bad(what.endsWith('-except') ? 'a match on everything but some values (-except), which the model has no word for' : undefined)
  }

  /** `interfaces X unit N family inet|inet6 filter …`: an attachment, resolved once the filters are settled. */
  const mapAttachment = (name: string, unit: string, family: Family, f: readonly string[], i: number): Mutable => {
    if ((f[0] === 'input' || f[0] === 'output') && f.length === 2) {
      // A unit has one filter each way: the higher-ranked statement keeps it, else the later.
      if (claim(fieldPath('interfaces', name, 'subinterfaces', unit, 'filters', family, f[0]), i)) attachments.push({ index: i, name, unit, family, direction: f[0], filter: f[1] })
      return mapped([])
    }
    if ((f[0] === 'input-list' || f[0] === 'output-list') && f.length === 2) {
      // It replaces the single filter that way, and the single filter it: the higher-ranked, else the later, is the unit's.
      claim(fieldPath('interfaces', name, 'subinterfaces', unit, 'filters', family, f[0] === 'input-list' ? 'input' : 'output'), i)
      return unsupported('a list of filters run in turn comes later: the model applies one filter each way')
    }
    return unsupported(f[0] === 'group' ? 'filter groups (an interface group for filters that match on it) come later' : undefined)
  }

  // ---- once every statement is read

  const settleTo = (index: number, result: Mutable) => {
    if (results[index].kind === 'mapped') results[index] = result
  }
  const notConverted = (indexes: readonly number[], reason: string) => {
    for (const index of indexes) if (results[index].kind !== 'unsupported') results[index] = unsupported(reason)
  }

  /** The term in the model's form, with the fields each statement fills; or why it isn't converted. */
  function termOf(term: TermState, family: Family, lists: ReadonlyMap<string, ReadonlySet<Family>>): { term: FilterTerm; fields: Map<number, Segments[]> } | string {
    if (term.problem) return term.problem
    const matches: Record<string, unknown> = {}
    const actions: Record<string, unknown> = {}
    const fields = new Map<number, Segments[]>()
    const field = (index: number, path: Segments) => fields.set(index, [...(fields.get(index) ?? []), path])
    for (const p of term.parts) {
      if (p.kind !== 'list') continue
      if (p.field.endsWith('PrefixLists') || p.field === 'prefixLists') {
        const name = p.values[0] as string
        if (!lists.get(name)?.has(family)) return "names a prefix list the configuration doesn't define with prefixes of the filter's family, or that isn't converted"
      }
      const list = (matches[p.field] ??= []) as (string | number)[]
      const fresh = p.values.filter((v) => !list.includes(v))
      if (!fresh.length) {
        results[p.index] = ignored('already a condition of the term')
        continue
      }
      list.push(...fresh)
      field(p.index, ['matches', p.field])
    }
    // Junos takes a direction's addresses and prefix lists as one list (either matching), where the model needs both.
    for (const [prefixes, named] of [['sourcePrefixes', 'sourcePrefixLists'], ['destinationPrefixes', 'destinationPrefixLists'], ['prefixes', 'prefixLists']] as const) {
      if (matches[prefixes] && matches[named]) return "Junos matches a term's addresses and prefix lists of one direction as one list, where the model needs both to match"
    }
    for (const p of term.singles.values()) {
      if (p.kind !== 'single') continue
      ;(p.side === 'matches' ? matches : actions)[p.field] = p.value
      field(p.index, [p.side, p.field])
    }
    // A term with no action accepts, as one that only counts or logs does (Junos's default).
    if (actions.action === undefined) actions.action = 'accept'
    const actionField = term.singles.has('actions.action') ? null : ['actions', 'action']
    for (const p of term.parts) if (p.kind === 'none') field(p.index, [])
    const out: Record<string, unknown> = { name: term.name }
    if (Object.keys(matches).length) out.matches = matches
    out.actions = actions
    return { term: out as unknown as FilterTerm, fields: actionField ? new Map([...fields].map(([k, v]) => [k, [...v, actionField]])) : fields }
  }

  /** The filters converted, by family, for the attachments. */
  const converted = new Set<string>()

  function settleFilters(lists: ReadonlyMap<string, ReadonlySet<Family>>) {
    for (const [, filter] of filters) {
      const name = filter.name
      const base = ['filters', filter.family, name]
      const own = (t: TermState) => t.statements.find((index) => statements[index].from !== 'group')
      const terms = [...filter.terms.values()].sort((a, b) => (own(a) ?? a.statements[0]) - (own(b) ?? b.statements[0]))
      const groupOnly = new Set(terms.map((t) => own(t) === undefined))
      if (!filter.problem && groupOnly.size > 1) filter.problem = "terms only a configuration group gives, beside the filter's own: their order isn't converted"
      const path = filter.family === 'ipv4' ? [['firewall', 'filter', name], ['firewall', 'family', 'inet', 'filter', name]] : [['firewall', 'family', 'inet6', 'filter', name]]
      if (!filter.problem && ctx.reshaped.some((c) => path.some((p) => startsWith(c.path, p)))) filter.problem = "a command that reorders, renames or copies it (insert, rename, copy) isn't converted"
      if (filter.problem) {
        notConverted(filter.statements, `the filter isn't converted (${filter.problem}), so none of it is`)
        continue
      }
      const built = terms.map((t) => ({ state: t, result: termOf(t, filter.family, lists) }))
      // The per-term rule: a term left out must be the last, or one that decides nothing (core's filterTermSkipSafe()):
      // its known action `next term`, and nothing it says that the model has no word for. A term with no action accepts.
      const skipped = (t: TermState): FilterAction => {
        const action = t.singles.get('actions.action')
        return !t.decides && action?.kind === 'single' && action.value === 'next-term' ? 'next-term' : 'accept'
      }
      const probe: Filter = { implicitAction: 'discard', terms: Object.fromEntries(built.map((b, n) => [String(n + 1), typeof b.result === 'string' ? { actions: { action: skipped(b.state) } } : b.result.term])) }
      if (built.some((b, n) => typeof b.result === 'string' && !filterTermSkipSafe(probe, String(n + 1)))) {
        for (const b of built) if (typeof b.result === 'string') notConverted(b.state.statements, b.result)
        notConverted(filter.statements, "a term that isn't converted could decide packets a later term sees, so none of the filter is (the per-term rule)")
        continue
      }
      const implicit = model.set([...base, 'implicitAction'], 'discard')
      const kept = built.filter((b) => typeof b.result !== 'string')
      kept.forEach((b, n) => {
        const t = [...base, 'terms', String(n + 1)]
        const { term, fields } = b.result as Exclude<typeof b.result, string>
        model.set(t, term)
        for (const index of b.state.statements) settleTo(index, mapped([implicit, fieldPath(...t, 'name'), ...(fields.get(index) ?? []).filter((f) => f.length).map((f) => fieldPath(...t, ...f))]))
      })
      for (const b of built) if (typeof b.result === 'string') notConverted(b.state.statements, b.result)
      for (const index of filter.own) settleTo(index, mapped([implicit]))
      converted.add(key(filter.family, name))
    }
  }

  function settleAttachments() {
    for (const a of attachments) {
      // An input-list or output-list may have taken the direction over: the attachment is then superseded.
      if (results[a.index].kind !== 'mapped') continue
      if (!converted.has(key(a.family, a.filter))) {
        results[a.index] = unsupported("names a filter of the family the configuration doesn't define, or that isn't converted: the unit applies nothing that way")
        continue
      }
      results[a.index] = mapped([...ctx.ensureUnit(a.name, a.unit), model.set(['interfaces', a.name, 'subinterfaces', a.unit, 'filters', a.family, a.direction], a.filter)])
    }
  }

  return {
    map,
    mapAttachment,
    /** Builds the filters and their attachments, given the prefix lists the routing policy converted, with their families. */
    settle(lists: ReadonlyMap<string, ReadonlySet<Family>>) {
      settleFilters(lists)
      settleAttachments()
    }
  }
}
