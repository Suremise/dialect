// The model's routing policy (model 0.5.0) → Junos `policy-options`: prefix lists, communities, AS paths and
// policy-statements. What Junos reads another way isn't written as if it were the same:
// - a **prefix list** is a set of prefixes Junos matches exactly and only permits, one list for both families: a list
//   with a deny or a length range, or a name a term uses for one family when the model has it for both, isn't written;
// - a **community** is one set of members a route must all carry, with Junos's regexes: a set with more than one
//   entry, a deny, or a regex in Cisco's dialect isn't written (a regex is never translated);
// - an **AS path** is one Junos regex;
// - a **term** is written whole or not at all (the per-term rule): one that can't be (it names something not written,
//   or Junos would read it another way: route filters and prefix lists together, nested route filters by longest match,
//   literal communities in an action) is `unsupported`, and when leaving it out isn't safe (core's termSkipSafe()), the
//   whole policy is. A policy's fall-through is `not-applicable`, with a semantic warning when the source's isn't
//   Junos's.
//
// Diagnostics never quote the model's names or values.
import { fieldPath, isAsNumber, populatedLeaves, termSkipSafe, type CommunitySet, type Diagnostic, type FieldDisposition, type Policy, type PolicyTerm, type PrefixMatch, type RoutingPolicy } from '@dialect/core'
import { isIpv4, isIpv6 } from './addresses'
import { communityToJunos, regexCommunityType } from './communities'
import { isModelPrefix, longestMatchAgrees } from './prefixes'
import { quote } from './words'

type Segments = readonly string[]

/** A statement to write, as render.ts writes them. */
export interface Out {
  readonly text: string
  readonly children: Out[] | null
  readonly fields: Segments[]
  /** Told the line the statement went to, for a diagnostic that names it. */
  readonly placed?: (line: number) => void
}

export interface PolicyRenderContext {
  readonly dispositions: Record<string, FieldDisposition>
  readonly diagnostics: Diagnostic[]
}

/** The model's protocol names, as Junos's `from protocol` says them. */
const PROTOCOLS: Readonly<Record<string, string>> = { bgp: 'bgp', ospf: 'ospf', static: 'static', connected: 'direct', local: 'local', aggregate: 'aggregate', isis: 'isis' }
const KNOWN_MATCHES = new Set(['prefixLists', 'prefixListMatch', 'routeFilters', 'communitySets', 'asPathSets', 'protocols', 'neighbors', 'tags', 'family'])
const KNOWN_ACTIONS = new Set(['flow', 'localPreference', 'med', 'communityAdd', 'communitySet', 'communityDelete', 'asPathPrepend', 'nextHop', 'nextHopSelf', 'tag'])
const FLOWS: Readonly<Record<string, string>> = { accept: 'accept', reject: 'reject', 'next-term': 'next term', 'next-policy': 'next policy' }
const isUint32 = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 0 && (n as number) <= 2 ** 32 - 1

const leaf = (text: string, ...fields: Segments[]): Out => ({ text, children: null, fields })
const box = (text: string, children: Out[], ...fields: Segments[]): Out => ({ text, children, fields })
/** A Junos leaf with one value or a `[ … ]` list of them. */
const list = (word: string, values: readonly string[], ...fields: Segments[]): Out => leaf(values.length === 1 ? `${word} ${values[0]}` : `${word} [ ${values.join(' ')} ]`, ...fields)

/** The Junos form of a prefix match: the source's where it is one Junos has (the lengths agree, as validated), else from its lengths. */
function routeFilterText(m: PrefixMatch): string {
  const length = Number(m.prefix.slice(m.prefix.lastIndexOf('/') + 1))
  const bits = m.prefix.includes(':') ? 128 : 32
  const { minLength: min, maxLength: max } = m
  const forms: Record<string, boolean> = { exact: min === length && max === length, orlonger: min === length && max === bits, longer: min === length + 1 && max === bits, upto: min === length, 'prefix-length-range': true }
  const form = m.form !== undefined && forms[m.form] ? m.form : (['exact', 'orlonger', 'longer', 'upto', 'prefix-length-range'] as const).find((f) => forms[f])!
  return form === 'upto' ? `upto /${max}` : form === 'prefix-length-range' ? `prefix-length-range /${min}-/${max}` : form
}

/** A regular expression as one Junos word, always quoted, as Junos shows them. */
const quoteRegex = (regex: string): string => `"${regex.replace(/["\\]/g, '\\$&')}"`

/** Whether a prefix match is one the model allows: a prefix with no host bits, lengths from its own to the family's. */
function validMatch(m: PrefixMatch | undefined): m is PrefixMatch {
  if (!m || typeof m.prefix !== 'string' || !isModelPrefix(m.prefix)) return false
  const length = Number(m.prefix.slice(m.prefix.lastIndexOf('/') + 1))
  const bits = m.prefix.includes(':') ? 128 : 32
  return Number.isInteger(m.minLength) && Number.isInteger(m.maxLength) && length <= m.minLength && m.minLength <= m.maxLength && m.maxLength <= bits
}

/**
 * `policy-options` for the model's routing policy, with every populated leaf's disposition, the names of the policies
 * written (BGP's references to others are by name only) and the prefix lists written, with their families (for filters).
 */
export function policyOptions(rp: RoutingPolicy, ctx: PolicyRenderContext): { readonly out: Out | null; readonly written: ReadonlySet<string>; readonly lists: ReadonlyMap<string, ReadonlySet<'ipv4' | 'ipv6'>> } {
  const { dispositions, diagnostics } = ctx
  const base = ['routingPolicy']
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
  const self = (value: object, at: Segments): Segments[] => (isEmpty(value) ? [at] : [])

  emptyContainer(rp, base)
  emptyContainer(rp.prefixLists, [...base, 'prefixLists'])
  for (const family of ['ipv4', 'ipv6'] as const) emptyContainer(rp.prefixLists?.[family], [...base, 'prefixLists', family])
  for (const kind of ['communitySets', 'asPathSets', 'policies'] as const) emptyContainer(rp[kind], [...base, kind])

  // ---- prefix lists: one Junos list per name, both families in it

  const lists: Out[] = []
  /** Each list written, with the families the model has it in. */
  const writtenLists = new Map<string, Set<'ipv4' | 'ipv6'>>()
  /** Each list's prefixes, for a term matching them `longer`. */
  const listPrefixes = new Map<string, PrefixMatch[]>()
  const names = [...new Set([...Object.keys(rp.prefixLists?.ipv4 ?? {}), ...Object.keys(rp.prefixLists?.ipv6 ?? {})])]
  for (const name of names) {
    const families = (['ipv4', 'ipv6'] as const).filter((f) => rp.prefixLists?.[f] && Object.hasOwn(rp.prefixLists[f], name))
    const entries = families.flatMap((family) => Object.entries(rp.prefixLists![family]![name]?.entries ?? {}).map(([key, e]) => ({ family, key, e })))
    const fits = entries.every(({ family, e }) => e?.action === 'permit' && validMatch(e) && e.prefix.includes(':') === (family === 'ipv6') && e.minLength === Number(e.prefix.split('/')[1]) && e.maxLength === e.minLength)
    if (!fits) {
      for (const family of families) skipAll(rp.prefixLists![family]![name], [...base, 'prefixLists', family, name], "a Junos prefix list only permits, and matches its prefixes exactly: one with a deny or a length range isn't converted yet")
      continue
    }
    const fields: Segments[] = []
    const lines = new Map<string, Segments[]>()
    for (const family of families) {
      const l = rp.prefixLists![family]![name]
      const at = [...base, 'prefixLists', family, name]
      fields.push(...self(l, at))
      if (l.description !== undefined) skip([...at, 'description'], 'unsupported', 'Junos prefix lists have no description')
      if (l.entries !== undefined && !Object.keys(l.entries).length) fields.push([...at, 'entries'])
    }
    for (const { family, key, e } of entries) {
      const at = [...base, 'prefixLists', family, name, 'entries', key]
      const own = lines.get(e.prefix) ?? []
      own.push(...(['action', 'prefix', 'minLength', 'maxLength'] as const).map((f) => [...at, f]))
      if (e.form !== undefined) own.push([...at, 'form'])
      lines.set(e.prefix, own)
    }
    const inner = [...lines].map(([prefix, f]) => leaf(prefix, ...f))
    lists.push(inner.length ? box(`prefix-list ${quote(name)}`, inner, ...fields) : leaf(`prefix-list ${quote(name)}`, ...fields))
    writtenLists.set(name, new Set(families))
    listPrefixes.set(name, entries.map(({ e }) => e))
  }

  // ---- communities

  const communities: Out[] = []
  /** Each community written: whether it has a regex (Junos adds and sets literal members only). */
  const writtenSets = new Map<string, { readonly regex: boolean }>()
  for (const [name, set] of Object.entries(rp.communitySets ?? {})) {
    const at = [...base, 'communitySets', name]
    const why = communityProblem(set)
    if (why) {
      skipAll(set, at, why)
      continue
    }
    const [key, entry] = Object.entries(set.entries!)[0]
    const e = [...at, 'entries', key]
    const members = [...(entry.members ?? []).map((m) => quote(communityToJunos(m)!)), ...(entry.regexes ?? []).map(quoteRegex)]
    const fields: Segments[] = [[...e, 'action']]
    if (entry.members !== undefined) fields.push([...e, 'members'])
    if (entry.regexes !== undefined) fields.push([...e, 'regexes'])
    if (set.regexDialect !== undefined) fields.push([...at, 'regexDialect'])
    if (set.type !== undefined) {
      if (entry.regexes?.length) fields.push([...at, 'type'])
      else skip([...at, 'type'], 'not-applicable', "Junos tells a community's kind by its members")
    }
    communities.push(list(`community ${quote(name)} members`, members, ...fields))
    writtenSets.set(name, { regex: (entry.regexes?.length ?? 0) > 0 })
  }

  /** Why a community set can't be one Junos community, or null when it can. */
  function communityProblem(set: CommunitySet): string | null {
    const entries = Object.values(set.entries ?? {})
    if (entries.length !== 1 || entries[0]?.action !== 'permit') return "a community list with more than one entry, or one that denies: a Junos community is one set of members a route must all carry"
    const e = entries[0]
    if (!e.members?.length && !e.regexes?.length) return 'a community with no members'
    if (e.members?.some((m) => communityToJunos(m) === null)) return 'a community Junos has no way to write'
    if (e.regexes?.length) {
      if (set.regexDialect !== 'junos') return "a regular expression in another dialect than Junos's: it isn't translated"
      // Junos tells the kind a regex matches by how it starts: one that says another kind than the set's would match other routes.
      if (e.regexes.some((r) => regexCommunityType(r) !== set.type)) return "a regular expression whose start doesn't say the set's kind of community, as Junos reads it"
    }
    return null
  }

  // ---- AS paths

  const asPaths: Out[] = []
  const writtenPaths = new Set<string>()
  for (const [name, set] of Object.entries(rp.asPathSets ?? {})) {
    const at = [...base, 'asPathSets', name]
    const entries = Object.entries(set.entries ?? {})
    if (entries.length !== 1 || entries[0][1]?.action !== 'permit' || typeof entries[0][1].regex !== 'string') {
      skipAll(set, at, 'an AS-path list with more than one entry, or one that denies: a Junos as-path is one regular expression (as-path groups come later)')
      continue
    }
    if (set.regexDialect !== 'junos') {
      skipAll(set, at, "a regular expression in another dialect than Junos's: it isn't translated")
      continue
    }
    const [key, entry] = entries[0]
    asPaths.push(leaf(`as-path ${quote(name)} ${quoteRegex(entry.regex)}`, [...at, 'entries', key, 'action'], [...at, 'entries', key, 'regex'], [...at, 'regexDialect']))
    writtenPaths.add(name)
  }

  // ---- policies

  const statements: Out[] = []
  const written = new Set<string>()
  for (const [name, policy] of Object.entries(rp.policies ?? {})) {
    const at = [...base, 'policies', name]
    const out = policyOf(name, policy, at)
    if (out) {
      statements.push(out)
      written.add(name)
    }
  }

  function policyOf(name: string, policy: Policy, at: Segments): Out | null {
    const terms = Object.entries(policy.terms ?? {})
    emptyContainer(policy.terms, [...at, 'terms'])
    const taken = new Set(terms.flatMap(([, t]) => (typeof t?.name === 'string' ? [t.name] : [])))
    const results = terms.map(([key, term], n) => {
      const t = [...at, 'terms', key]
      const r = termOf(term ?? {}, t)
      if (typeof r === 'string') return { key, term, t, out: r }
      // A term with no name is written as the policy's own from and then when it is last and says something, else
      // under a name of its own.
      const policyLevel = term?.name === undefined && n === terms.length - 1 && r.body.length > 0 && !r.fields.length
      let label: string | null = term?.name !== undefined ? quote(term.name) : policyLevel ? null : key
      if (term?.name === undefined && label === key) for (let k = 2; taken.has(label); k++) label = `${key}-${k}`
      if (label !== null && term?.name === undefined) taken.add(label)
      return { key, term, t, out: { label, ...r } }
    })
    // The per-term rule: a term left out must be one whose absence later terms can't see.
    if (results.some((r) => typeof r.out === 'string' && !termSkipSafe(policy, r.key))) {
      skipAll(policy, at, "a term of the policy isn't converted, and leaving it out could change what a later term sees, so none of it is (the per-term rule)")
      return null
    }
    const inner: Out[] = []
    for (const r of results) {
      if (typeof r.out === 'string') {
        skipAll(r.term, r.t, r.out)
        continue
      }
      const { label, body, fields } = r.out
      if (label === null) inner.push(...body)
      else inner.push(body.length ? box(`term ${label}`, body, ...fields) : leaf(`term ${label}`, ...fields))
    }
    // Junos's fall-through is the next policy, then the protocol's default: a source that rejects is said.
    let placed: ((line: number) => void) | undefined
    if (policy.fallThrough !== undefined) skip([...at, 'fallThrough'], 'not-applicable', "the source platform's semantics, not configuration: Junos passes a route no term decides to the next policy")
    if (policy.fallThrough === 'reject') {
      placed = (line) =>
        diagnostics.push({ severity: 'warning', category: 'semantic', code: 'junos.policy-fall-through', message: `The source rejects a route none of the policy's terms decides; Junos passes it to the next policy, then the protocol's default, so here such a route can be accepted (line ${line}).`, span: { startLine: line, startColumn: 1, endLine: line, endColumn: 1 } })
    }
    const out = inner.length ? box(`policy-statement ${quote(name)}`, inner) : leaf(`policy-statement ${quote(name)}`)
    return placed ? { ...out, placed } : out
  }

  /** A term's from and then, with the fields its own line says (its name, or the term when empty); or why it can't be. */
  function termOf(term: PolicyTerm, t: Segments): { body: Out[]; fields: Segments[] } | string {
    const fields: Segments[] = []
    if (term.name !== undefined) fields.push([...t, 'name'])
    if (isEmpty(term)) fields.push(t)
    const from: Out[] = []
    const then: Out[] = []
    const m = term.matches ?? {}
    const a = term.actions ?? {}
    const mAt = [...t, 'matches']
    const aAt = [...t, 'actions']
    if (Object.keys(m).some((k) => !KNOWN_MATCHES.has(k))) return 'a condition this renderer has no word for'
    if (Object.keys(a).some((k) => !KNOWN_ACTIONS.has(k))) return 'an action this renderer has no word for'
    if (term.matches !== undefined && isEmpty(term.matches)) fields.push(mAt)
    if (term.actions !== undefined && isEmpty(term.actions)) fields.push(aAt)

    const prefixLists = m.prefixLists
    const routeFilters = m.routeFilters
    if (prefixLists && routeFilters && Object.keys(routeFilters).length && (prefixLists.ipv4?.length || prefixLists.ipv6?.length)) return "Junos matches a term's route filters and prefix lists together, by longest match, where the model needs both to match"
    if (prefixLists && isEmpty(prefixLists)) skip([...mAt, 'prefixLists'], 'not-applicable', 'no prefix lists: nothing to write')
    if (prefixLists) {
      const byName = new Map<string, Set<string>>()
      for (const family of ['ipv4', 'ipv6'] as const) for (const n of prefixLists[family] ?? []) byName.set(n, (byName.get(n) ?? new Set()).add(family))
      for (const [n, families] of byName) {
        const has = writtenLists.get(n)
        if (!has) return "names a prefix list that isn't written"
        if (has.size !== families.size) return 'names a prefix list for one family that the model has for both: a Junos prefix list is one for both'
      }
      const how = m.prefixListMatch
      if (how !== undefined && how !== 'exact' && how !== 'orlonger' && how !== 'longer') return 'a prefix list match this renderer has no word for'
      if (how === 'longer' && !longestMatchAgrees([...byName.keys()].flatMap((n) => listPrefixes.get(n)!.map((e) => ({ prefix: e.prefix, minLength: e.minLength + 1, maxLength: e.prefix.includes(':') ? 128 : 32 }))))) return 'prefix lists matched longer whose prefixes nest: Junos holds a route against the most specific one only'
      for (const family of ['ipv4', 'ipv6'] as const) {
        if (prefixLists[family] === undefined) continue
        if (!prefixLists[family].length) skip([...mAt, 'prefixLists', family], 'not-applicable', 'no prefix lists: nothing to write')
      }
      const own = (['ipv4', 'ipv6'] as const).filter((f) => prefixLists[f]?.length).map((f) => [...mAt, 'prefixLists', f])
      const howField = how !== undefined ? [[...mAt, 'prefixListMatch']] : []
      const lines = [...byName.keys()].map((n, k) => leaf(how === undefined ? `prefix-list ${quote(n)}` : `prefix-list-filter ${quote(n)} ${how}`, ...(k === 0 ? [...own, ...howField] : [])))
      from.push(...lines)
      if (!byName.size && how !== undefined) skip([...mAt, 'prefixListMatch'], 'not-applicable', 'no prefix lists to match')
    } else if (m.prefixListMatch !== undefined) skip([...mAt, 'prefixListMatch'], 'not-applicable', 'no prefix lists to match')
    if (routeFilters) {
      const entries = Object.entries(routeFilters)
      if (entries.some(([, f]) => !validMatch(f))) return 'a route filter that is not a prefix with lengths in range'
      if (!longestMatchAgrees(entries.map(([, f]) => f))) return 'route filters whose prefixes nest with lengths the more specific one leaves out: Junos holds a route against the most specific one only'
      for (const [key, f] of entries) {
        const at = [...mAt, 'routeFilters', key]
        const own: Segments[] = [[...at, 'prefix'], [...at, 'minLength'], [...at, 'maxLength']]
        const text = routeFilterText(f)
        if (f.form !== undefined) {
          // A form Junos writes as it is; Cisco's ge and le say the same lengths in Junos's words.
          if (text.split(' ')[0] === f.form) own.push([...at, 'form'])
          else skip([...at, 'form'], 'not-applicable', 'Junos writes the same lengths its own way')
        }
        from.push(leaf(`route-filter ${f.prefix} ${text}`, ...own))
      }
    }
    for (const [field, word, ok] of [
      ['communitySets', 'community', (n: unknown) => typeof n === 'string' && writtenSets.has(n)],
      ['asPathSets', 'as-path', (n: unknown) => typeof n === 'string' && writtenPaths.has(n)]
    ] as const) {
      const sets = m[field]
      if (sets === undefined) continue
      if (sets.some((n) => !ok(n))) return `names ${field === 'communitySets' ? 'a community' : 'an AS path'} that isn't written`
      if (!sets.length) skip([...mAt, field], 'not-applicable', 'none: nothing to write')
      else from.push(list(word, sets.map(quote), [...mAt, field]))
    }
    if (m.protocols !== undefined) {
      if (m.protocols.some((p) => !Object.hasOwn(PROTOCOLS, p))) return 'a protocol Junos has no name for'
      if (m.protocols.length) from.push(list('protocol', m.protocols.map((p) => PROTOCOLS[p]), [...mAt, 'protocols']))
      else skip([...mAt, 'protocols'], 'not-applicable', 'none: nothing to write')
    }
    if (m.neighbors !== undefined) {
      if (m.neighbors.some((n) => !isIpv4(n) && !isIpv6(n))) return 'a neighbor that is not an address'
      if (m.neighbors.length) from.push(list('neighbor', m.neighbors, [...mAt, 'neighbors']))
      else skip([...mAt, 'neighbors'], 'not-applicable', 'none: nothing to write')
    }
    if (m.tags !== undefined) {
      if (m.tags.some((n) => !isUint32(n))) return 'a tag out of range'
      if (m.tags.length) from.push(list('tag', m.tags.map(String), [...mAt, 'tags']))
      else skip([...mAt, 'tags'], 'not-applicable', 'none: nothing to write')
    }
    if (m.family !== undefined) {
      if (m.family !== 'ipv4' && m.family !== 'ipv6') return 'a family Junos has no name for'
      from.push(leaf(`family ${m.family === 'ipv4' ? 'inet' : 'inet6'}`, [...mAt, 'family']))
    }

    // Actions, in the order Junos applies them: changes first, the flow last.
    const kinds = (['communityAdd', 'communitySet', 'communityDelete'] as const).filter((k) => a[k] !== undefined)
    if (kinds.length > 1) return "community actions of more than one kind in one term: Junos applies them in the order written, which the model doesn't say"
    for (const kind of kinds) {
      const v = a[kind]!
      if (v.values?.length) return 'literal communities in an action: Junos names a community, which this renderer doesn\'t make up yet'
      const sets = v.sets ?? []
      for (const n of sets) {
        const set = writtenSets.get(n)
        if (!set) return "names a community that isn't written"
        if (set.regex && kind !== 'communityDelete') return 'adds or sets a community given by a regular expression, which Junos refuses'
      }
      const at = [...aAt, kind]
      if (v.values !== undefined) skip([...at, 'values'], 'not-applicable', 'none: nothing to write')
      if (!sets.length) {
        if (v.sets !== undefined) skip([...at, 'sets'], 'not-applicable', 'none: nothing to write')
        if (isEmpty(v)) skip(at, 'not-applicable', 'none: nothing to write')
        continue
      }
      const word = kind === 'communityAdd' ? 'add' : kind === 'communitySet' ? 'set' : 'delete'
      sets.forEach((n, k) => then.push(leaf(`community ${word} ${quote(n)}`, ...(k === 0 ? [[...at, 'sets']] : []))))
    }
    if (a.localPreference !== undefined) {
      if (!isUint32(a.localPreference)) return 'a local preference out of range'
      then.push(leaf(`local-preference ${a.localPreference}`, [...aAt, 'localPreference']))
    }
    if (a.med !== undefined) {
      if (!isUint32(a.med)) return 'a MED out of range'
      then.push(leaf(`metric ${a.med}`, [...aAt, 'med']))
    }
    if (a.asPathPrepend !== undefined) {
      if (!a.asPathPrepend.length || a.asPathPrepend.some((n) => !isAsNumber(n))) return 'an AS path to prepend that is not AS numbers'
      then.push(leaf(`as-path-prepend ${quote(a.asPathPrepend.join(' '))}`, [...aAt, 'asPathPrepend']))
    }
    if (a.nextHop !== undefined && a.nextHopSelf === true) return 'both a next hop and next-hop self'
    if (a.nextHop !== undefined) {
      if (!isIpv4(a.nextHop) && !isIpv6(a.nextHop)) return 'a next hop that is not an address'
      then.push(leaf(`next-hop ${a.nextHop}`, [...aAt, 'nextHop']))
    }
    if (a.nextHopSelf === true) then.push(leaf('next-hop self', [...aAt, 'nextHopSelf']))
    else if (a.nextHopSelf === false) skip([...aAt, 'nextHopSelf'], 'not-applicable', 'no next-hop self: nothing to write')
    if (a.tag !== undefined) {
      if (!isUint32(a.tag)) return 'a tag out of range'
      then.push(leaf(`tag ${a.tag}`, [...aAt, 'tag']))
    }
    if (a.flow !== undefined) {
      if (!Object.hasOwn(FLOWS, a.flow)) return 'a flow Junos has no word for'
      then.push(leaf(FLOWS[a.flow], [...aAt, 'flow']))
    }

    const body: Out[] = []
    if (from.length) body.push(box('from', from))
    if (then.length) body.push(box('then', then))
    return { body, fields }
  }

  const children = [...lists, ...statements, ...communities, ...asPaths]
  return { out: children.length ? box('policy-options', children) : null, written, lists: writtenLists }
}
