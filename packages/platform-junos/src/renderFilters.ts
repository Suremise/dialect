// The model's filters (model 0.5.1) → Junos `firewall family inet|inet6 filter`. A term is written whole or not at all
// (the per-term rule): one Junos can't say in full (a prefix list that isn't written for the filter's family, addresses
// and prefix lists of one direction together, which Junos takes as one list, a TCP flag it has no name for) is
// `unsupported`, and when core's filterTermSkipSafe() doesn't allow leaving it out, so is the whole filter, which no
// unit then applies. An ACL entry, which has no name, is written under its sequence number. A filter's end is Junos's
// implicit discard: `implicitAction` is `not-applicable`, with a semantic warning (`junos.filter-implicit-action`) when
// the source's differs (a Cisco ACL's deny, which may send an ICMP unreachable) or the filter relies on it (core's
// filterReliesOnImplicitAction()). Diagnostics never quote a name or a value.
import { fieldPath, filterReliesOnImplicitAction, filterTermSkipSafe, isPortRange, populatedLeaves, type Diagnostic, type FieldDisposition, type Filter, type Filters, type FilterTerm } from '@dialect/core'
import { TCP_FLAGS } from './filters'
import { isModelPrefix } from './prefixes'
import type { Out } from './renderPolicy'
import { quote } from './words'

type Segments = readonly string[]
type Family = 'ipv4' | 'ipv6'

export interface FilterRenderContext {
  readonly dispositions: Record<string, FieldDisposition>
  readonly diagnostics: Diagnostic[]
  /** The prefix lists policy-options writes, with the families the model has each in. */
  readonly lists: ReadonlyMap<string, ReadonlySet<Family>>
}

const leaf = (text: string, ...fields: Segments[]): Out => ({ text, children: null, fields })
const box = (text: string, children: Out[], ...fields: Segments[]): Out => ({ text, children, fields })
const list = (word: string, values: readonly string[], ...fields: Segments[]): Out => leaf(values.length === 1 ? `${word} ${values[0]}` : `${word} [ ${values.join(' ')} ]`, ...fields)
const KNOWN_MATCHES = new Set(['sourcePrefixes', 'destinationPrefixes', 'prefixes', 'sourcePrefixLists', 'destinationPrefixLists', 'prefixLists', 'protocols', 'sourcePorts', 'destinationPorts', 'ports', 'icmpTypes', 'icmpCodes', 'tcpEstablished', 'tcpFlags', 'fragment', 'dscp'])
const KNOWN_ACTIONS = new Set(['action', 'count', 'log'])
/** Junos's names for the protocols it's usual to write by name; others are written as numbers. */
const NAMED_PROTOCOLS: Readonly<Record<Family, Readonly<Record<number, string>>>> = { ipv4: { 1: 'icmp', 6: 'tcp', 17: 'udp' }, ipv6: { 6: 'tcp', 17: 'udp', 58: 'icmp6' } }
const FLAG_NAMES: Readonly<Record<string, string>> = Object.fromEntries(Object.entries(TCP_FLAGS).map(([junos, model]) => [model, junos]))
const isByte = (n: unknown, max = 255): n is number => Number.isInteger(n) && (n as number) >= 0 && (n as number) <= max

/** `firewall` for the model's filters, with every populated leaf's disposition, and the filters written, by family. */
export function firewall(filters: Filters, ctx: FilterRenderContext): { readonly out: Out | null; readonly written: ReadonlySet<string> } {
  const { dispositions, diagnostics, lists } = ctx
  const skip = (field: Segments, kind: 'unsupported' | 'not-applicable', reason: string) => {
    dispositions[fieldPath(...field)] = { kind, reason }
  }
  const skipAll = (value: unknown, at: Segments, reason: string) => {
    for (const l of populatedLeaves(value, [...at])) dispositions[l.path] = { kind: 'unsupported', reason }
  }
  const isEmpty = (value: object | undefined) => value !== undefined && populatedLeaves(value, ['x']).every((l) => l.path === 'x')
  const emptyContainer = (value: object | undefined, at: Segments) => {
    if (value !== undefined && isEmpty(value)) skip(at, 'not-applicable', 'configured empty: nothing to write')
  }

  emptyContainer(filters, ['filters'])
  const written = new Set<string>()
  const families: Out[] = []
  for (const family of ['ipv4', 'ipv6'] as const) {
    const byName = filters[family]
    if (byName === undefined) continue
    emptyContainer(byName, ['filters', family])
    const out: Out[] = []
    for (const [name, filter] of Object.entries(byName)) {
      const f = filterOf(name, filter, family, ['filters', family, name])
      if (!f) continue
      out.push(f)
      written.add(`${family}\u0000${name}`)
    }
    if (out.length) families.push(box(`family ${family === 'ipv4' ? 'inet' : 'inet6'}`, out))
  }

  function filterOf(name: string, filter: Filter, family: Family, at: Segments): Out | null {
    emptyContainer(filter.terms, [...at, 'terms'])
    if (filter.description !== undefined) skip([...at, 'description'], 'unsupported', 'Junos filters have no description')
    const terms = Object.entries(filter.terms ?? {})
    const taken = new Set(terms.flatMap(([, t]) => (typeof t?.name === 'string' ? [t.name] : [])))
    const results = terms.map(([key, term]) => {
      const t = [...at, 'terms', key]
      const r = termOf(term, family, t)
      if (typeof r === 'string') return { key, term, t, out: r }
      // An ACL entry has no name: its sequence number, unless a term of the filter has that name already.
      let label = term.name
      if (label === undefined) {
        label = key
        for (let k = 2; taken.has(label); k++) label = `${key}-${k}`
        taken.add(label)
      }
      return { key, term, t, out: { label, ...r } }
    })
    if (results.some((r) => typeof r.out === 'string' && !filterTermSkipSafe(filter, r.key))) {
      skipAll(filter, at, "a term of the filter isn't converted, and leaving it out could decide packets a later term sees, so none of it is (the per-term rule)")
      return null
    }
    const inner: Out[] = []
    for (const r of results) {
      if (typeof r.out === 'string') {
        skipAll(r.term, r.t, r.out)
        continue
      }
      inner.push(box(`term ${quote(r.out.label)}`, r.out.body, ...r.out.fields))
    }
    // Junos discards what no term decides; a source that denies (a Cisco ACL, which may also send an ICMP unreachable)
    // is said, as is a filter that relies on its end at all: by the terms written, as one left out (a last discard) can
    // leave the end deciding what it did (#103).
    let placed: ((line: number) => void) | undefined
    if (filter.implicitAction !== undefined) skip([...at, 'implicitAction'], 'not-applicable', "the source platform's semantics, not configuration: Junos discards a packet no term decides")
    const differs = filter.implicitAction !== 'discard'
    const kept: Filter = { ...filter, terms: Object.fromEntries(results.flatMap((r) => (typeof r.out === 'string' || !r.term ? [] : [[r.key, r.term]]))) }
    if (differs || filterReliesOnImplicitAction(kept)) {
      const message = differs
        ? "The source's filter ends in a deny, which may send an ICMP unreachable; Junos's discards silently what no term decides"
        : "The filter relies on its end for packets no term decides: Junos discards them silently, as the source's did"
      // On the filter's implicitAction, so a reader (and the kit) knows which filter: a path, never in the message.
      placed = (line) => diagnostics.push({ severity: 'warning', category: 'semantic', code: 'junos.filter-implicit-action', message: `${message} (line ${line}).`, span: { startLine: line, startColumn: 1, endLine: line, endColumn: 1 }, field: fieldPath(...at, 'implicitAction') })
    }
    const out = inner.length ? box(`filter ${quote(name)}`, inner) : leaf(`filter ${quote(name)}`)
    return placed ? { ...out, placed } : out
  }

  /** A term's from and then, with the fields its own line says; or why it can't be written. */
  function termOf(term: FilterTerm | undefined, family: Family, t: Segments): { body: Out[]; fields: Segments[] } | string {
    if (!term) return 'not a term'
    const m = term.matches ?? {}
    const a = term.actions ?? {}
    const mAt = [...t, 'matches']
    const aAt = [...t, 'actions']
    if (Object.keys(m).some((k) => !KNOWN_MATCHES.has(k))) return 'a condition this renderer has no word for'
    if (Object.keys(a).some((k) => !KNOWN_ACTIONS.has(k))) return 'an action this renderer has no word for'
    const fields: Segments[] = term.name !== undefined ? [[...t, 'name']] : []
    if (term.matches !== undefined && isEmpty(term.matches)) fields.push(mAt)
    const from: Out[] = []
    const then: Out[] = []
    const bits = family === 'ipv6' ? 128 : 32

    for (const [prefixes, named, word] of [['sourcePrefixes', 'sourcePrefixLists', 'source-'], ['destinationPrefixes', 'destinationPrefixLists', 'destination-'], ['prefixes', 'prefixLists', '']] as const) {
      const ps = m[prefixes]
      const ls = m[named]
      if (ps?.length && ls?.length) return "addresses and prefix lists of one direction together: Junos matches them as one list, where the model needs both to match"
      if (ps !== undefined) {
        if (ps.some((p) => !isModelPrefix(p) || p.includes(':') !== (family === 'ipv6'))) return "an address that isn't a prefix of the filter's family"
        if (ps.length) from.push(list(`${word}address`, ps.map((p) => (p.endsWith(`/${bits}`) ? p.slice(0, -`/${bits}`.length) : p)), [...mAt, prefixes]))
        else skip([...mAt, prefixes], 'not-applicable', 'none: nothing to write')
      }
      if (ls !== undefined) {
        if (ls.some((n) => !lists.get(n)?.has(family))) return "names a prefix list that isn't written for the filter's family"
        if (ls.length) ls.forEach((n, k) => from.push(leaf(`${word}prefix-list ${quote(n)}`, ...(k === 0 ? [[...mAt, named]] : []))))
        else skip([...mAt, named], 'not-applicable', 'none: nothing to write')
      }
    }
    if (m.protocols !== undefined) {
      if (m.protocols.some((p) => !isByte(p))) return 'a protocol out of range'
      const names = NAMED_PROTOCOLS[family]
      if (m.protocols.length) from.push(list(family === 'ipv4' ? 'protocol' : 'next-header', m.protocols.map((p) => names[p] ?? String(p)), [...mAt, 'protocols']))
      else skip([...mAt, 'protocols'], 'not-applicable', 'none: nothing to write')
    }
    for (const [field, word] of [['sourcePorts', 'source-port'], ['destinationPorts', 'destination-port'], ['ports', 'port']] as const) {
      const ports = m[field]
      if (ports === undefined) continue
      if (ports.some((p) => !isPortRange(p))) return 'a port that is not a port or a range of them'
      if (ports.length) from.push(list(word, [...ports], [...mAt, field]))
      else skip([...mAt, field], 'not-applicable', 'none: nothing to write')
    }
    for (const [field, word, max] of [['icmpTypes', 'icmp-type', 255], ['icmpCodes', 'icmp-code', 255], ['dscp', family === 'ipv4' ? 'dscp' : 'traffic-class', 63]] as const) {
      const vs = m[field]
      if (vs === undefined) continue
      if (vs.some((v) => !isByte(v, max))) return `a ${word} value out of range`
      if (vs.length) from.push(list(word, vs.map(String), [...mAt, field]))
      else skip([...mAt, field], 'not-applicable', 'none: nothing to write')
    }
    if (m.tcpEstablished === true) from.push(leaf('tcp-established', [...mAt, 'tcpEstablished']))
    else if (m.tcpEstablished === false) skip([...mAt, 'tcpEstablished'], 'not-applicable', 'not a condition: nothing to write')
    if (m.tcpFlags !== undefined) {
      const set = m.tcpFlags.set ?? []
      const clear = m.tcpFlags.clear ?? []
      if ([...set, ...clear].some((f) => !Object.hasOwn(FLAG_NAMES, f))) return 'a TCP flag Junos has no name for'
      if (!set.length && !clear.length) skip([...mAt, 'tcpFlags'], 'not-applicable', 'no flags: nothing to write')
      else {
        const flagFields = (['set', 'clear'] as const).filter((k) => m.tcpFlags![k] !== undefined).map((k) => [...mAt, 'tcpFlags', k])
        from.push(leaf(`tcp-flags "${[...set.map((f) => FLAG_NAMES[f]), ...clear.map((f) => `!${FLAG_NAMES[f]}`)].join(' & ')}"`, ...flagFields))
      }
    }
    if (m.fragment !== undefined) {
      if (m.fragment !== 'initial' && m.fragment !== 'non-initial') return 'a fragment match Junos has no word for'
      from.push(leaf(m.fragment === 'initial' ? 'first-fragment' : 'is-fragment', [...mAt, 'fragment']))
    }

    if (a.count !== undefined) then.push(leaf(`count ${quote(a.count)}`, [...aAt, 'count']))
    if (a.log === true) then.push(leaf('log', [...aAt, 'log']))
    else if (a.log === false) skip([...aAt, 'log'], 'not-applicable', 'no logging: nothing to write')
    const action = a.action
    if (action !== 'accept' && action !== 'discard' && action !== 'reject' && action !== 'next-term') return 'an action Junos has no word for'
    then.push(leaf(action === 'next-term' ? 'next term' : action, [...aAt, 'action']))

    const body: Out[] = []
    if (from.length) body.push(box('from', from))
    body.push(box('then', then))
    return { body, fields }
  }

  return { out: families.length ? box('firewall', families) : null, written }
}
