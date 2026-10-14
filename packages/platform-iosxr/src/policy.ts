// IOS-XR's route policy language (RPL) → the model's routing policy (model 0.5.0), for its simple forms only (#79):
// `prefix-set`, `community-set` and `as-path-set`, and a `route-policy` that is a flat sequence of `if <match> then
// <actions> [else <actions>] endif` blocks and top-level actions. Each set and policy is one atomic statement in the
// tree (tree.ts), so each is converted whole or left `unsupported` whole, never in part: anything else in it (a nested
// `if`, `elseif`, `or`/`not`, parameters, `apply`, an inline set, a set element the model can't hold) leaves it out.
//
// RPL's semantics, kept: a route goes through the blocks in order. `drop` rejects it; `done` accepts it there; `pass`,
// or a `set` that changes it, lets it on, accepted at the end unless a later statement drops it; a route nothing passes
// is dropped (the policy's `fallThrough` is `reject`). A block that passes a route is a term that accepts only where no
// later statement can see that route (the last block, or the `then` of a last `if` with an `else`), so its meaning is
// kept exactly; anywhere else the policy is left out. No reason repeats a word of the configuration (AGENTS.md).
import { communityType, isIpAddress, parsePrefix, type AsPathSetEntry, type CommunitySetEntry, type Policy, type PolicyActions, type PolicyMatches, type PolicyTerm, type PrefixListEntry, type PrefixMatchForm } from '@dialect/core'
import type { XrNode } from './tree'

/** IOS-XR's names for well-known communities, by the model's. */
export const XR_COMMUNITY_NAMES: Readonly<Record<string, string>> = { 'no-export': 'no-export', 'no-advertise': 'no-advertise', 'no-export-subconfed': 'local-AS', 'accept-own': 'accept-own', 'graceful-shutdown': 'graceful-shutdown' }
const FROM_XR_NAMES: Readonly<Record<string, string>> = Object.fromEntries(Object.entries(XR_COMMUNITY_NAMES).map(([model, xr]) => [xr.toLowerCase(), model]))

/** A name IOS-XR takes for a set or policy, without parameters: letters, digits, `_`, `.` and `-`. */
export const RPL_NAME = /^[\w.-]{1,64}$/

/** The lines of a set's or policy's body: between its first and last line, trimmed, comments and blank lines dropped. */
function body(node: XrNode): string[] {
  return node.text
    .split('\n')
    .slice(1, -1)
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'))
}

/**
 * A set's elements: its body's text split at commas outside quotes, each trimmed, its whitespace outside quotes made one
 * space. What is inside quotes (a regex) is kept byte for byte. Null for an element left empty.
 */
function elements(node: XrNode): string[] | null {
  const text = body(node).join('\n')
  const out: string[] = []
  let current = ''
  let quote = false
  for (const c of text) {
    if (c === '\'') quote = !quote
    if (c === ',' && !quote) {
      out.push(current)
      current = ''
    } else current += quote || c === '\'' || !/\s/.test(c) ? c : current.endsWith(' ') || current === '' ? '' : ' '
  }
  out.push(current)
  const trimmed = out.map((e) => e.trim())
  if (trimmed.length === 1 && trimmed[0] === '') return []
  return trimmed.some((e) => e === '') ? null : trimmed
}

/** `ios-regex '…'` → the regex, or null. */
const iosRegex = (element: string): string | null => {
  const m = /^ios-regex '([^']*)'$/.exec(element)
  return m && m[1] !== '' ? m[1] : null
}

/** A prefix set's entries, by family (keyed by their place from 1 in the whole set), or why it isn't converted. */
export function prefixSet(node: XrNode): { ipv4: Record<string, PrefixListEntry>; ipv6: Record<string, PrefixListEntry> } | string {
  const list = elements(node)
  if (list === null) return 'a prefix set with an empty element'
  if (!list.length) return 'a prefix set with no entries: what a match on it does isn\'t certain'
  const out = { ipv4: Object.create(null) as Record<string, PrefixListEntry>, ipv6: Object.create(null) as Record<string, PrefixListEntry> }
  for (const [i, element] of list.entries()) {
    const w = element.split(' ')
    const p = parsePrefix(w[0])
    if (!p) return `entry ${i + 1}: not a prefix with no host bits set`
    const bits = p.family === 'ipv4' ? 32 : 128
    const options = w.slice(1)
    const n = (s: string | undefined) => (s !== undefined && /^\d{1,3}$/.test(s) ? Number(s) : NaN)
    let min = p.length
    let max = p.length
    let form: PrefixMatchForm | undefined = 'exact'
    const said = options.join(' ')
    if (!options.length) form = 'exact'
    else if (/^le \d+$/.test(said)) [max, form] = [n(options[1]), 'le']
    else if (/^ge \d+$/.test(said)) [min, max, form] = [n(options[1]), bits, 'ge']
    else if (/^ge \d+ le \d+$/.test(said)) [min, max, form] = [n(options[1]), n(options[3]), 'ge-le']
    else if (/^eq \d+$/.test(said)) [min, max, form] = [n(options[1]), n(options[1]), undefined]
    else return `entry ${i + 1}: lengths the model has no form for`
    // In the model's forms: `ge` longer than the prefix, `le` no shorter, the least first, none beyond the family's.
    const ok = p.length <= min && min <= max && max <= bits && (form !== 'ge' && form !== 'ge-le' ? true : min > p.length)
    if (!ok) return `entry ${i + 1}: lengths out of range for its prefix`
    out[p.family][String(i + 1)] = { action: 'permit', prefix: w[0], minLength: min, maxLength: max, ...(form ? { form } : {}) }
  }
  return out
}

/**
 * A community set's entries: each element its own permit entry, as `matches-any` reads it (a route with any of them
 * matches). Literal communities (`65000:100`, the well-known names the model has) and `ios-regex` patterns; wildcards,
 * ranges, `dfa-regex`, `internet` and the rest leave the set out.
 */
export function communitySet(node: XrNode): { entries: Record<string, CommunitySetEntry>; regex: boolean } | string {
  const list = elements(node)
  if (list === null) return 'a community set with an empty element'
  if (!list.length) return 'a community set with no entries'
  const entries = Object.create(null) as Record<string, CommunitySetEntry>
  let regex = false
  for (const [i, element] of list.entries()) {
    const pattern = iosRegex(element)
    const named = Object.hasOwn(FROM_XR_NAMES, element.toLowerCase()) ? FROM_XR_NAMES[element.toLowerCase()] : undefined
    const value = named ?? (/^\d+:\d+$/.test(element) && communityType(element) === 'standard' ? element : undefined)
    if (pattern !== null) {
      entries[String(i + 1)] = { action: 'permit', regexes: [pattern] }
      regex = true
    } else if (value !== undefined) entries[String(i + 1)] = { action: 'permit', members: [value] }
    else return `entry ${i + 1}: a community the model has no form for (a wildcard, a range, dfa-regex or another word)`
  }
  return { entries, regex }
}

/** An AS-path set's entries: each `ios-regex` its own permit entry; `passes-through`, `length` and the rest leave it out. */
export function asPathSet(node: XrNode): Record<string, AsPathSetEntry> | string {
  const list = elements(node)
  if (list === null) return 'an AS-path set with an empty element'
  if (!list.length) return 'an AS-path set with no entries'
  const entries = Object.create(null) as Record<string, AsPathSetEntry>
  for (const [i, element] of list.entries()) {
    const pattern = iosRegex(element)
    if (pattern === null) return `entry ${i + 1}: not an ios-regex (passes-through, length, dfa-regex and the rest aren't converted)`
    entries[String(i + 1)] = { action: 'permit', regex: pattern }
  }
  return entries
}

/** The sets a policy names, so they can be checked once every set is read. */
export interface Names {
  readonly prefixSets: string[]
  readonly communitySets: string[]
  /** Community sets a policy sets or adds: IOS-XR takes only literal communities there, never a regex. */
  readonly communitySetters: string[]
  readonly asPathSets: string[]
}

/** A policy's terms as read, before its prefix sets' families are known: a term's prefix set by name. */
export interface ReadPolicy {
  readonly terms: { readonly matches: PolicyMatches & { prefixSet?: string }; readonly actions: PolicyActions }[]
  readonly names: Names
}

/** What a run of actions does: its sets, and whether it drops, accepts (`done`) or passes the route. */
interface Actions {
  readonly actions: Omit<PolicyActions, 'flow'>
  readonly end: 'drop' | 'done' | 'pass' | 'none'
}

/**
 * Reads a route policy's body: its flat blocks and top-level actions as terms in order, or why it isn't converted. A
 * term that passes the route becomes `accept` only where nothing after it can see that route.
 */
export function readPolicy(node: XrNode): ReadPolicy | string {
  if (node.words.length !== 2 || !RPL_NAME.test(node.words[1])) return 'a route policy with parameters, or a name IOS-XR\'s simple form doesn\'t have'
  const lines = body(node)
  const names: Names = { prefixSets: [], communitySets: [], communitySetters: [], asPathSets: [] }
  /** Blocks in order: a condition (none for top-level actions) and its actions, with an `else`'s as its own item. */
  const items: { matches?: PolicyMatches & { prefixSet?: string }; run: Actions; elseOf?: number }[] = []
  let i = 0
  const actions = (stop: (line: string) => boolean): Actions | string => {
    const a: { -readonly [K in keyof Omit<PolicyActions, 'flow'>]: Omit<PolicyActions, 'flow'>[K] } = {}
    let end: Actions['end'] = 'none'
    // RPL runs a block's statements in order, and the model's community actions have one: deleted, then replaced, then
    // added, as the render writes them. A block that says them in another order is left out.
    const COMMUNITY_ORDER = ['communityDelete', 'communitySet', 'communityAdd'] as const
    const inOrder = (leaf: (typeof COMMUNITY_ORDER)[number]) => COMMUNITY_ORDER.slice(COMMUNITY_ORDER.indexOf(leaf) + 1).every((later) => a[later] === undefined)
    for (; i < lines.length && !stop(lines[i]); i++) {
      // `done` and `drop` end the policy there: nothing after them in the block is ever run.
      if (end === 'drop' || end === 'done') return 'a statement after done or drop, which is never run'
      const w = lines[i].split(/\s+/)
      const said = (leaf: keyof typeof a) => a[leaf] !== undefined
      const number = (s: string | undefined, max = 4294967295) => (s !== undefined && /^\d{1,10}$/.test(s) && Number(s) <= max ? Number(s) : null)
      if (lines[i] === 'drop' || lines[i] === 'done') end = lines[i] as 'drop' | 'done'
      else if (lines[i] === 'pass') end = 'pass'
      else if (w[0] === 'set' && w[1] === 'local-preference' && w.length === 3 && number(w[2]) !== null && !said('localPreference')) a.localPreference = number(w[2])!
      else if (w[0] === 'set' && w[1] === 'med' && w.length === 3 && number(w[2]) !== null && !said('med')) a.med = number(w[2])!
      else if (w[0] === 'set' && w[1] === 'tag' && w.length === 3 && number(w[2]) !== null && !said('tag')) a.tag = number(w[2])!
      else if (w[0] === 'set' && w[1] === 'next-hop' && w.length === 3 && !said('nextHop') && !said('nextHopSelf')) {
        if (w[2] === 'self') a.nextHopSelf = true
        else if (isIpAddress(w[2])) a.nextHop = w[2].toLowerCase()
        else return 'a next hop the model has no form for (discard, and the rest)'
      } else if (w[0] === 'set' && w[1] === 'community' && (w.length === 3 || (w.length === 4 && w[3] === 'additive')) && RPL_NAME.test(w[2]) && !said('communityAdd') && !said('communitySet')) {
        const leaf = w.length === 4 ? 'communityAdd' : 'communitySet'
        if (!inOrder(leaf)) return 'community actions in an order the model can\'t keep (it deletes, then replaces, then adds)'
        a[leaf] = { sets: [w[2]] }
        names.communitySets.push(w[2])
        names.communitySetters.push(w[2])
      } else if (w[0] === 'delete' && w[1] === 'community' && w[2] === 'in' && w.length === 4 && RPL_NAME.test(w[3]) && !said('communityDelete')) {
        if (!inOrder('communityDelete')) return 'community actions in an order the model can\'t keep (it deletes, then replaces, then adds)'
        a.communityDelete = { sets: [w[3]] }
        names.communitySets.push(w[3])
      } else if (w[0] === 'prepend' && w[1] === 'as-path' && (w.length === 3 || w.length === 4) && !said('asPathPrepend')) {
        const as = number(w[2])
        const times = w.length === 4 ? number(w[3], 64) : 1
        if (as === null || as < 1 || times === null || times < 1) return 'an AS-path prepend the model has no form for'
        a.asPathPrepend = Array<number>(times).fill(as)
      } else return `a statement the simple form doesn't have (line ${i + 1} of its body)`
    }
    return { actions: a, end }
  }
  const condition = (text: string): (PolicyMatches & { prefixSet?: string }) | string => {
    const m: { -readonly [K in keyof PolicyMatches]: PolicyMatches[K] } & { prefixSet?: string } = {}
    for (const part of text.split(' and ')) {
      const w = part.trim().split(/\s+/)
      if (w[0] === 'destination' && w[1] === 'in' && w.length === 3 && RPL_NAME.test(w[2]) && m.prefixSet === undefined) {
        m.prefixSet = w[2]
        names.prefixSets.push(w[2])
      } else if (w[0] === 'community' && w[1] === 'matches-any' && w.length === 3 && RPL_NAME.test(w[2]) && !m.communitySets) {
        m.communitySets = [w[2]]
        names.communitySets.push(w[2])
      } else if (w[0] === 'as-path' && w[1] === 'in' && w.length === 3 && RPL_NAME.test(w[2]) && !m.asPathSets) {
        m.asPathSets = [w[2]]
        names.asPathSets.push(w[2])
      } else if (w[0] === 'tag' && w[1] === 'eq' && w.length === 3 && /^\d{1,10}$/.test(w[2]) && Number(w[2]) <= 4294967295 && !m.tags) m.tags = [Number(w[2])]
      else return 'a condition the simple form doesn\'t have (or, not, an inline set, or one said twice)'
    }
    return m
  }

  while (i < lines.length) {
    const open = /^if (.+) then$/.exec(lines[i])
    if (!open) {
      const run = actions((l) => /^if\s/.test(l) || /^(else|elseif|endif)\b/.test(l))
      if (typeof run === 'string') return run
      if (i < lines.length && !/^if\s/.test(lines[i])) return 'an else or endif with no if'
      items.push({ run })
      continue
    }
    const matches = condition(open[1])
    if (typeof matches === 'string') return matches
    i++
    const then = actions((l) => /^(if|else|elseif|endif)\b/.test(l))
    if (typeof then === 'string') return then
    if (lines[i] === undefined || /^(if|elseif)\b/.test(lines[i])) return 'a nested if or an elseif: only flat if blocks are converted'
    items.push({ matches, run: then })
    if (lines[i] === 'else') {
      i++
      const otherwise = actions((l) => /^(if|else|elseif|endif)\b/.test(l))
      if (typeof otherwise === 'string') return otherwise
      if (lines[i] !== 'endif') return 'a nested if in an else: only flat if blocks are converted'
      items.push({ run: otherwise, elseOf: items.length - 1 })
    }
    if (lines[i] !== 'endif') return 'an if with no endif'
    i++
  }

  const terms: ReadPolicy['terms'][number][] = []
  for (const [n, item] of items.entries()) {
    const { run } = item
    // Whether a route this item passes can reach any later statement: only its own else follows it.
    const last = n === items.length - 1 || (n === items.length - 2 && items[n + 1].elseOf === n)
    const changes = Object.keys(run.actions).length > 0
    // A block that does nothing is no term; but with an else, its routes must stay out of the else's, which can't be said.
    if (run.end === 'none' && !changes) {
      if (items[n + 1]?.elseOf === n) return 'an if that does nothing, with an else: the model can\'t keep its routes out of the else'
      continue
    }
    const flow = run.end === 'drop' ? 'reject' : run.end === 'done' ? 'accept' : last ? 'accept' : undefined
    if (flow === undefined) return 'a block that passes a route on to later statements, which the model has no flow for'
    // After a top-level statement that decides every route, nothing is reached.
    if (item.matches === undefined && item.elseOf === undefined && n < items.length - 1) return 'a statement for every route before others, which then see none'
    terms.push({ matches: item.matches ?? {}, actions: { ...run.actions, flow } })
  }
  // A policy with no statement that does anything drops every route: no terms, and its fall-through rejects.
  return { terms, names }
}

/** The model's policy from a read one, its prefix sets put in the families they have. */
export function toPolicy(read: ReadPolicy, families: (set: string) => ('ipv4' | 'ipv6')[]): Policy {
  const terms = Object.create(null) as Record<string, PolicyTerm>
  read.terms.forEach((t, i) => {
    const { prefixSet: set, ...matches } = t.matches
    const prefixLists = set === undefined ? undefined : Object.fromEntries(families(set).map((f) => [f, [set]]))
    const all = { ...matches, ...(prefixLists ? { prefixLists } : {}) }
    terms[String(i + 1)] = { ...(Object.keys(all).length ? { matches: all } : {}), actions: t.actions }
  })
  return { ...(read.terms.length ? { terms } : {}), fallThrough: 'reject' }
}
