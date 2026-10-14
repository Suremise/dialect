// Junos `policy-options` → the model's routing policy (model 0.5.0): prefix lists, communities, AS paths and
// policy-statements. parse.ts hands each `policy-options` statement to `map()`, which records it and returns a
// placeholder (or `unsupported` for what is never converted); `settle()` builds the model once every statement is read,
// as a list, a community or a term is converted whole or not at all:
// - a **prefix list** with an entry that isn't converted (a malformed prefix, `apply-path`) is converted not at all, so
//   a term naming it can't match fewer routes than it does on the device;
// - a **community** likewise (`invert-match`, a member in no form the model has);
// - a **term** with a condition or action that isn't converted, or naming a list, community or AS path that isn't, is
//   `unsupported` whole (the per-term rule). When leaving it out could change what a later term sees (core's
//   termSkipSafe()), the **whole policy** is `unsupported`. Junos's semantics that the model reads another way make a
//   term unsupported too: route filters and prefix lists matched together, by longest match (prefixes.ts), and community
//   actions of more than one kind, which Junos applies in order.
//
// A policy's `from` and `then` outside any term are its unnamed term, last, as Junos evaluates it. A route no term
// decides goes on to the next policy (`fallThrough: 'next-policy'`). Reasons never quote the configuration.
import { communityType, fieldPath, termSkipSafe, type Policy, type PolicyTerm, type PrefixMatch, type RouteProtocol } from '@dialect/core'
import { addressKey, isIpv4, isIpv6, parsePrefix, prefixKey } from './addresses'
import { communityFromJunos, isCommunityRegex, regexCommunityType } from './communities'
import { ignored, mapped, unsupported, type Mutable } from './dispositions'
import type { Expanded } from './expand'
import type { ModelBuilder, Segments } from './model'
import { isModelPrefix, longestMatchAgrees } from './prefixes'
import { startsWith } from './statements'

export interface PolicyContext {
  readonly statements: readonly Expanded[]
  /** Every statement's disposition, as parse.ts keeps them: settle() changes the placeholders. */
  readonly results: Mutable[]
  readonly model: ModelBuilder
  /** parse.ts's `claim`: takes a single setting for a statement, false when a higher-ranked one has it. */
  readonly claim: (key: string, index: number) => boolean
  /** Set-form commands that reorder, rename or copy (statements.ts). */
  readonly reshaped: readonly { readonly path: readonly string[]; readonly line: number }[]
}

/** Junos's protocol names, as the model has them. */
const PROTOCOLS: Readonly<Record<string, RouteProtocol>> = { bgp: 'bgp', ospf: 'ospf', static: 'static', direct: 'connected', local: 'local', aggregate: 'aggregate', isis: 'isis' }
const UINT32 = 2 ** 32 - 1
const uint32 = (s: string | undefined): number | null => (s !== undefined && /^\d+$/.test(s) && Number(s) <= UINT32 ? Number(s) : null)
const asNumber = (s: string): number | null => (uint32(s) !== null && Number(s) >= 1 ? Number(s) : null)

type ListField = 'communitySets' | 'asPathSets' | 'protocols' | 'neighbors' | 'tags'
type CommunityAction = 'communityAdd' | 'communitySet' | 'communityDelete'

/** One statement of a term: what it says, settled into the term once every statement is read. */
type Part =
  | { readonly index: number; readonly kind: 'none' }
  | { readonly index: number; readonly kind: 'list'; readonly field: ListField; readonly value: string | number }
  | { readonly index: number; readonly kind: 'prefix-list'; readonly name: string; readonly match?: 'exact' | 'orlonger' | 'longer' }
  | { readonly index: number; readonly kind: 'route-filter'; readonly match: PrefixMatch }
  | { readonly index: number; readonly kind: 'single'; readonly side: 'matches' | 'actions'; readonly field: string; readonly value: unknown }
  | { readonly index: number; readonly kind: 'community'; readonly field: CommunityAction; readonly name: string }

interface TermState {
  readonly name?: string
  readonly statements: number[]
  readonly parts: Part[]
  /** Single settings (flow, next hop…), by what they set: the statement that holds each. */
  readonly singles: Map<string, Part>
  /** Why the term isn't converted, once something in it isn't. */
  problem?: string
}

interface PolicyState {
  /** Every statement of the policy, and those of the policy alone (`policy-statement P`). */
  readonly statements: number[]
  readonly own: number[]
  /** By `term NAME`, or '' for the policy's own `from` and `then`. */
  readonly terms: Map<string, TermState>
  problem?: string
}

interface ListState {
  readonly statements: number[]
  readonly prefixes: { readonly index: number; readonly prefix: string; readonly v6: boolean; readonly length: number }[]
  problem?: string
}

interface CommunityState {
  readonly statements: number[]
  readonly members: { readonly index: number; readonly value: string; readonly regex: boolean }[]
  problem?: string
}

interface AsPathState {
  readonly statements: number[]
  /** The statement that sets its regular expression, and the regex. */
  regex?: { readonly index: number; readonly value: string }
}

const NOT_CONVERTED_TERM = "the term has a condition or action that isn't converted, so none of it is (a term converts whole)"

export function policyMapper(ctx: PolicyContext) {
  const { statements, results, model, claim } = ctx
  const prefixLists = new Map<string, ListState>()
  const communities = new Map<string, CommunityState>()
  const asPaths = new Map<string, AsPathState>()
  const policies = new Map<string, PolicyState>()
  const state = <T>(map: Map<string, T>, name: string, make: () => T): T => {
    const existing = map.get(name)
    if (existing) return existing
    const made = make()
    map.set(name, made)
    return made
  }

  // ---- prefix lists, communities, AS paths

  const mapPrefixList = (name: string, r: readonly string[], i: number): Mutable => {
    const list = state(prefixLists, name, () => ({ statements: [], prefixes: [] }))
    list.statements.push(i)
    if (!r.length) return mapped([])
    if (r.length === 1) {
      const p = parsePrefix(r[0])
      if (!p) return taint(list, 'not a prefix with its length')
      if (!isModelPrefix(prefixKey(p))) return taint(list, 'a prefix with host bits set')
      if (list.prefixes.some((e) => e.prefix === prefixKey(p))) return ignored('already in the prefix list')
      list.prefixes.push({ index: i, prefix: prefixKey(p), v6: p.v6, length: p.length })
      return mapped([])
    }
    return taint(list, r[0] === 'apply-path' ? 'a prefix list built from other configuration (apply-path) isn\'t converted' : undefined)
  }

  /** Marks a list or community not converted (whole): this statement says why, the others say so at settle(). */
  const taint = (s: { problem?: string }, reason?: string): Mutable => {
    s.problem ??= reason ?? 'a setting that isn\'t converted'
    return unsupported(reason)
  }

  const mapCommunity = (name: string, r: readonly string[], i: number): Mutable => {
    const c = state(communities, name, () => ({ statements: [], members: [] }))
    c.statements.push(i)
    if (!r.length) return mapped([])
    if (r[0] === 'members' && r.length === 2) {
      const literal = communityFromJunos(r[1])
      const value = literal ?? r[1]
      if (literal === null && !isCommunityRegex(r[1])) return taint(c, 'not a community in a form the model has, nor a regular expression')
      if (c.members.some((m) => m.value === value)) return ignored('already a member of the community')
      c.members.push({ index: i, value, regex: literal === null })
      return mapped([])
    }
    return taint(c, r[0] === 'invert-match' ? "invert-match (routes without the members) isn't converted" : undefined)
  }

  const mapAsPath = (name: string, r: readonly string[], i: number): Mutable => {
    const a = state<AsPathState>(asPaths, name, () => ({ statements: [] }))
    a.statements.push(i)
    if (r.length !== 1) return unsupported()
    if (claim(`as-path\u0000${name}`, i)) a.regex = { index: i, value: r[0] }
    return mapped([])
  }

  // ---- policy-statements

  const mapPolicy = (name: string, r: readonly string[], i: number): Mutable => {
    const policy = state(policies, name, () => ({ statements: [], own: [], terms: new Map() }))
    policy.statements.push(i)
    if (!r.length) {
      policy.own.push(i)
      return mapped([])
    }
    const named = r[0] === 'term'
    if (named && r[1] === undefined) return unsupported()
    const body = named ? r.slice(2) : r
    if (body.length && body[0] !== 'from' && body[0] !== 'then' && body[0] !== 'to') {
      policy.problem ??= "a setting of the policy that isn't converted"
      return unsupported()
    }
    const key = named ? `term ${r[1]}` : ''
    const term = state(policy.terms, key, () => ({ ...(named ? { name: r[1] } : {}), statements: [], parts: [], singles: new Map() }))
    term.statements.push(i)
    const bad = (reason?: string): Mutable => {
      term.problem ??= NOT_CONVERTED_TERM
      return unsupported(reason ?? (body[0] === 'then' ? 'an action the model has no word for' : 'a condition the model has no word for'))
    }
    const part = (p: Part): Mutable => {
      term.parts.push(p)
      return mapped([])
    }
    /** A single setting of the term: the higher-ranked statement keeps it, else the later. */
    const single = (side: 'matches' | 'actions', field: string, value: unknown, setting = field): Mutable => {
      if (claim(`policy\u0000${name}\u0000${key}\u0000${side}.${setting}`, i)) term.singles.set(`${side}.${setting}`, { index: i, kind: 'single', side, field, value })
      return mapped([])
    }
    if (!body.length) return part({ index: i, kind: 'none' })
    if (body[0] === 'to') return bad("a to condition (where the route is going) isn't converted")
    const [what, ...rest] = body.slice(1)
    if (what === undefined) return bad()

    if (body[0] === 'from') {
      const one = rest.length === 1 ? rest[0] : undefined
      if (what === 'prefix-list' && one !== undefined) return part({ index: i, kind: 'prefix-list', name: one })
      if (what === 'prefix-list-filter' && rest.length >= 2) {
        const type = rest[1]
        if (rest.length === 2 && (type === 'exact' || type === 'orlonger' || type === 'longer')) return part({ index: i, kind: 'prefix-list', name: rest[0], match: type })
        return bad('a prefix-list-filter match type the model has no word for (it has exact, orlonger and longer)')
      }
      if (what === 'route-filter') {
        const match = routeFilter(rest)
        return typeof match === 'string' ? bad(match) : part({ index: i, kind: 'route-filter', match })
      }
      if (what === 'community' && one !== undefined) return part({ index: i, kind: 'list', field: 'communitySets', value: one })
      if (what === 'as-path' && one !== undefined) return part({ index: i, kind: 'list', field: 'asPathSets', value: one })
      if (what === 'protocol' && one !== undefined) {
        if (!Object.hasOwn(PROTOCOLS, one)) return bad('a protocol the model has no name for')
        return part({ index: i, kind: 'list', field: 'protocols', value: PROTOCOLS[one] })
      }
      if (what === 'neighbor' && one !== undefined) return isIpv4(one) || isIpv6(one) ? part({ index: i, kind: 'list', field: 'neighbors', value: addressKey(one) }) : bad('not an address')
      if (what === 'tag' && one !== undefined) return uint32(one) !== null ? part({ index: i, kind: 'list', field: 'tags', value: Number(one) }) : bad('not a tag from 0 to 4294967295')
      if (what === 'family' && one !== undefined) {
        if (one === 'inet' || one === 'inet6') return single('matches', 'family', one === 'inet' ? 'ipv4' : 'ipv6')
        return bad('a family other than inet and inet6')
      }
      if (what === 'as-path-group') return bad('AS-path groups come later')
      return bad()
    }

    // then
    if ((what === 'accept' || what === 'reject') && !rest.length) return single('actions', 'flow', what)
    if (what === 'next' && (rest[0] === 'term' || rest[0] === 'policy') && rest.length === 1) return single('actions', 'flow', rest[0] === 'term' ? 'next-term' : 'next-policy')
    if (what === 'local-preference' && rest.length === 1) return uint32(rest[0]) !== null ? single('actions', 'localPreference', Number(rest[0])) : bad('a local preference other than a number from 0 to 4294967295 (add and subtract come later)')
    if (what === 'metric' && rest.length === 1) return uint32(rest[0]) !== null ? single('actions', 'med', Number(rest[0])) : bad('a metric other than a number from 0 to 4294967295')
    if (what === 'tag' && rest.length === 1) return uint32(rest[0]) !== null ? single('actions', 'tag', Number(rest[0])) : bad('not a tag from 0 to 4294967295')
    if (what === 'community' && rest.length === 2 && (rest[0] === 'add' || rest[0] === 'set' || rest[0] === 'delete')) {
      const field = rest[0] === 'add' ? 'communityAdd' : rest[0] === 'set' ? 'communitySet' : 'communityDelete'
      return part({ index: i, kind: 'community', field, name: rest[1] })
    }
    if (what === 'as-path-prepend' && rest.length === 1) {
      const path = rest[0].trim().split(/\s+/).map(asNumber)
      if (!path.length || path.some((n) => n === null)) return bad('an AS path to prepend other than AS numbers in plain form')
      return single('actions', 'asPathPrepend', path)
    }
    if (what === 'next-hop' && rest.length === 1) {
      if (rest[0] === 'self') return single('actions', 'nextHopSelf', true, 'next-hop')
      if (isIpv4(rest[0]) || isIpv6(rest[0])) return single('actions', 'nextHop', addressKey(rest[0]), 'next-hop')
      return bad('a next hop other than an address or self')
    }
    return bad()
  }

  /** A route filter's prefix match, or why it isn't converted. */
  const routeFilter = (r: readonly string[]): PrefixMatch | string => {
    const p = r[0] === undefined ? null : parsePrefix(r[0])
    if (!p) return 'not a prefix with its length'
    const prefix = prefixKey(p)
    if (!isModelPrefix(prefix)) return 'a prefix with host bits set'
    const bits = p.v6 ? 128 : 32
    const [type, arg, ...extra] = r.slice(1)
    const own = (min: number, max: number, form: PrefixMatch['form']): PrefixMatch | string => (p.length <= min && min <= max && max <= bits ? { prefix, minLength: min, maxLength: max, form } : 'lengths out of range for the prefix')
    const length = (s: string | undefined) => (s !== undefined && /^\/\d{1,3}$/.test(s) ? Number(s.slice(1)) : null)
    if (type === 'through' || type === 'address-mask') return `a route filter of type ${type}, which the model has no word for`
    if (extra.length || (arg !== undefined && type !== 'upto' && type !== 'prefix-length-range')) return 'a route filter with its own action, which comes later'
    if (type === 'exact') return own(p.length, p.length, 'exact')
    if (type === 'orlonger') return own(p.length, bits, 'orlonger')
    if (type === 'longer') return own(p.length + 1, bits, 'longer')
    if (type === 'upto' && length(arg) !== null) return own(p.length, length(arg)!, 'upto')
    const m = type === 'prefix-length-range' && arg !== undefined ? /^\/(\d{1,3})-\/(\d{1,3})$/.exec(arg) : null
    if (m) return own(Number(m[1]), Number(m[2]), 'prefix-length-range')
    return 'a route filter match type the model has no word for'
  }

  const map = (w: readonly string[], i: number): Mutable => {
    const [, kind, name, ...r] = w
    if (name === undefined) return unsupported()
    if (kind === 'prefix-list') return mapPrefixList(name, r, i)
    if (kind === 'community') return mapCommunity(name, r, i)
    if (kind === 'as-path') return mapAsPath(name, r, i)
    if (kind === 'policy-statement') return mapPolicy(name, r, i)
    if (kind === 'as-path-group') return unsupported('AS-path groups come later')
    return unsupported()
  }

  // ---- once every statement is read

  const settleTo = (index: number, result: Mutable) => {
    if (results[index].kind === 'mapped') results[index] = result
  }
  /** Every statement of something not converted whole: the ones that say why keep their reason. */
  const notConverted = (indexes: readonly number[], reason: string) => {
    for (const index of indexes) if (results[index].kind !== 'unsupported') results[index] = unsupported(reason)
  }
  const reshaped = (kind: string, name: string) => ctx.reshaped.some((c) => startsWith(c.path, ['policy-options', kind, name]))
  const RESHAPED = "a command that reorders, renames or copies it (insert, rename, copy) isn't converted"
  const at = (...s: Segments) => ['routingPolicy', ...s]

  /** The names converted, by kind, for references: each prefix list with its families. */
  const lists = new Map<string, Set<'ipv4' | 'ipv6'>>()
  const sets = new Map<string, { readonly regex: boolean }>()
  const paths = new Set<string>()
  const converted = new Set<string>()

  function settleLists() {
    for (const [name, list] of prefixLists) {
      if (!list.problem && reshaped('prefix-list', name)) list.problem = RESHAPED
      if (list.problem) {
        notConverted(list.statements, `the prefix list isn't converted (${list.problem}), so none of it is: a term naming it would match other routes`)
        continue
      }
      const families = new Set<'ipv4' | 'ipv6'>()
      const fields = new Map<number, string[]>()
      const count = { ipv4: 0, ipv6: 0 }
      for (const e of list.prefixes) {
        const family = e.v6 ? 'ipv6' : 'ipv4'
        families.add(family)
        const entry = at('prefixLists', family, name, 'entries', String(++count[family]))
        fields.set(e.index, [model.set([...entry, 'action'], 'permit'), model.set([...entry, 'prefix'], e.prefix), model.set([...entry, 'minLength'], e.length), model.set([...entry, 'maxLength'], e.length)])
      }
      // A list with no prefixes says no family: it is an IPv4 one, as good as any (it matches nothing).
      const empty = families.size ? null : model.ensure(at('prefixLists', 'ipv4', name, 'entries'))
      if (empty !== null) families.add('ipv4')
      for (const index of list.statements) settleTo(index, mapped(fields.get(index) ?? [empty]))
      lists.set(name, families)
    }
  }

  function settleCommunities() {
    for (const [name, c] of communities) {
      if (!c.problem && reshaped('community', name)) c.problem = RESHAPED
      if (!c.problem && !c.members.length) c.problem = 'a community with no members'
      // With a regex, the set says which kind of community it matches, which every member must be.
      const regexes = c.members.filter((m) => m.regex)
      const types = new Set(regexes.map((m) => regexCommunityType(m.value)))
      const type = regexes.length && types.size === 1 ? [...types][0] : null
      if (!c.problem && regexes.length && type === null) c.problem = 'a regular expression whose kind of community (standard, extended, large) its start doesn\'t say, or members of more than one kind'
      if (!c.problem && type !== null && c.members.some((m) => !m.regex && communityType(m.value) !== type)) c.problem = 'members of more than one kind of community beside a regular expression'
      if (c.problem) {
        notConverted(c.statements, `the community isn't converted (${c.problem}), so none of it is`)
        continue
      }
      const s = at('communitySets', name)
      const entry = [...s, 'entries', '1']
      const action = model.set([...entry, 'action'], 'permit')
      const members = c.members.filter((m) => !m.regex).map((m) => m.value)
      const membersField = members.length ? model.set([...entry, 'members'], members) : null
      const regexField = regexes.length ? model.set([...entry, 'regexes'], regexes.map((m) => m.value)) : null
      const typeFields = type !== null ? [model.set([...s, 'type'], type), model.set([...s, 'regexDialect'], 'junos')] : []
      for (const index of c.statements) {
        const m = c.members.find((x) => x.index === index)
        settleTo(index, mapped(m ? [action, m.regex ? regexField : membersField, ...(m.regex ? typeFields : [])] : [action]))
      }
      sets.set(name, { regex: regexes.length > 0 })
    }
  }

  function settleAsPaths() {
    for (const [name, a] of asPaths) {
      if (!a.regex || reshaped('as-path', name)) {
        notConverted(a.statements, a.regex ? RESHAPED : 'an AS path with no regular expression')
        continue
      }
      const entry = at('asPathSets', name, 'entries', '1')
      const fields = [model.set([...entry, 'action'], 'permit'), model.set([...entry, 'regex'], a.regex.value), model.set(at('asPathSets', name, 'regexDialect'), 'junos')]
      for (const index of a.statements) settleTo(index, index === a.regex.index ? mapped(fields) : mapped([]))
      paths.add(name)
    }
  }

  /** The term in the model's form, with the fields each statement fills; or why it isn't converted. */
  function termOf(term: TermState, base: Segments): { term: PolicyTerm; fields: Map<number, Segments[]> } | string {
    if (term.problem) return term.problem
    const matches: Record<string, unknown> = {}
    const actions: Record<string, unknown> = {}
    const fields = new Map<number, Segments[]>()
    const field = (index: number, path: Segments) => fields.set(index, [...(fields.get(index) ?? []), path])
    const m = [...base, 'matches']
    const a = [...base, 'actions']

    // Prefix lists, by family, and how their prefixes match: one way for every list of the term.
    const named = term.parts.filter((p) => p.kind === 'prefix-list')
    const filters = term.parts.filter((p) => p.kind === 'route-filter')
    if (named.length) {
      if (filters.length) return 'Junos matches a term\'s route filters and prefix lists together, by longest match, where the model needs both to match'
      const how = new Set(named.map((p) => p.match ?? 'exact'))
      if (how.size > 1) return 'prefix lists matched in more than one way in one term (the model has one way per term)'
      const byFamily: Record<'ipv4' | 'ipv6', string[]> = { ipv4: [], ipv6: [] }
      for (const p of named) {
        const families = lists.get(p.name)
        if (!families) return "names a prefix list the configuration doesn't define, or that isn't converted"
        for (const family of families) {
          if (!byFamily[family].includes(p.name)) byFamily[family].push(p.name)
          field(p.index, [...m, 'prefixLists', family])
        }
      }
      const explicit = named.find((p) => p.match !== undefined)
      if (explicit?.match === 'longer') {
        const entries = named.flatMap((p) => prefixLists.get(p.name)!.prefixes.map((e) => ({ prefix: e.prefix, minLength: e.length + 1, maxLength: e.v6 ? 128 : 32 })))
        if (!longestMatchAgrees(entries)) return 'prefix lists matched longer whose prefixes nest: Junos holds a route against the most specific one only'
      }
      matches.prefixLists = Object.fromEntries((['ipv4', 'ipv6'] as const).filter((f) => byFamily[f].length).map((f) => [f, byFamily[f]]))
      if (explicit) {
        matches.prefixListMatch = explicit.match
        for (const p of named) if (p.match !== undefined) field(p.index, [...m, 'prefixListMatch'])
      }
    }
    if (filters.length) {
      const all = filters.map((p) => p.match)
      if (!longestMatchAgrees(all)) return 'route filters whose prefixes nest with lengths the more specific one leaves out: Junos holds a route against the most specific one only'
      const seen = new Map<string, number>()
      const kept: Record<string, PrefixMatch> = {}
      for (const p of filters) {
        const key = JSON.stringify(p.match)
        if (seen.has(key)) {
          results[p.index] = ignored('already a route filter of the term')
          continue
        }
        const position = String(seen.size + 1)
        seen.set(key, p.index)
        kept[position] = p.match
        for (const leaf of ['prefix', 'minLength', 'maxLength', 'form']) field(p.index, [...m, 'routeFilters', position, leaf])
      }
      matches.routeFilters = kept
    }

    // Lists of names and values: each once, references to what is converted.
    for (const p of term.parts) {
      if (p.kind !== 'list') continue
      if (p.field === 'communitySets' && !sets.has(p.value as string)) return "names a community the configuration doesn't define, or that isn't converted"
      if (p.field === 'asPathSets' && !paths.has(p.value as string)) return "names an AS path the configuration doesn't define, or that isn't converted"
      const list = (matches[p.field] ??= []) as unknown[]
      if (list.includes(p.value)) {
        results[p.index] = ignored('already a condition of the term')
        continue
      }
      list.push(p.value)
      field(p.index, [...m, p.field])
    }

    // Community actions: by community, of one kind (Junos applies them in order, which the model doesn't keep).
    const community = term.parts.filter((p) => p.kind === 'community')
    if (new Set(community.map((p) => p.field)).size > 1) return 'community actions of more than one kind in one term: Junos applies them in order, which the model doesn\'t keep'
    for (const p of community) {
      const set = sets.get(p.name)
      if (!set) return "names a community the configuration doesn't define, or that isn't converted"
      if (set.regex && p.field !== 'communityDelete') return 'adds or sets a community given by a regular expression, which Junos refuses'
      const action = (actions[p.field] ??= { sets: [] }) as { sets: string[] }
      if (action.sets.includes(p.name)) {
        results[p.index] = ignored('already in the action')
        continue
      }
      action.sets.push(p.name)
      field(p.index, [...a, p.field, 'sets'])
    }

    for (const p of term.singles.values()) {
      if (p.kind !== 'single') continue
      ;(p.side === 'matches' ? matches : actions)[p.field] = p.value
      field(p.index, [...(p.side === 'matches' ? m : a), p.field])
    }
    for (const p of term.parts) if (p.kind === 'none') field(p.index, [])
    const out: Record<string, unknown> = {}
    if (term.name !== undefined) out.name = term.name
    if (Object.keys(matches).length) out.matches = matches
    if (Object.keys(actions).length) out.actions = actions
    return { term: out as PolicyTerm, fields }
  }

  function settlePolicies() {
    for (const [name, policy] of policies) {
      const base = at('policies', name)
      // Terms in order, the policy's own from and then last. Inherited statements come first (expand.ts), so a term the
      // configuration has is placed by its own first statement, a group adding to it or not. A term only a group gives,
      // beside terms the configuration gives, or a command that reorders them, leaves their order to rules this
      // converter doesn't follow.
      const own = (t: TermState) => t.statements.find((index) => statements[index].from !== 'group')
      const named = [...policy.terms.entries()].filter(([key]) => key !== '')
      const terms = [...named.sort(([, a], [, b]) => (own(a) ?? a.statements[0]) - (own(b) ?? b.statements[0])), ...[...policy.terms.entries()].filter(([key]) => key === '')]
      const groupOnly = new Set(named.map(([, t]) => own(t) === undefined))
      if (!policy.problem && groupOnly.size > 1) policy.problem = "terms only a configuration group gives, beside the policy's own: their order isn't converted"
      if (!policy.problem && reshaped('policy-statement', name)) policy.problem = RESHAPED
      if (policy.problem) {
        notConverted(policy.statements, `the policy isn't converted (${policy.problem}), so none of it is`)
        continue
      }

      const built = terms.map(([, t]) => ({ state: t, result: termOf(t, []) }))
      // The per-term rule: a term left out is safe only when later terms see the same routes the same way without it
      // (core's termSkipSafe()). A term that isn't converted counts as deciding, unless what it says is known.
      let whole: string | undefined
      for (let k = 0; k < built.length && !whole; k++) {
        if (typeof built[k].result !== 'string') continue
        const later = built.slice(k + 1).flatMap((b) => (typeof b.result === 'string' ? [] : [b.result.term]))
        const skipped = knownActions(built[k].state)
        const probe: Policy = { fallThrough: 'next-policy', terms: Object.fromEntries([skipped, ...later].map((t, n) => [String(n + 1), t])) }
        if (!termSkipSafe(probe, '1')) whole = 'a term that isn\'t converted could change what a later term sees, so none of the policy is (the per-term rule)'
      }
      if (whole) {
        for (const b of built) if (typeof b.result === 'string') notConverted(b.state.statements, b.result)
        notConverted(policy.statements, whole)
        continue
      }

      const fallThrough = model.set([...base, 'fallThrough'], 'next-policy')
      const kept = built.filter((b) => typeof b.result !== 'string')
      kept.forEach((b, n) => {
        const t = [...base, 'terms', String(n + 1)]
        const { term, fields } = b.result as Exclude<typeof b.result, string>
        model.set(t, term)
        const nameField = term.name !== undefined ? fieldPath(...t, 'name') : null
        const empty = !Object.keys(term).length ? fieldPath(...t) : null
        for (const index of b.state.statements) settleTo(index, mapped([fallThrough, nameField, empty, ...(fields.get(index) ?? []).filter((f) => f.length).map((f) => fieldPath(...t, ...f))]))
      })
      for (const b of built) if (typeof b.result === 'string') notConverted(b.state.statements, b.result)
      for (const index of policy.own) settleTo(index, mapped([fallThrough]))
      converted.add(name)
    }
  }

  /**
   * What a term that isn't converted is known to do, for termSkipSafe(): its single actions and community actions as
   * the model would have them; one it says that the model has no word for counts as a change a later term may see.
   */
  function knownActions(term: TermState): PolicyTerm {
    const actions: Record<string, unknown> = {}
    for (const p of term.singles.values()) if (p.kind === 'single' && p.side === 'actions') actions[p.field] = p.value
    for (const p of term.parts) if (p.kind === 'community') actions[p.field] = { sets: [p.name] }
    const unknown = term.statements.some((index) => {
      const w = statements[index].words
      return w[w[3] === 'term' ? 5 : 3] === 'then' && results[index].kind === 'unsupported'
    })
    if (unknown) actions.unknown = true
    return { actions } as PolicyTerm
  }

  return {
    map,
    /**
     * Builds the routing policy: the policies converted, by name, for the references BGP makes, and the prefix lists
     * with their families, for the filters' references.
     */
    settle(): { readonly policies: ReadonlySet<string>; readonly lists: ReadonlyMap<string, ReadonlySet<'ipv4' | 'ipv6'>> } {
      settleLists()
      settleCommunities()
      settleAsPaths()
      settlePolicies()
      model.removeIfEmpty(['routingPolicy', 'prefixLists'])
      model.removeIfEmpty(['routingPolicy'])
      return { policies: converted, lists }
    }
  }
}
