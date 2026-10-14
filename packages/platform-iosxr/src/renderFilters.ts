// The model's filters (model 0.5.1) → IOS-XR access lists, in the form the parse reads back (filters.ts):
// `ipv4|ipv6 access-list NAME` with an entry a term, keyed by its sequence number. Planned before the interfaces,
// which apply a list only when it is written.
//
// A filter is written term by term, each whole or not at all (the per-term rule): a term IOS-XR can't write is left
// out whole, and the whole filter with it when that isn't safe (filterTermSkipSafe()). An IOS-XR access list denies
// what no entry decides: `implicitAction` is `not-applicable`, with a semantic warning (`iosxr.filter-implicit-action`)
// when the source's differs, or when the filter relies on it (filterReliesOnImplicitAction()). Diagnostics never quote a
// name or a value.
import { fieldPath, filterReliesOnImplicitAction, filterTermSkipSafe, isPortRange, parsePrefix, type Diagnostic, type Filters, type FilterTerm } from '@dialect/core'
import { PROTOCOLS } from './filters'

type Segments = readonly (string | number)[]
type Family = 'ipv4' | 'ipv6'

/** A line to write, the fields it renders, and a warning to raise on it. */
export interface FilterLine {
  readonly text: string
  readonly fields: readonly Segments[]
  readonly warning?: Omit<Diagnostic, 'span'>
}

export interface FilterPlan {
  readonly lines: readonly FilterLine[]
  /** The filters written as access lists, by family, which interfaces may apply. */
  readonly written: Readonly<Record<Family, ReadonlySet<string>>>
}

const NAME = /^[\w.-]{1,64}$/
const isSeq = (key: string) => /^[1-9]\d{0,9}$/.test(key) && Number(key) <= 2147483646
const PROTOCOL_NAMES: Readonly<Record<Family, Readonly<Record<number, string>>>> = {
  ipv4: Object.fromEntries(Object.entries(PROTOCOLS.ipv4).map(([name, n]) => [n, name])),
  ipv6: Object.fromEntries(Object.entries(PROTOCOLS.ipv6).map(([name, n]) => [n, name]))
}

/** Plans the access lists' lines; `skip` and `skipAll` mark fields not written, as render.ts's do. */
export function planFilters(filters: Filters | undefined, skip: (field: Segments, kind: 'unsupported' | 'not-applicable', reason: string) => void, skipAll: (value: unknown, at: Segments, reason: string) => void): FilterPlan {
  const lines: FilterLine[] = []
  const written = { ipv4: new Set<string>(), ipv6: new Set<string>() }
  if (!filters) return { lines, written }
  if (!Object.keys(filters).length) skip(['filters'], 'not-applicable', 'configured empty: nothing to write')
  for (const family of ['ipv4', 'ipv6'] as const) {
    const byName = filters[family]
    if (byName !== undefined && !Object.keys(byName).length) skip(['filters', family], 'not-applicable', 'configured empty: nothing to write')
    for (const [name, filter] of Object.entries(byName ?? {})) {
      const at = ['filters', family, name]
      if (!NAME.test(name)) {
        skipAll(filter, at, 'not an access list name IOS-XR takes')
        continue
      }
      const terms = Object.entries(filter.terms ?? {})
      const planned = terms.map(([key, term]) => ({ key, term, plan: planTerm(family, key, term, [...at, 'terms', key]) }))
      const unsafe = planned.find((t) => typeof t.plan === 'string' && !filterTermSkipSafe(filter, t.key))
      if (unsafe) {
        skipAll(filter, at, `left out whole: term ${unsafe.key} can't be written (${unsafe.plan as string}), and leaving it out would change what the terms after it see`)
        continue
      }
      if (filter.description !== undefined) skip([...at, 'description'], 'unsupported', 'IOS-XR access lists have remarks, not a description')
      const out: FilterLine[] = [{ text: `${family} access-list ${name}`, fields: [] }]
      for (const t of planned) {
        if (typeof t.plan === 'string') skipAll(t.term, [...at, 'terms', t.key], t.plan)
        else out.push(t.plan)
      }
      // What happens to a packet no entry decides: IOS-XR denies it.
      const implicit = [...at, 'implicitAction']
      if (filter.implicitAction !== undefined) skip(implicit, 'not-applicable', 'the source platform\'s semantics, not configuration: an IOS-XR access list denies a packet no entry decides')
      const differs = filter.implicitAction !== 'deny'
      if (differs || filterReliesOnImplicitAction(filter)) {
        out[0] = {
          ...out[0],
          warning: {
            severity: 'warning',
            category: 'semantic',
            code: 'iosxr.filter-implicit-action',
            message: differs
              ? 'The source discards a packet no term decides, silently, where an IOS-XR access list denies it (with an ICMP unreachable, as the interface says): check the end of this access list.'
              : 'Packets no entry decides are denied by the access list\'s implicit deny, not by an entry: check the end of this access list.',
            field: fieldPath(...implicit)
          }
        }
      }
      out.push({ text: '!', fields: [] })
      lines.push(...out)
      written[family].add(name)
    }
  }
  return { lines, written }

  /** A term's entry line, or why IOS-XR can't write it whole. */
  function planTerm(family: Family, key: string, term: FilterTerm, termAt: Segments): FilterLine | string {
    if (!isSeq(key)) return 'not a sequence number IOS-XR takes (1 to 2147483646)'
    const a = term.actions
    const action = a?.action === 'accept' ? 'permit' : a?.action === 'discard' ? 'deny' : undefined
    if (!action) return a?.action === 'reject' ? 'a reject with an ICMP unreachable: an IOS-XR entry denies, and the interface says whether it sends one' : 'an entry that goes on to the next term: an IOS-XR entry permits or denies'
    const fields: Segments[] = [[...termAt, 'actions', 'action']]
    const later: [Segments, 'not-applicable', string][] = []
    if (term.name !== undefined) later.push([[...termAt, 'name'], 'not-applicable', 'IOS-XR entries have no names: their sequence numbers order them'])
    const m = term.matches ?? {}
    const mAt = [...termAt, 'matches']
    if (term.matches !== undefined && !Object.keys(term.matches).length) later.push([mAt, 'not-applicable', 'configured empty: nothing to write'])
    for (const leaf of Object.keys(m)) if (!['sourcePrefixes', 'destinationPrefixes', 'protocols', 'sourcePorts', 'destinationPorts', 'icmpTypes', 'icmpCodes', 'tcpEstablished', 'fragment', 'dscp'].includes(leaf)) return 'a match this renderer doesn\'t write (either direction, a prefix list, or TCP flags)'
    const one = <T>(list: readonly T[] | undefined, leaf: string): T | undefined | string => (list === undefined ? undefined : list.length === 1 ? list[0] : `not one ${leaf}: an IOS-XR entry has one`)

    const protocol = one(m.protocols, 'protocol')
    if (typeof protocol === 'string') return protocol
    if (protocol !== undefined && !(Number.isInteger(protocol) && protocol >= 0 && protocol <= 255)) return 'not a protocol number'
    const proto = protocol === undefined ? family : Object.hasOwn(PROTOCOL_NAMES[family], protocol) ? PROTOCOL_NAMES[family][protocol] : String(protocol)
    if (protocol !== undefined) fields.push([...mAt, 'protocols'])
    const address = (leaf: 'sourcePrefixes' | 'destinationPrefixes'): string => {
      const p = one(m[leaf], 'prefix')
      if (p === undefined) return 'any'
      fields.push([...mAt, leaf])
      const parsed = parsePrefix(p)
      return parsed && parsed.length === (family === 'ipv4' ? 32 : 128) ? `host ${p.split('/')[0]}` : p
    }
    for (const leaf of ['sourcePrefixes', 'destinationPrefixes'] as const) {
      const p = one(m[leaf], 'prefix')
      if (typeof p === 'string' && !p.includes('/')) return p
      if (p !== undefined && parsePrefix(p)?.family !== family) return 'not a prefix of the access list\'s family'
    }
    const ported = protocol === 6 || protocol === 17 || protocol === 132
    const ports = (leaf: 'sourcePorts' | 'destinationPorts'): string | null => {
      const r = one(m[leaf], 'port range')
      if (r === undefined) return ''
      if (!ported || !isPortRange(r) || (typeof r === 'string' && !/^\d/.test(r))) return null
      fields.push([...mAt, leaf])
      const [lo, hi] = r.split('-').map(Number)
      if (hi === undefined) return ` eq ${lo}`
      // `lt` and `gt` where they fit, within 0 to 65535: the whole range has neither, and is `range 0 65535`.
      return lo === 0 && hi < 65535 ? ` lt ${hi + 1}` : hi === 65535 && lo > 0 ? ` gt ${lo - 1}` : ` range ${lo} ${hi}`
    }
    const srcPorts = ports('sourcePorts')
    const dstPorts = ports('destinationPorts')
    if (srcPorts === null || dstPorts === null) return 'ports IOS-XR can\'t write here: one range each way, for TCP, UDP or SCTP'
    let text = ` ${key} ${action} ${proto} ${address('sourcePrefixes')}${srcPorts} ${address('destinationPrefixes')}${dstPorts}`
    if (m.icmpTypes !== undefined || m.icmpCodes !== undefined) {
      const icmp = family === 'ipv4' ? protocol === 1 : protocol === 58
      const type = one(m.icmpTypes, 'ICMP type')
      const code = one(m.icmpCodes, 'ICMP code')
      if (!icmp || type === undefined || typeof type === 'string' || typeof code === 'string' || ![type, code ?? 0].every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) return 'an ICMP type (and code) IOS-XR writes only for ICMP, one of each'
      text += ` ${type}${code !== undefined ? ` ${code}` : ''}`
      fields.push([...mAt, 'icmpTypes'], ...(code !== undefined ? [[...mAt, 'icmpCodes']] : []))
    }
    if (m.tcpEstablished !== undefined) {
      if (protocol !== 6) return 'established on a protocol other than TCP'
      if (m.tcpEstablished) text += ' established'
      fields.push([...mAt, 'tcpEstablished'])
    }
    if (m.dscp !== undefined) {
      const d = one(m.dscp, 'DSCP value')
      if (typeof d === 'string' || d === undefined || !(Number.isInteger(d) && d >= 0 && d <= 63)) return 'not one DSCP value from 0 to 63'
      text += ` dscp ${d}`
      fields.push([...mAt, 'dscp'])
    }
    if (m.fragment !== undefined) {
      if (m.fragment !== 'non-initial') return 'a first fragment: IOS-XR matches non-initial fragments'
      text += ' fragments'
      fields.push([...mAt, 'fragment'])
    }
    if (a.log !== undefined) {
      if (a.log) text += ' log'
      fields.push([...termAt, 'actions', 'log'])
    }
    if (a.count !== undefined) {
      if (!NAME.test(a.count)) return 'not a counter name IOS-XR takes'
      text += ` counter ${a.count}`
      fields.push([...termAt, 'actions', 'count'])
    }
    for (const [field, kind, reason] of later) skip(field, kind, reason)
    return { text, fields }
  }
}
