// IOS routing policy → the model's `routingPolicy` (model 0.5.0): `ip prefix-list` and `ipv6 prefix-list`, `ip
// community-list standard|expanded` (and numbered lists), `ip as-path access-list` and `route-map`. Read statement by
// statement, as the device applies them (a later `set` replaces an earlier one, `no` forms remove), then put in the
// model once the whole text is read, since a route map can name a list defined after it.
//
// Lists are converted whole or not at all: a list with any statement that isn't converted (an option the model can't
// hold, a `no` form whose effect isn't certain) is left out whole, as a list missing an entry would match other
// routes. A route map is converted sequence by sequence, each whole or not at all (the per-term rule): a sequence with
// a statement that isn't converted, or naming a list that isn't, is left out whole, and the whole route map with it
// when leaving it out isn't safe (termSkipSafe(): a route map's sequences all permit or deny, so only the last can be).
// Regexes are kept as written, in the `cisco` dialect.
import { fieldPath, parsePrefix, termSkipSafe, type AsPathSet, type CommunitySet, type CommunitySetEntry, type Policy, type PolicyActions, type PolicyTerm, type PrefixList, type PrefixListEntry, type RoutingPolicy, type StatementDisposition } from '@dialect/core'
import { asNumber, inRange, ipv6Prefix, isIpv4, isIpv6 } from './addresses'
import type { IosNode } from './tree'

type Obj = { [key: string]: unknown }
type Action = 'permit' | 'deny'
type Family = 'ipv4' | 'ipv6'

/** Sets an own property, so a name like `__proto__` is a key like any other. */
const putOwn = (o: Obj, key: string, value: unknown) => Object.defineProperty(o, key, { value, enumerable: true, writable: true, configurable: true })
/** A keyed map of the model, built with own properties only. */
function keyed<T>(entries: Iterable<readonly [string, T]>): Record<string, T> {
  const o: Obj = {}
  for (const [k, v] of entries) putOwn(o, k, v)
  return o as Record<string, T>
}

const mapped = (fields: string[]): StatementDisposition => ({ kind: 'mapped', fields })
const unsupported = (reason: string): StatementDisposition => ({ kind: 'unsupported', reason })
const ignored = (reason: string): StatementDisposition => ({ kind: 'ignored-by-design', reason })
const line = (node: IosNode) => node.span.startLine
const linesText = (nodes: readonly IosNode[]) => {
  const lines = [...new Set(nodes.filter((n) => n.kind !== 'comment').map(line))].sort((a, b) => a - b)
  return `line${lines.length > 1 ? 's' : ''} ${lines.join(', ')}`
}
const isAction = (s: string | undefined): s is Action => s === 'permit' || s === 'deny'
/** Everything inside a statement, it included. */
const all = (n: IosNode): IosNode[] => [n, ...n.children.flatMap(all)]

/** IOS's names for the well-known communities it has, by the model's. */
export const IOS_COMMUNITY_NAMES: Readonly<Record<string, string>> = { 'no-export': 'no-export', 'no-advertise': 'no-advertise', 'no-export-subconfed': 'local-AS', 'graceful-shutdown': 'gshut' }
const MODEL_COMMUNITY_NAMES: Readonly<Record<string, string>> = Object.fromEntries(Object.entries(IOS_COMMUNITY_NAMES).map(([model, ios]) => [ios.toLowerCase(), model]))

/**
 * A community as IOS writes it (`65000:100`, a 32-bit number, `no-export`, `local-AS`, `gshut`) in the model's form, or
 * null for one the model has no form for (`internet`, which matches every route).
 */
export function community(word: string): string | null {
  const lw = word.toLowerCase()
  if (Object.hasOwn(MODEL_COMMUNITY_NAMES, lw)) return MODEL_COMMUNITY_NAMES[lw]
  const m = /^(\d+):(\d+)$/.exec(word)
  if (m) return Number(m[1]) <= 65535 && Number(m[2]) <= 65535 ? `${Number(m[1])}:${Number(m[2])}` : null
  const n = inRange(word, 0, 4294967295)
  return n === null ? null : `${Math.floor(n / 65536)}:${n % 65536}`
}

type Match = Omit<PrefixListEntry, 'action'>

/** A prefix list entry's match as IOS writes it (`10.0.0.0/8 ge 16 le 24`, after the action), or why it isn't one. */
function prefixMatch(family: Family, words: readonly string[]): Match | string {
  const [text, ...rest] = words
  let prefix: string | undefined
  if (family === 'ipv4') {
    const m = /^([\d.]+)\/(\d{1,2})$/.exec(text ?? '')
    if (m && isIpv4(m[1])) prefix = `${m[1]}/${Number(m[2])}`
  } else {
    const p = ipv6Prefix(text ?? '')
    if (p) prefix = `${p.address}/${p.length}`
  }
  const parsed = prefix === undefined ? null : parsePrefix(prefix)
  if (prefix === undefined || !parsed || parsed.family !== family) return `not an ${family === 'ipv4' ? 'IPv4' : 'IPv6'} prefix with no host bits set`
  const length = parsed.length
  const bits = family === 'ipv4' ? 32 : 128
  const lw = rest.map((x) => x.toLowerCase())
  // IOS's rule: the prefix's length < ge ≤ le ≤ the family's longest.
  const ge = lw[0] === 'ge' ? inRange(lw[1], length + 1, bits) : undefined
  const leAt = lw[0] === 'ge' ? 2 : 0
  const le = lw[leAt] === 'le' ? inRange(lw[leAt + 1], Math.max(length + 1, ge ?? 0), bits) : undefined
  const used = (ge !== undefined ? 2 : 0) + (le !== undefined ? 2 : 0)
  if (ge === null || le === null || used !== rest.length) return 'not a prefix length range IOS takes (the prefix\'s length < ge ≤ le ≤ the longest)'
  if (ge !== undefined && le !== undefined) return { prefix, minLength: ge, maxLength: le, form: 'ge-le' }
  if (ge !== undefined) return { prefix, minLength: ge, maxLength: bits, form: 'ge' }
  if (le !== undefined) return { prefix, minLength: length, maxLength: le, form: 'le' }
  return { prefix, minLength: length, maxLength: length, form: 'exact' }
}

const sameMatch = (a: Match, b: Match) => a.prefix === b.prefix && a.minLength === b.minLength && a.maxLength === b.maxLength

/** What every list and route map keeps: its statements, and the first that isn't converted, which leaves it out whole. */
interface Tracked {
  readonly nodes: IosNode[]
  unconverted?: IosNode
}
interface PrefixListState extends Tracked {
  readonly entries: Map<number, { readonly node: IosNode; readonly entry: PrefixListEntry }>
  description?: { readonly node: IosNode; readonly text: string }
}
interface CommunityListState extends Tracked {
  kind?: 'standard' | 'expanded'
  readonly entries: { readonly node: IosNode; readonly entry: CommunitySetEntry }[]
}
interface AsPathState extends Tracked {
  readonly entries: { readonly node: IosNode; readonly action: Action; readonly regex: string }[]
}

/** A route map's match conditions, by what they name, and their path under a term's `matches`. */
type MatchLeaf = 'ipv4' | 'ipv6' | 'communitySets' | 'asPathSets' | 'tags'
const MATCH_PATHS: Readonly<Record<MatchLeaf, readonly string[]>> = { ipv4: ['prefixLists', 'ipv4'], ipv6: ['prefixLists', 'ipv6'], communitySets: ['communitySets'], asPathSets: ['asPathSets'], tags: ['tags'] }
/** What a set statement gives: values by their path under a term's `actions`. */
type SetEffect = { readonly node: IosNode; readonly actions: readonly (readonly [path: readonly string[], value: unknown])[]; readonly deletes?: string }

interface Sequence {
  action: Action
  readonly headers: IosNode[]
  /** Every statement in it: headers, matches, sets and the rest. */
  readonly nodes: IosNode[]
  /** The first statement that isn't converted: the sequence is left out whole. */
  problem?: { readonly node: IosNode; readonly reason: string }
  /** Each match's values in order, with the statement that first named each, and every statement of the match. */
  readonly matches: Map<MatchLeaf, { readonly values: { readonly value: string | number; readonly node: IosNode }[]; readonly nodes: IosNode[] }>
  /** By what a later set replaces (`community` for `set community` with or without `additive`). */
  readonly sets: Map<string, SetEffect>
}
interface RouteMapState extends Tracked {
  readonly sequences: Map<number, Sequence>
}

/** A route map sequence's statement other than its header: what it does to the sequence. */
type Child =
  | { readonly kind: 'match'; readonly leaf: MatchLeaf; readonly values: readonly (string | number)[] }
  | { readonly kind: 'set'; readonly key: string; readonly effect: Omit<SetEffect, 'node'> }
  | { readonly kind: 'ignored' | 'problem'; readonly reason: string }

/** The regex on a community or AS-path list's line: everything after `permit|deny`, as written (spaces too), without the quotes IOS takes around it. */
function regexOf(node: IosNode, list: 'community' | 'as-path'): string | undefined {
  const pattern = list === 'community' ? /^ip\s+community-list\s+(?:(?:standard|expanded)\s+)?\S+\s+(?:permit|deny)\s+(.+)$/i : /^ip\s+as-path\s+access-list\s+\S+\s+(?:permit|deny)\s+(.+)$/i
  const m = pattern.exec(node.text.trim())
  if (!m) return undefined
  const r = m[1].trim()
  return r.length >= 2 && r.startsWith('"') && r.endsWith('"') ? r.slice(1, -1) : r
}

/** Reads one statement inside a route map sequence. */
function readChild(node: IosNode): Child {
  if (node.kind === 'comment') return { kind: 'ignored', reason: 'a comment' }
  if (node.kind !== 'statement' || node.children.length) return { kind: 'problem', reason: 'not a route map statement the model has' }
  const w = node.words
  const lw = w.map((x) => x.toLowerCase())
  if (lw[0] === 'description') return { kind: 'ignored', reason: 'a remark: the model keeps no description for a route map sequence' }
  if (lw[0] === 'continue') return { kind: 'problem', reason: 'continue: the route goes on to a later sequence with its changes kept, which the model\'s terms can\'t say' }
  if (lw[0] === 'match') {
    if ((lw[1] === 'ip' || lw[1] === 'ipv6') && lw[2] === 'address' && lw[3] === 'prefix-list' && w.length > 4) return { kind: 'match', leaf: lw[1] === 'ip' ? 'ipv4' : 'ipv6', values: w.slice(4) }
    if (lw[1] === 'community' && w.length > 2) {
      if (lw.includes('exact-match')) return { kind: 'problem', reason: 'exact-match: the model matches a route that carries the communities, not one that carries only them' }
      return { kind: 'match', leaf: 'communitySets', values: w.slice(2) }
    }
    if (lw[1] === 'as-path' && w.length > 2) return { kind: 'match', leaf: 'asPathSets', values: w.slice(2) }
    if (lw[1] === 'tag' && w.length > 2) {
      const tags = w.slice(2).map((t) => inRange(t, 0, 4294967295))
      if (tags.some((t) => t === null)) return { kind: 'problem', reason: 'not a tag from 0 to 4294967295' }
      return { kind: 'match', leaf: 'tags', values: tags as number[] }
    }
    return { kind: 'problem', reason: 'a match the model doesn\'t have (it has prefix lists, community lists, AS-path lists and tags)' }
  }
  if (lw[0] === 'set') {
    const number = (key: string, leaf: string): Child => {
      const n = w.length === 3 ? inRange(w[2], 0, 4294967295) : null
      return n === null ? { kind: 'problem', reason: 'not a value from 0 to 4294967295' } : { kind: 'set', key, effect: { actions: [[[leaf], n]] } }
    }
    if (lw[1] === 'local-preference') return number('local-preference', 'localPreference')
    if (lw[1] === 'metric') {
      if (w.length === 3 && /^[+-]/.test(w[2])) return { kind: 'problem', reason: 'a metric changed by an amount: the model sets a value' }
      return number('metric', 'med')
    }
    if (lw[1] === 'tag') return number('tag', 'tag')
    if (lw[1] === 'community' && w.length > 2) {
      const additive = lw[lw.length - 1] === 'additive'
      const words = w.slice(2, additive ? -1 : undefined)
      const values = words.map(community)
      if (!words.length || values.some((v) => v === null)) return { kind: 'problem', reason: 'a community the model has no form for (none, internet)' }
      return { kind: 'set', key: 'community', effect: { actions: [[[additive ? 'communityAdd' : 'communitySet', 'values'], values]] } }
    }
    if (lw[1] === 'comm-list' && w.length === 4 && lw[3] === 'delete') return { kind: 'set', key: 'comm-list', effect: { actions: [[['communityDelete', 'sets'], [w[2]]]], deletes: w[2] } }
    if (lw[1] === 'as-path' && lw[2] === 'prepend' && w.length > 3) {
      const path = w.slice(3).map(asNumber)
      if (path.some((a) => a === null)) return { kind: 'problem', reason: 'not a list of AS numbers (last-as isn\'t converted)' }
      return { kind: 'set', key: 'prepend', effect: { actions: [[['asPathPrepend'], path]] } }
    }
    if (lw[1] === 'ip' && lw[2] === 'next-hop' && w.length === 4 && isIpv4(w[3])) return { kind: 'set', key: 'ip next-hop', effect: { actions: [[['nextHop'], w[3]]] } }
    if (lw[1] === 'ipv6' && lw[2] === 'next-hop' && w.length === 4 && isIpv6(w[3])) return { kind: 'set', key: 'ipv6 next-hop', effect: { actions: [[['nextHop'], w[3].toLowerCase()]] } }
    return { kind: 'problem', reason: 'a set the model doesn\'t have (it has local preference, metric, communities, a community list\'s delete, AS-path prepend, one next hop and tag)' }
  }
  if (lw[0] === 'no') return { kind: 'problem', reason: 'takes a match or set out of the sequence, which isn\'t converted' }
  return { kind: 'problem', reason: 'not a route map statement the model has' }
}

/**
 * Reads IOS's routing policy statements as they come (`top()`), and puts what they leave in a `RoutingPolicy` once the
 * text is read (`finish()`). Dispositions go in `dispositions`, by statement id.
 */
export function createPolicyReader(dispositions: Record<string, StatementDisposition>) {
  const set = (node: IosNode, d: StatementDisposition) => {
    dispositions[node.id] = d
  }
  /** Turns a statement still mapped into unsupported (one already ignored or unsupported keeps its own reason). */
  const demote = (node: IosNode, reason: string) => {
    if (dispositions[node.id]?.kind === 'mapped') set(node, unsupported(reason))
  }
  const prefixLists = new Map<string, PrefixListState>()
  const communityLists = new Map<string, CommunityListState>()
  const asPaths = new Map<string, AsPathState>()
  const routeMaps = new Map<string, RouteMapState>()

  const stateOf = <T extends Tracked>(map: Map<string, T>, key: string, make: () => T): T => {
    const s = map.get(key) ?? make()
    map.set(key, s)
    return s
  }
  /** A statement about a list that isn't converted: the list is left out whole once the text is read. */
  const unconverted = (state: Tracked, node: IosNode, reason: string): StatementDisposition => {
    state.unconverted ??= node
    state.nodes.push(node)
    return unsupported(reason)
  }
  /** `no …` for a whole list or route map: every statement about it is undone, and it starts again empty. */
  const removeAll = (map: Map<string, Tracked>, key: string, node: IosNode, what: string): StatementDisposition => {
    const state = map.get(key)
    if (!state?.nodes.length) return ignored(`no such ${what}: nothing to convert`)
    for (const n of state.nodes) set(n, n.kind === 'comment' ? ignored('a comment') : ignored(`removed by line ${line(node)}`))
    map.delete(key)
    return ignored(`removes the ${what} configured on ${linesText(state.nodes)}: nothing to convert`)
  }

  // ---- prefix lists

  const mapPrefixList = (node: IosNode, family: Family, remove: boolean): StatementDisposition => {
    const w = node.words.slice(remove ? 1 : 0)
    const lw = w.map((x) => x.toLowerCase())
    const name = w[2]
    // `ip prefix-list sequence-number` only changes how the lists are shown.
    if (name === undefined || lw[2] === 'sequence-number') return unsupported('not a prefix list statement the model has')
    const key = `${family}|${name}`
    const state = stateOf(prefixLists, key, (): PrefixListState => ({ nodes: [], entries: new Map() }))
    if (remove && w.length === 3) return removeAll(prefixLists, key, node, 'prefix list')
    if (lw[3] === 'description') {
      if (remove) {
        const d = state.description
        if (!d) return ignored('no description: nothing to convert')
        set(d.node, ignored(`removed by line ${line(node)}`))
        state.description = undefined
        state.nodes.push(node)
        return ignored(`removes the description on line ${line(d.node)}: nothing to convert`)
      }
      if (w.length < 5) return unconverted(state, node, 'not a prefix list statement the model has')
      if (state.description) set(state.description.node, ignored(`superseded by line ${line(node)}`))
      state.description = { node, text: node.text.trim().replace(/^(?:\S+\s+){4}/, '') }
      state.nodes.push(node)
      return mapped([])
    }
    // `[no] ip prefix-list L [seq N] permit|deny P [ge X] [le Y]`; a `no` can name the entry by its number alone.
    const seq = lw[3] === 'seq' ? inRange(w[4], 1, 4294967294) : undefined
    const at = lw[3] === 'seq' ? 5 : 3
    const action = lw[at]
    const match = isAction(action) ? prefixMatch(family, w.slice(at + 1)) : undefined
    if (seq === null) return unconverted(state, node, 'not a sequence number from 1 to 4294967294')
    if (remove) {
      if ((action !== undefined && match === undefined) || typeof match === 'string' || (seq === undefined && match === undefined)) return unconverted(state, node, 'not a prefix list statement the model has')
      const found = [...state.entries].find(([s, e]) => (seq === undefined || s === seq) && (match === undefined || (e.entry.action === action && sameMatch(e.entry, match))))
      if (!found) return ignored('no such entry: nothing to convert')
      set(found[1].node, ignored(`removed by line ${line(node)}`))
      state.entries.delete(found[0])
      state.nodes.push(node)
      return ignored(`removes the entry on line ${line(found[1].node)}: nothing to convert`)
    }
    if (match === undefined) return unconverted(state, node, 'not a prefix list statement the model has')
    if (typeof match === 'string') return unconverted(state, node, match)
    // With no `seq`, IOS numbers the entry 5 after the highest.
    const number = seq ?? Math.max(0, ...state.entries.keys()) + 5
    const entry: PrefixListEntry = { action: action as Action, ...match }
    const existing = state.entries.get(number)
    if (existing) {
      if (existing.entry.action !== entry.action || !sameMatch(existing.entry, entry)) return unconverted(state, node, 'a sequence number the list already has, with another entry: what the device keeps isn\'t certain')
      state.nodes.push(node)
      return ignored(`the same entry as line ${line(existing.node)}: nothing more to convert`)
    }
    if (number > 4294967294) return unconverted(state, node, 'numbered past the highest sequence number')
    state.entries.set(number, { node, entry })
    state.nodes.push(node)
    return mapped([])
  }

  // ---- community lists and AS-path access lists

  const mapCommunityList = (node: IosNode, remove: boolean): StatementDisposition => {
    const w = node.words.slice(remove ? 1 : 0)
    const lw = w.map((x) => x.toLowerCase())
    const typed = lw[2] === 'standard' || lw[2] === 'expanded'
    const name = typed ? w[3] : w[2]
    // Numbered lists: 1 to 99 standard, 100 to 500 expanded.
    const numbered = typed || name === undefined ? undefined : inRange(name, 1, 500)
    if (name === undefined || numbered === null) return unsupported('not a community list statement the model has')
    const kind = typed ? (lw[2] as 'standard' | 'expanded') : numbered! <= 99 ? 'standard' : 'expanded'
    const state = stateOf(communityLists, name, (): CommunityListState => ({ nodes: [], entries: [] }))
    const at = typed ? 4 : 3
    if (remove) {
      if (w.length === at) return removeAll(communityLists, name, node, 'community list')
      // Whether IOS takes out the one entry or the whole list isn't certain: the list is left out.
      return unconverted(state, node, 'removes part of a community list, which isn\'t converted')
    }
    const action = lw[at]
    if (!isAction(action) || w.length <= at + 1) return unconverted(state, node, 'not a community list statement the model has')
    if (state.kind !== undefined && state.kind !== kind) return unconverted(state, node, 'a standard and an expanded list of one name: IOS refuses one of them')
    let entry: CommunitySetEntry
    if (kind === 'expanded') {
      const regex = regexOf(node, 'community')
      if (!regex) return unconverted(state, node, 'not a community list statement the model has')
      entry = { action, regexes: [regex] }
    } else {
      const members = w.slice(at + 1).map(community)
      if (members.some((m) => m === null)) return unconverted(state, node, 'a community the model has no form for (internet matches every route)')
      entry = { action, members: members as string[] }
    }
    state.kind = kind
    state.entries.push({ node, entry })
    state.nodes.push(node)
    return mapped([])
  }

  const mapAsPath = (node: IosNode, remove: boolean): StatementDisposition => {
    const w = node.words.slice(remove ? 1 : 0)
    const lw = w.map((x) => x.toLowerCase())
    const name = w[3]
    // IOS numbers its AS-path access lists, from 1 to 500.
    if (name === undefined || inRange(name, 1, 500) === null) return unsupported('not an AS-path access list numbered from 1 to 500')
    const state = stateOf(asPaths, name, (): AsPathState => ({ nodes: [], entries: [] }))
    if (remove) {
      if (w.length === 4) return removeAll(asPaths, name, node, 'AS-path access list')
      return unconverted(state, node, 'removes part of an AS-path access list, which isn\'t converted')
    }
    const action = lw[4]
    const regex = regexOf(node, 'as-path')
    if (!isAction(action) || !regex) return unconverted(state, node, 'not an AS-path access list statement the model has')
    state.entries.push({ node, action, regex })
    state.nodes.push(node)
    return mapped([])
  }

  // ---- route maps

  const mapRouteMap = (node: IosNode): void => {
    const w = node.words
    const lw = w.map((x) => x.toLowerCase())
    const name = w[1]
    const hasAction = isAction(lw[2])
    const seqWord = w[hasAction ? 3 : 2]
    const refuse = (reason: string) => {
      for (const n of all(node)) set(n, n.kind === 'comment' ? ignored('a comment') : unsupported(reason))
    }
    if (name === undefined || w.length > (hasAction ? 4 : 3)) return refuse('not a route map statement the model has')
    const state = stateOf(routeMaps, name, (): RouteMapState => ({ nodes: [], sequences: new Map() }))
    const seq = seqWord === undefined ? undefined : inRange(seqWord, 0, 65535)
    // With no sequence number, IOS makes sequence 10 of a new route map, or edits a route map's only sequence.
    const number = seq === undefined ? (state.sequences.size === 0 ? 10 : state.sequences.size === 1 ? [...state.sequences.keys()][0] : null) : seq
    if (number === null) {
      state.unconverted ??= node
      state.nodes.push(...all(node))
      return refuse(seq === null ? 'not a sequence number from 0 to 65535' : 'no sequence number, and the route map has several: IOS refuses it')
    }
    const sequence: Sequence = state.sequences.get(number) ?? { action: 'permit', headers: [], nodes: [], matches: new Map(), sets: new Map() }
    state.sequences.set(number, sequence)
    // Entering a sequence again with the other action changes its action, as on the device.
    if (hasAction) sequence.action = lw[2] as Action
    sequence.headers.push(node)
    sequence.nodes.push(...all(node))
    state.nodes.push(...all(node))
    set(node, mapped([]))
    for (const child of node.children) {
      const c = readChild(child)
      if (c.kind === 'ignored') set(child, ignored(c.reason))
      else if (c.kind === 'problem') {
        sequence.problem ??= { node: child, reason: c.reason }
        for (const n of all(child)) set(n, n.kind === 'comment' ? ignored('a comment') : unsupported(c.reason))
      } else if (c.kind === 'match') {
        const match = sequence.matches.get(c.leaf) ?? { values: [], nodes: [] }
        sequence.matches.set(c.leaf, match)
        // IOS joins a match's statements into one list (`match community A` and `match community B` are `A B`).
        for (const value of c.values) if (!match.values.some((x) => x.value === value)) match.values.push({ value, node: child })
        match.nodes.push(child)
        set(child, mapped([]))
      } else if (c.kind === 'set') {
        // A later set of the same kind replaces the earlier one, as on the device.
        const previous = sequence.sets.get(c.key)
        if (previous) set(previous.node, ignored(`superseded by line ${line(child)}`))
        sequence.sets.set(c.key, { node: child, ...c.effect })
        set(child, mapped([]))
      }
    }
  }

  const removeRouteMap = (node: IosNode): StatementDisposition => {
    const w = node.words.slice(1)
    const lw = w.map((x) => x.toLowerCase())
    const name = w[1]
    if (name === undefined) return unsupported('not a route map statement the model has')
    if (w.length === 2) return removeAll(routeMaps, name, node, 'route map')
    const state = stateOf(routeMaps, name, (): RouteMapState => ({ nodes: [], sequences: new Map() }))
    const seq = isAction(lw[2]) && w.length === 4 ? inRange(w[3], 0, 65535) : null
    if (seq === null) return unconverted(state, node, 'removes part of a route map in a way that isn\'t converted')
    const sequence = state.sequences.get(seq)
    if (!sequence) return ignored('no such route map sequence: nothing to convert')
    for (const n of sequence.nodes) set(n, n.kind === 'comment' ? ignored('a comment') : ignored(`removed by line ${line(node)}`))
    state.sequences.delete(seq)
    state.nodes.push(node)
    // A route map whose last sequence goes is gone, as on the device.
    if (!state.sequences.size && !state.unconverted) routeMaps.delete(name)
    return ignored(`removes route map sequence ${seq}, configured on ${linesText(sequence.nodes)}: nothing to convert`)
  }

  /** Reads a top-level statement if it is routing policy, with its disposition; false when it isn't. */
  const top = (node: IosNode): boolean => {
    const lw = node.words.map((x) => x.toLowerCase())
    const remove = lw[0] === 'no'
    const a = remove ? lw.slice(1) : lw
    const isList = (a[0] === 'ip' || a[0] === 'ipv6') && a[1] === 'prefix-list'
    const isCommunity = a[0] === 'ip' && a[1] === 'community-list'
    const isAsPath = a[0] === 'ip' && a[1] === 'as-path' && a[2] === 'access-list'
    if (a[0] === 'route-map' && !remove) mapRouteMap(node)
    else if (!(a[0] === 'route-map' || isList || isCommunity || isAsPath)) return false
    else if (node.children.length) for (const n of all(node)) set(n, n.kind === 'comment' ? ignored('a comment') : unsupported('not a routing policy statement the model has'))
    else set(node, a[0] === 'route-map' ? removeRouteMap(node) : isList ? mapPrefixList(node, a[0] === 'ip' ? 'ipv4' : 'ipv6', remove) : isCommunity ? mapCommunityList(node, remove) : mapAsPath(node, remove))
    return true
  }

  /**
   * Puts what the statements leave in a `RoutingPolicy`, with each statement's final disposition: the lists, then the
   * route maps, which name only lists that are converted.
   */
  const finish = (): RoutingPolicy | undefined => {
    /** A list or route map left out whole: the statements it mapped are unsupported. */
    const leaveOut = (state: Tracked, what: string) => {
      for (const n of state.nodes) demote(n, `left out whole: line ${line(state.unconverted!)} about the same ${what} isn't converted`)
    }

    const lists: Record<Family, [string, PrefixList][]> = { ipv4: [], ipv6: [] }
    for (const [key, state] of prefixLists) {
      const family = key.slice(0, 4) as Family
      const name = key.slice(5)
      if (state.unconverted) {
        leaveOut(state, 'prefix list')
        continue
      }
      // A list with no entries: whether a route map's match on it matches nothing or everything isn't certain.
      if (!state.entries.size) {
        if (state.description) set(state.description.node, unsupported('a prefix list with no entries: what a match on it does isn\'t certain'))
        continue
      }
      const at = ['routingPolicy', 'prefixLists', family, name]
      if (state.description) set(state.description.node, mapped([fieldPath(...at, 'description')]))
      const entries = [...state.entries].sort(([x], [y]) => x - y)
      for (const [seq, { node, entry }] of entries) set(node, mapped(Object.keys(entry).map((leaf) => fieldPath(...at, 'entries', String(seq), leaf))))
      lists[family].push([name, { ...(state.description ? { description: state.description.text } : {}), entries: keyed(entries.map(([seq, { entry }]) => [String(seq), entry])) }])
    }

    const communitySets: [string, CommunitySet][] = []
    for (const [name, state] of communityLists) {
      if (state.unconverted) {
        leaveOut(state, 'community list')
        continue
      }
      if (!state.entries.length) continue
      const at = ['routingPolicy', 'communitySets', name]
      // An expanded list's entries are regexes, which can't say what kind of community they match: standard ones.
      const expanded = state.kind === 'expanded'
      state.entries.forEach(({ node, entry }, i) => set(node, mapped([...Object.keys(entry).map((leaf) => fieldPath(...at, 'entries', String(i + 1), leaf)), ...(i === 0 && expanded ? [fieldPath(...at, 'type'), fieldPath(...at, 'regexDialect')] : [])])))
      communitySets.push([name, { ...(expanded ? { type: 'standard' as const, regexDialect: 'cisco' as const } : {}), entries: keyed(state.entries.map(({ entry }, i) => [String(i + 1), entry])) }])
    }

    const asPathSets: [string, AsPathSet][] = []
    for (const [name, state] of asPaths) {
      if (state.unconverted) {
        leaveOut(state, 'AS-path access list')
        continue
      }
      if (!state.entries.length) continue
      const at = ['routingPolicy', 'asPathSets', name]
      state.entries.forEach(({ node }, i) => set(node, mapped([fieldPath(...at, 'entries', String(i + 1), 'action'), fieldPath(...at, 'entries', String(i + 1), 'regex'), ...(i === 0 ? [fieldPath(...at, 'regexDialect')] : [])])))
      asPathSets.push([name, { regexDialect: 'cisco', entries: keyed(state.entries.map(({ action, regex }, i) => [String(i + 1), { action, regex }])) }])
    }

    /** Why a sequence naming list `name` can't be converted, or undefined when the list is. */
    const unresolved = (leaf: Exclude<MatchLeaf, 'tags'>, name: string): string | undefined => {
      const [converted, defined, what] =
        leaf === 'ipv4' || leaf === 'ipv6'
          ? [lists[leaf], prefixLists.has(`${leaf}|${name}`), `an ${leaf === 'ipv4' ? 'IPv4' : 'IPv6'} prefix list`]
          : leaf === 'communitySets'
            ? [communitySets, communityLists.has(name), 'a community list']
            : [asPathSets, asPaths.has(name), 'an AS-path access list']
      if (converted.some(([n]) => n === name)) return undefined
      return defined ? `names ${what} that isn't converted` : `names ${what} the configuration doesn't define`
    }

    const policies: [string, Policy][] = []
    for (const [name, state] of routeMaps) {
      if (state.unconverted) {
        leaveOut(state, 'route map')
        continue
      }
      const at = ['routingPolicy', 'policies', name]
      const sequences = [...state.sequences].sort(([x], [y]) => x - y)
      // References are checked now, once every list is read and converted or not.
      for (const [, s] of sequences) {
        for (const [leaf, match] of s.matches) {
          if (leaf === 'tags') continue
          const bad = match.values.find((v) => unresolved(leaf, String(v.value)) !== undefined)
          if (bad && !s.problem) s.problem = { node: bad.node, reason: unresolved(leaf, String(bad.value))! }
          if (bad) set(bad.node, unsupported(unresolved(leaf, String(bad.value))!))
        }
        const del = s.sets.get('comm-list')
        const why = del?.deletes !== undefined ? unresolved('communitySets', del.deletes) : undefined
        if (del && why) {
          s.problem ??= { node: del.node, reason: why }
          set(del.node, unsupported(why))
        }
        const v6 = s.sets.get('ipv6 next-hop')
        if (v6 && s.sets.has('ip next-hop')) {
          s.problem ??= { node: v6.node, reason: 'an IPv4 and an IPv6 next hop: the model has one' }
          set(v6.node, unsupported('an IPv4 and an IPv6 next hop: the model has one'))
        }
      }
      // The per-term rule: a sequence that isn't converted is left out whole, and the whole route map with it unless
      // that is safe. Every sequence permits or denies, so only the last can be left out (termSkipSafe() says so).
      const flowOf = (s: Sequence) => (s.action === 'permit' ? 'accept' : 'reject')
      const probe: Policy = { fallThrough: 'reject', terms: keyed(sequences.map(([seq, s]) => [String(seq), { actions: { flow: flowOf(s), ...(s.problem ? { unknown: true } : {}) } } as PolicyTerm])) }
      for (const [seq, s] of sequences) if (s.problem) for (const n of s.nodes) demote(n, `part of route map sequence ${seq}, converted whole or not at all: line ${line(s.problem.node)} isn't converted`)
      const unsafe = sequences.find(([seq, s]) => s.problem && !termSkipSafe(probe, String(seq)))
      const converted = sequences.filter(([, s]) => !s.problem)
      if (unsafe || !converted.length) {
        const reason = unsafe ? `left out whole: sequence ${unsafe[0]} (line ${line(unsafe[1].headers[0])}) isn't converted, and the sequences after it would see the routes it decides` : 'left out whole: none of its sequences is converted'
        for (const n of state.nodes) demote(n, reason)
        continue
      }
      const terms: [string, PolicyTerm][] = []
      let first = true
      for (const [seq, s] of converted) {
        const termAt = [...at, 'terms', String(seq)]
        const matches: Obj = {}
        for (const leaf of ['ipv4', 'ipv6', 'communitySets', 'asPathSets', 'tags'] as const) {
          const match = s.matches.get(leaf)
          if (!match) continue
          const path = MATCH_PATHS[leaf]
          const parent = path.length === 2 ? ((matches[path[0]] ??= {}) as Obj) : matches
          parent[path[path.length - 1]] = match.values.map((v) => v.value)
          for (const node of match.nodes) set(node, mapped([fieldPath(...termAt, 'matches', ...path)]))
        }
        const actions: Obj = { flow: flowOf(s) }
        for (const effect of s.sets.values()) {
          const fields: string[] = []
          for (const [path, value] of effect.actions) {
            const parent = path.length === 2 ? ((actions[path[0]] ??= {}) as Obj) : actions
            parent[path[path.length - 1]] = value
            fields.push(fieldPath(...termAt, 'actions', ...path))
          }
          set(effect.node, mapped(fields))
        }
        // The flow is the sequence's permit or deny; the first header also says the route map's implicit deny.
        for (const h of s.headers) {
          set(h, mapped([fieldPath(...termAt, 'actions', 'flow'), ...(first ? [fieldPath(...at, 'fallThrough')] : [])]))
          first = false
        }
        terms.push([String(seq), { ...(Object.keys(matches).length ? { matches: matches as PolicyTerm['matches'] } : {}), actions: actions as PolicyActions }])
      }
      policies.push([name, { terms: keyed(terms), fallThrough: 'reject' }])
    }

    const out: Obj = {}
    const prefix: Obj = {}
    for (const family of ['ipv4', 'ipv6'] as const) if (lists[family].length) prefix[family] = keyed(lists[family])
    if (Object.keys(prefix).length) out.prefixLists = prefix
    if (communitySets.length) out.communitySets = keyed(communitySets)
    if (asPathSets.length) out.asPathSets = keyed(asPathSets)
    if (policies.length) out.policies = keyed(policies)
    return Object.keys(out).length ? (out as RoutingPolicy) : undefined
  }

  /** Whether the text configures route map `name` (converted or not), as it stands at the end. */
  const definesRouteMap = (name: string): boolean => routeMaps.has(name)

  return { top, finish, definesRouteMap }
}
