// Routing policy and filter semantics the plugins and the conformance kit share (since model 0.5.0): the per-term
// rule's question, whether a term can be left out while the rest of its policy or filter is converted
// (docs/ARCHITECTURE.md, the per-term rule).
import type { Filter, Policy, PolicyTerm } from './model'

/** The match conditions model 0.5.0 has: a later term matching on anything else is taken to see every change. */
const KNOWN_MATCHES: ReadonlySet<string> = new Set(['prefixLists', 'prefixListMatch', 'routeFilters', 'communitySets', 'asPathSets', 'protocols', 'neighbors', 'tags', 'family'])

/** The actions that change a route without any later term being able to see it: model 0.5.0 matches on none of them. */
const UNSEEN_ACTIONS: ReadonlySet<string> = new Set(['localPreference', 'med', 'nextHop', 'nextHopSelf'])

/** For each action that changes what a later term can match on, the match that sees it. */
const SEEN_BY: Readonly<Record<string, string>> = { communityAdd: 'communitySets', communitySet: 'communitySets', communityDelete: 'communitySets', asPathPrepend: 'asPathSets', tag: 'tags' }

const own = (o: object | undefined): string[] => (o ? Object.keys(o) : [])

/** The implicit actions a last `discard` term does the same as: each drops the packet. */
const IMPLICIT_DROPS: ReadonlySet<unknown> = new Set(['discard', 'deny'])

/**
 * Whether leaving term `key` of `policy` out (as `unsupported`, whole) and converting the rest still has every later term
 * see the same routes, the same way: the term decides nothing (its flow is left out or `next-term`) and changes nothing
 * a later term matches on (communities for a community-set match, the AS path for an AS-path match, the tag for a tag
 * match). A last term always can be. Anything it doesn't know (a later version's action or match) counts against it.
 * When it can't be, the per-term rule makes the whole policy `unsupported`.
 */
export function termSkipSafe(policy: Policy, key: string): boolean {
  const terms = policy.terms
  if (!terms || !Object.hasOwn(terms, key)) return true
  const keys = Object.keys(terms)
  const later: PolicyTerm[] = keys.slice(keys.indexOf(key) + 1).map((k) => terms[k])
  if (!later.length) return true
  const actions = terms[key]?.actions
  const changes: string[] = []
  for (const action of own(actions)) {
    if (action === 'flow') {
      if (actions?.flow !== 'next-term') return false
    } else if (!UNSEEN_ACTIONS.has(action)) changes.push(action)
  }
  if (!changes.length) return true
  const laterMatches = later.flatMap((t) => own(t?.matches))
  if (laterMatches.some((m) => !KNOWN_MATCHES.has(m))) return false
  return changes.every((action) => Object.hasOwn(SEEN_BY, action) && !laterMatches.includes(SEEN_BY[action]))
}

/**
 * Whether some packets reach `filter`'s implicit action (since model 0.5.1): no term decides every packet, that is, none
 * matches everything (no matches) and accepts, discards or rejects. A renderer warns when a filter relies on it, even
 * when its platform's implicit action is the same, so the reader knows the filter's end is the platform's.
 */
export function filterReliesOnImplicitAction(filter: Filter): boolean {
  return !Object.values(filter.terms ?? {}).some((t) => t?.actions?.action !== 'next-term' && t?.actions?.action !== undefined && Object.keys(t?.matches ?? {}).length === 0)
}

/**
 * Whether leaving term `key` of `filter` out (as `unsupported`, whole) and converting the rest still decides every
 * packet the same way (since model 0.5.1, #103): the term decides nothing (`next-term`: it only counts or logs), or it
 * is the last and does what the filter's implicit action does anyway, so the packets it decided get the same end
 * without it: a `discard`, as both implicit actions drop the packet (Junos's `discard` silently, a Cisco `deny` as the
 * interface says, as a `deny` entry does). A last term that decides otherwise (an `accept`, or a `reject`, which
 * answers where they don't) or whose action or the filter's implicit action isn't known can't be: leaving it out
 * would change what the filter lets through, an only term turning the filter into one that decides everything by its
 * end. When it can't be, the whole filter is `unsupported` instead, and a subinterface can't apply it either.
 */
export function filterTermSkipSafe(filter: Filter, key: string): boolean {
  const terms = filter.terms
  if (!terms || !Object.hasOwn(terms, key)) return true
  const action = terms[key]?.actions?.action
  if (action === 'next-term') return true
  const keys = Object.keys(terms)
  return keys.indexOf(key) === keys.length - 1 && action === 'discard' && IMPLICIT_DROPS.has(filter.implicitAction)
}
