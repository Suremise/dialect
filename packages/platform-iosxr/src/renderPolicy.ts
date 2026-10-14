// The model's `routingPolicy` (model 0.5.0) → IOS-XR's RPL: `prefix-set`, `community-set`, `as-path-set` and
// `route-policy`, in the simple forms the parse reads back (policy.ts). Planned before BGP and the VRFs, which name a
// route policy only when it is written, and emitted before them.
//
// A set IOS-XR can't write in full (an entry with no element for it, a deny, a community it has no word for, another
// dialect's regex, never translated) is left out whole, and a term naming it can't be written either. A policy is
// written term by term, a term an `if <match> then … endif` block (top-level statements for one with no match), each
// whole or not at all (the per-term rule): a term IOS-XR can't write is left out whole, and the whole policy with it
// when that isn't safe (termSkipSafe()). An IOS-XR policy drops a route nothing passes: a policy that passes an
// undecided route on to the next policy (Junos) gets a final `pass`, which accepts it as BGP's default does, with a
// semantic warning.
import { communityType, fieldPath, isAsNumber, isIpAddress, parsePrefix, termSkipSafe, type Diagnostic, type Policy, type PolicyTerm, type PrefixListEntry, type RoutingPolicy } from '@dialect/core'
import { RPL_NAME, XR_COMMUNITY_NAMES } from './policy'

type Segments = readonly (string | number)[]

/** A line to write, the fields it renders, and a warning to raise on it. */
export interface PolicyLine {
  readonly text: string
  readonly fields: readonly Segments[]
  readonly warning?: Omit<Diagnostic, 'span'>
}

export interface PolicyPlan {
  readonly lines: readonly PolicyLine[]
  /** The policies written as route policies, which BGP and the VRFs may name. */
  readonly policies: ReadonlySet<string>
}

const isUint32 = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 0 && (n as number) <= 4294967295
/** A regex IOS-XR reads back the same from `ios-regex '…'`: one line, not empty, no single quote. */
const isXrRegex = (s: unknown): s is string => typeof s === 'string' && s !== '' && !/['\r\n]/.test(s)
/** A community as IOS-XR writes it in a community set, or null for one it has no word for. */
const xrCommunity = (v: unknown): string | null => (typeof v !== 'string' ? null : Object.hasOwn(XR_COMMUNITY_NAMES, v) ? XR_COMMUNITY_NAMES[v] : /^\d+:\d+$/.test(v) && communityType(v) === 'standard' ? v : null)
const FOREIGN_REGEX = 'a Junos regex: regexes are never translated silently, and IOS-XR\'s are another dialect'

/**
 * Plans the routing policy's lines. `skip` marks a field unsupported or not applicable, `skipAll` every populated leaf
 * under a path; a field written is marked by the line that carries it.
 */
export function planRoutingPolicy(rp: RoutingPolicy | undefined, skip: (field: Segments, kind: 'unsupported' | 'not-applicable', reason: string) => void, skipAll: (value: unknown, at: Segments, reason: string) => void): PolicyPlan {
  const lines: PolicyLine[] = []
  // Community sets of literal communities only are `settable`: IOS-XR sets or adds no regex.
  const written = { prefixSets: new Set<string>(), communitySets: new Set<string>(), settable: new Set<string>(), asPathSets: new Set<string>(), policies: new Set<string>() }
  if (!rp) return { lines, policies: written.policies }
  const at0 = ['routingPolicy']
  const empty = (value: object | undefined, at: Segments) => {
    if (value !== undefined && !Object.keys(value).length) skip(at, 'not-applicable', 'configured empty: nothing to write')
  }
  /** A set's element lines, as IOS-XR shows them: a comma after each but the last. */
  const set = (head: string, elements: readonly { text: string; fields: Segments[] }[], first: Segments[]) => {
    lines.push({ text: head, fields: first })
    elements.forEach((e, i) => lines.push({ text: `  ${e.text}${i < elements.length - 1 ? ',' : ''}`, fields: e.fields }))
    lines.push({ text: 'end-set', fields: [] }, { text: '!', fields: [] })
  }
  empty(rp, at0)

  // ---- prefix sets: a list's IPv4 and IPv6 entries in one set, by their positions
  empty(rp.prefixLists, [...at0, 'prefixLists'])
  for (const family of ['ipv4', 'ipv6'] as const) empty(rp.prefixLists?.[family], [...at0, 'prefixLists', family])
  const names = [...new Set([...Object.keys(rp.prefixLists?.ipv4 ?? {}), ...Object.keys(rp.prefixLists?.ipv6 ?? {})])]
  for (const name of names) {
    const lists = (['ipv4', 'ipv6'] as const).flatMap((family) => (rp.prefixLists?.[family] && Object.hasOwn(rp.prefixLists[family]!, name) ? [[family, rp.prefixLists[family]![name]] as const] : []))
    const entries = lists.flatMap(([family, list]) => Object.entries(list.entries ?? {}).map(([key, e]) => ({ family, key, e })))
    entries.sort((a, b) => Number(a.key) - Number(b.key) || (a.family === b.family ? 0 : a.family === 'ipv4' ? -1 : 1))
    const valid = (family: 'ipv4' | 'ipv6', e: PrefixListEntry) => {
      const p = parsePrefix(e?.prefix)
      const bits = family === 'ipv4' ? 32 : 128
      return e.action === 'permit' && p !== null && p.family === family && Number.isInteger(e.minLength) && Number.isInteger(e.maxLength) && p.length <= e.minLength && e.minLength <= e.maxLength && e.maxLength <= bits
    }
    const why = !RPL_NAME.test(name)
      ? 'not a set name IOS-XR takes'
      : !entries.length
        ? 'IOS-XR can\'t write a prefix set with no entries'
        : entries.some(({ family, e }) => !valid(family, e))
          ? 'an entry IOS-XR can\'t write: a prefix set only permits, a prefix of its family with lengths in range'
          : undefined
    if (why) {
      for (const [family, list] of lists) skipAll(list, [...at0, 'prefixLists', family, name], why)
      continue
    }
    for (const [family, list] of lists) if (list.description !== undefined) skip([...at0, 'prefixLists', family, name, 'description'], 'unsupported', 'IOS-XR\'s prefix sets have no description')
    const elements = entries.map(({ family, key, e }) => {
      const at = [...at0, 'prefixLists', family, name, 'entries', key]
      const length = parsePrefix(e.prefix)!.length
      const bits = family === 'ipv4' ? 32 : 128
      // As the parse reads each back: no lengths is exact, `le` and `ge` their forms, `eq` has none in the model.
      const [form, range]: [PrefixListEntry['form'], string] =
        e.minLength === length && e.maxLength === length
          ? ['exact', '']
          : e.form === 'ge-le' && e.minLength > length
            ? ['ge-le', ` ge ${e.minLength} le ${e.maxLength}`]
            : e.minLength === length
              ? ['le', ` le ${e.maxLength}`]
              : e.maxLength === bits
                ? ['ge', ` ge ${e.minLength}`]
                : e.minLength === e.maxLength
                  ? [undefined, ` eq ${e.minLength}`]
                  : ['ge-le', ` ge ${e.minLength} le ${e.maxLength}`]
      const fields: Segments[] = (['action', 'prefix', 'minLength', 'maxLength'] as const).map((leaf) => [...at, leaf])
      if (e.form !== undefined && e.form === form) fields.push([...at, 'form'])
      else if (e.form !== undefined) skip([...at, 'form'], 'not-applicable', 'IOS-XR writes a prefix\'s lengths with ge, le and eq')
      return { text: `${e.prefix}${range}`, fields }
    })
    set(`prefix-set ${name}`, elements, [])
    written.prefixSets.add(name)
  }

  // ---- community sets: each entry one community or one regex, a route matching any of them
  empty(rp.communitySets, [...at0, 'communitySets'])
  for (const [name, cs] of Object.entries(rp.communitySets ?? {})) {
    const at = [...at0, 'communitySets', name]
    const entries = Object.entries(cs.entries ?? {})
    const regexes = entries.some(([, e]) => e?.regexes !== undefined)
    const why = !RPL_NAME.test(name)
      ? 'not a set name IOS-XR takes'
      : cs.type !== undefined && cs.type !== 'standard'
        ? 'extended and large community sets aren\'t converted yet'
        : !entries.length
          ? 'IOS-XR can\'t write a community set with no entries'
          : regexes && cs.regexDialect !== 'cisco'
            ? FOREIGN_REGEX
            : entries.some(([, e]) => e?.action !== 'permit' || (e.members?.length ?? 0) + (e.regexes?.length ?? 0) !== 1 || (e.members !== undefined && xrCommunity(e.members[0]) === null) || (e.regexes !== undefined && !isXrRegex(e.regexes[0])))
              ? 'an entry IOS-XR can\'t write: a community set matches any one of its elements, so each entry permits one community or regex it has words for'
              : undefined
    if (why) {
      skipAll(cs, at, why)
      continue
    }
    const first = (['type', 'regexDialect'] as const).filter((leaf) => cs[leaf] !== undefined).map((leaf) => [...at, leaf])
    const elements = entries.map(([key, e]) => ({
      text: e.members ? xrCommunity(e.members[0])! : `ios-regex '${e.regexes![0]}'`,
      fields: [[...at, 'entries', key, 'action'], [...at, 'entries', key, e.members ? 'members' : 'regexes']]
    }))
    set(`community-set ${name}`, elements, first)
    written.communitySets.add(name)
    if (!regexes) written.settable.add(name)
  }

  // ---- AS-path sets: each entry one ios-regex, a route matching any of them
  empty(rp.asPathSets, [...at0, 'asPathSets'])
  for (const [name, aps] of Object.entries(rp.asPathSets ?? {})) {
    const at = [...at0, 'asPathSets', name]
    const entries = Object.entries(aps.entries ?? {})
    const why = !RPL_NAME.test(name)
      ? 'not a set name IOS-XR takes'
      : aps.regexDialect !== 'cisco'
        ? FOREIGN_REGEX
        : !entries.length
          ? 'IOS-XR can\'t write an AS-path set with no entries'
          : entries.some(([, e]) => e?.action !== 'permit' || !isXrRegex(e.regex))
            ? 'an entry IOS-XR can\'t write: an AS-path set matches any one of its regexes, so each entry permits one'
            : undefined
    if (why) {
      skipAll(aps, at, why)
      continue
    }
    set(`as-path-set ${name}`, entries.map(([key, e]) => ({ text: `ios-regex '${e.regex}'`, fields: [[...at, 'entries', key, 'action'], [...at, 'entries', key, 'regex']] })), [[...at, 'regexDialect']])
    written.asPathSets.add(name)
  }

  // ---- route policies, a block a term
  empty(rp.policies, [...at0, 'policies'])
  for (const [name, policy] of Object.entries(rp.policies ?? {})) {
    const at = [...at0, 'policies', name]
    if (!RPL_NAME.test(name)) {
      skipAll(policy, at, 'not a route policy name IOS-XR takes')
      continue
    }
    const terms = Object.entries(policy.terms ?? {})
    const planned = terms.map(([key, term]) => ({ key, term, plan: planTerm(name, key, term) }))
    // A source that passes undecided routes on gets a final pass (below), which is a later term too.
    const last = terms.length ? Math.max(...terms.map(([key]) => Number(key))) : 0
    const judged: Policy = policy.fallThrough === 'next-policy' && Number.isSafeInteger(last) ? { ...policy, terms: { ...policy.terms, [String(last + 1)]: { actions: { flow: 'accept' } } } } : policy
    const unsafe = planned.find((t) => typeof t.plan === 'string' && !termSkipSafe(judged, t.key))
    if (unsafe) {
      skipAll(policy, at, `left out whole: term ${unsafe.key} can't be written (${unsafe.plan as string}), and leaving it out would change what the terms after it see`)
      continue
    }
    const out: PolicyLine[] = [{ text: `route-policy ${name}`, fields: [] }]
    for (const t of planned) {
      if (typeof t.plan === 'string') skipAll(t.term, [...at, 'terms', t.key], t.plan)
      else out.push(...t.plan)
    }
    // What happens to a route no term decides. Nothing reaches the end when a written term matches every route and decides.
    const fallThrough = [...at, 'fallThrough']
    const kept = planned.filter((t) => typeof t.plan !== 'string')
    const decidesAll = kept.some((t) => Object.keys(t.term.matches ?? {}).length === 0 && (t.term.actions?.flow === 'accept' || t.term.actions?.flow === 'reject'))
    if (policy.fallThrough === 'reject' || decidesAll) skip(fallThrough, 'not-applicable', policy.fallThrough === 'reject' ? 'an IOS-XR route policy drops a route nothing passes, as the source does' : 'no route reaches it: a term matches every route and decides')
    else if (policy.fallThrough === 'next-policy') {
      skip(fallThrough, 'not-applicable', 'kept by a final pass, with a warning: an IOS-XR route policy drops a route nothing passes')
      out.push({
        text: '  pass',
        fields: [],
        warning: { severity: 'warning', category: 'semantic', code: 'iosxr.policy-fall-through', message: 'The source passes a route no term decides on to the next policy, and after the last to the protocol\'s default, where an IOS-XR route policy drops it: a final pass is added, which accepts it as BGP\'s default does. Check it where the policy isn\'t the last of a chain, or isn\'t BGP\'s.', field: fieldPath(...fallThrough) }
      })
    } else skip(fallThrough, 'unsupported', 'not a fall-through the model has')
    out.push({ text: 'end-policy', fields: [] }, { text: '!', fields: [] })
    lines.push(...out)
    written.policies.add(name)
  }

  return { lines, policies: written.policies }

  /** A term's lines (its `if` block, or top-level statements with no match), or why IOS-XR can't write it whole. */
  function planTerm(name: string, key: string, term: PolicyTerm): PolicyLine[] | string {
    const termAt = [...at0, 'policies', name, 'terms', key]
    const flow = term.actions?.flow
    if (flow !== 'accept' && flow !== 'reject') return 'a term that goes on to the next term or policy: IOS-XR would pass a route it changes'
    const later: [Segments, 'not-applicable', string][] = []
    if (term.name !== undefined) later.push([[...termAt, 'name'], 'not-applicable', 'IOS-XR\'s if blocks have no names: their order says it'])

    const conditions: { text: string; fields: Segments[] }[] = []
    const m = term.matches
    const mAt = [...termAt, 'matches']
    if (m !== undefined) {
      if (!Object.keys(m).length) later.push([mAt, 'not-applicable', 'configured empty: nothing to write'])
      for (const leaf of Object.keys(m)) if (!['prefixLists', 'prefixListMatch', 'communitySets', 'asPathSets', 'tags'].includes(leaf)) return leaf === 'routeFilters' ? 'an inline route filter: this renderer writes prefix sets' : 'a match this renderer doesn\'t write (a protocol, a neighbor or a family)'
      if (m.prefixLists !== undefined) {
        const said = (['ipv4', 'ipv6'] as const).filter((f) => m.prefixLists![f] !== undefined)
        const listed = [...new Set(said.flatMap((f) => m.prefixLists![f]!))]
        if (!said.length) later.push([[...mAt, 'prefixLists'], 'not-applicable', 'configured empty: nothing to write'])
        else {
          // One prefix set, named in every family it has entries in: `destination in` matches the whole set.
          const setName = listed[0]
          const families = (['ipv4', 'ipv6'] as const).filter((f) => rp!.prefixLists?.[f] !== undefined && Object.hasOwn(rp!.prefixLists[f]!, setName))
          if (listed.length !== 1 || !written.prefixSets.has(setName) || !families.every((f) => said.includes(f)) || !said.every((f) => m.prefixLists![f]!.length === 1)) return 'not one prefix set IOS-XR writes, named in each family it has'
          conditions.push({ text: `destination in ${setName}`, fields: said.map((f) => [...mAt, 'prefixLists', f]) })
        }
      }
      if (m.prefixListMatch !== undefined) {
        if (m.prefixListMatch !== 'exact') return 'a prefix list matched or longer: an IOS-XR prefix set says its own lengths'
        later.push([[...mAt, 'prefixListMatch'], 'not-applicable', 'IOS-XR prefix sets match as their entries say'])
      }
      for (const [leaf, sets, keyword] of [['communitySets', written.communitySets, 'community matches-any'], ['asPathSets', written.asPathSets, 'as-path in']] as const) {
        const list = m[leaf]
        if (list === undefined) continue
        if (list.length !== 1 || !sets.has(list[0])) return 'not one set IOS-XR writes'
        conditions.push({ text: `${keyword} ${list[0]}`, fields: [[...mAt, leaf]] })
      }
      if (m.tags !== undefined) {
        if (m.tags.length !== 1 || !isUint32(m.tags[0])) return 'not one tag from 0 to 4294967295'
        conditions.push({ text: `tag eq ${m.tags[0]}`, fields: [[...mAt, 'tags']] })
      }
    }

    const a = term.actions!
    const aAt = [...termAt, 'actions']
    const body: PolicyLine[] = []
    for (const leaf of Object.keys(a)) if (!['flow', 'localPreference', 'med', 'communityAdd', 'communitySet', 'communityDelete', 'asPathPrepend', 'nextHop', 'nextHopSelf', 'tag'].includes(leaf)) return 'an action this renderer doesn\'t know'
    for (const [leaf, keyword] of [['localPreference', 'local-preference'], ['med', 'med'], ['tag', 'tag']] as const) {
      const n = a[leaf]
      if (n === undefined) continue
      if (!isUint32(n)) return `not a ${keyword} from 0 to 4294967295`
      body.push({ text: `set ${keyword} ${n}`, fields: [[...aAt, leaf]] })
    }
    if (a.nextHop !== undefined && a.nextHopSelf !== undefined) return 'a next hop and next hop self both'
    if (a.nextHop !== undefined) {
      if (!isIpAddress(a.nextHop)) return 'not an IP address'
      body.push({ text: `set next-hop ${a.nextHop}`, fields: [[...aAt, 'nextHop']] })
    }
    if (a.nextHopSelf !== undefined) {
      if (a.nextHopSelf !== true) return 'next hop self that isn\'t set'
      body.push({ text: 'set next-hop self', fields: [[...aAt, 'nextHopSelf']] })
    }
    if (a.asPathPrepend !== undefined) {
      const as = a.asPathPrepend
      if (!as.length || !as.every((n) => n === as[0]) || !isAsNumber(as[0]) || as.length > 64) return 'not one AS prepended up to 64 times'
      body.push({ text: `prepend as-path ${as[0]}${as.length > 1 ? ` ${as.length}` : ''}`, fields: [[...aAt, 'asPathPrepend']] })
    }
    if (a.communityAdd !== undefined && a.communitySet !== undefined) return 'communities both added and replaced'
    // In the order the model's community actions have: deleted, then replaced, then added (the parse reads this order).
    for (const [leaf, write] of [['communityDelete', (s: string) => `delete community in ${s}`], ['communitySet', (s: string) => `set community ${s}`], ['communityAdd', (s: string) => `set community ${s} additive`]] as const) {
      const v = a[leaf]
      if (v === undefined) continue
      if (v.values !== undefined || v.sets?.length !== 1 || !written.communitySets.has(v.sets[0])) return 'IOS-XR\'s simple form names one community set it writes, not values'
      if (leaf !== 'communityDelete' && !written.settable.has(v.sets[0])) return 'a community set with a regex, which IOS-XR doesn\'t set or add'
      body.push({ text: write(v.sets[0]), fields: [[...aAt, leaf, 'sets']] })
    }
    body.push({ text: flow === 'accept' ? 'done' : 'drop', fields: [[...aAt, 'flow']] })

    for (const [field, kind, reason] of later) skip(field, kind, reason)
    if (!conditions.length) return body.map((l) => ({ ...l, text: `  ${l.text}` }))
    return [{ text: `  if ${conditions.map((c) => c.text).join(' and ')} then`, fields: conditions.flatMap((c) => c.fields) }, ...body.map((l) => ({ ...l, text: `    ${l.text}` })), { text: '  endif', fields: [] }]
  }
}
