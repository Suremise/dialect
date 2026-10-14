// The model's `routingPolicy` (model 0.5.0) → NX-OS lines: `ip as-path access-list`, `ip community-list`, `ip
// prefix-list` and `ipv6 prefix-list`, each entry with its `seq`, and `route-map`. Planned before BGP, which writes a
// neighbor's route map only when the policy it names is written, and emitted after it. This is IOS-XE's renderer
// (packages/platform-iosxe/src/renderPolicy.ts) with NX-OS's syntax: keep the two alike.
//
// A list NX-OS can't write in full (a name it can't take, an entry it has no words for, another dialect's regex, never
// translated) is left out whole, as a list missing an entry would match other routes, and a term naming it can't be
// written either. A policy is written term by term, each whole or not at all (the per-term rule): a term NX-OS can't
// write is left out whole, and the whole policy with it when that isn't safe (termSkipSafe()). A policy that passes an
// undecided route to the next policy (Junos) gets a final permit sequence that accepts it, as BGP's default does, with a
// semantic warning, since an NX-OS route map denies a route no sequence decides.
import { communityType, fieldPath, isAsNumber, isIpAddress, parsePrefix, termSkipSafe, type Diagnostic, type Policy, type PolicyTerm, type PrefixListEntry, type RoutingPolicy } from '@dialect/core'
import { inRange, isIpv4 } from './addresses'
import { NX_COMMUNITY_NAMES } from './policy'

type Segments = readonly (string | number)[]

/** A line to write, the fields it renders, and a warning to raise on it. */
export interface PolicyLine {
  readonly text: string
  readonly fields: readonly Segments[]
  readonly warning?: Omit<Diagnostic, 'span'>
}

export interface PolicyPlan {
  readonly lines: readonly PolicyLine[]
  /** The policies written as route maps, which BGP's route maps may name. */
  readonly policies: ReadonlySet<string>
}

const isAction = (s: unknown): s is 'permit' | 'deny' => s === 'permit' || s === 'deny'
/** A name NX-OS takes and reads back as one word: up to 63 characters. */
const isWord = (s: string) => /^[^\s"]{1,63}$/.test(s)
/** A regex NX-OS writes in double quotes and reads back the same: one line, not empty, no double quote in it. */
const isRegex = (s: unknown): s is string => typeof s === 'string' && s !== '' && !/[\r\n"]/.test(s)
/** Text NX-OS reads back the same from the end of its line (a description): one line, not empty, no space at its ends. */
const isOneLine = (s: unknown): s is string => typeof s === 'string' && s.trim() === s && s !== '' && !/[\r\n]/.test(s)
const isUint32 = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 0 && (n as number) <= 4294967295
/** A list entry's sequence number: NX-OS's run from 1 to 4294967294. */
const isSeq = (key: string) => inRange(key, 1, 4294967294) !== null
/** A community as NX-OS writes it, or null for one it has no word for. */
const nxCommunity = (v: unknown): string | null => (typeof v !== 'string' ? null : Object.hasOwn(NX_COMMUNITY_NAMES, v) ? NX_COMMUNITY_NAMES[v] : /^\d+:\d+$/.test(v) && communityType(v) === 'standard' ? v : null)
const FOREIGN_REGEX = 'a Junos regex: regexes are never translated silently, and NX-OS\'s are another dialect'

/**
 * Plans the routing policy's lines. `skip` marks a field unsupported or not applicable, `skipAll` every populated leaf
 * under a path; a field written is marked by the line that carries it.
 */
export function planRoutingPolicy(rp: RoutingPolicy | undefined, skip: (field: Segments, kind: 'unsupported' | 'not-applicable', reason: string) => void, skipAll: (value: unknown, at: Segments, reason: string) => void): PolicyPlan {
  const lines: PolicyLine[] = []
  const written = { ipv4: new Set<string>(), ipv6: new Set<string>(), communitySets: new Set<string>(), asPathSets: new Set<string>(), policies: new Set<string>() }
  if (!rp) return { lines, policies: written.policies }
  const at0 = ['routingPolicy']
  const empty = (value: object | undefined, at: Segments) => {
    if (value !== undefined && !Object.keys(value).length) skip(at, 'not-applicable', 'configured empty: nothing to write')
  }
  empty(rp, at0)

  // ---- AS-path access lists, by name
  empty(rp.asPathSets, [...at0, 'asPathSets'])
  for (const [name, set] of Object.entries(rp.asPathSets ?? {})) {
    const at = [...at0, 'asPathSets', name]
    const entries = Object.entries(set.entries ?? {})
    const why = !isWord(name)
      ? 'not a name NX-OS takes (one word, up to 63 characters)'
      : set.regexDialect !== 'cisco'
        ? FOREIGN_REGEX
        : !entries.length
          ? 'NX-OS can\'t write an AS-path access list with no entries'
          : entries.some(([key, e]) => !isSeq(key) || !isAction(e?.action) || !isRegex(e?.regex))
            ? 'an entry NX-OS can\'t write (a sequence number from 1 to 4294967294, a permit or deny, and a one-line regex with no double quote)'
            : undefined
    if (why) {
      skipAll(set, at, why)
      continue
    }
    entries.forEach(([key, e], i) => lines.push({ text: `ip as-path access-list ${name} seq ${key} ${e.action} "${e.regex}"`, fields: [[...at, 'entries', key, 'action'], [...at, 'entries', key, 'regex'], ...(i === 0 ? [[...at, 'regexDialect']] : [])] }))
    written.asPathSets.add(name)
  }

  // ---- community lists: standard (literal communities) or expanded (one regex an entry)
  empty(rp.communitySets, [...at0, 'communitySets'])
  for (const [name, set] of Object.entries(rp.communitySets ?? {})) {
    const at = [...at0, 'communitySets', name]
    const entries = Object.entries(set.entries ?? {})
    const expanded = entries.some(([, e]) => e?.regexes !== undefined)
    const literal = entries.some(([, e]) => e?.members !== undefined)
    const why = !isWord(name)
      ? 'not a name NX-OS takes (one word, up to 63 characters)'
      : set.type !== undefined && set.type !== 'standard'
        ? 'extended and large community lists aren\'t converted yet'
        : !entries.length
          ? 'NX-OS can\'t write a community list with no entries'
          : expanded && literal
            ? 'literal communities and regexes in one list: an NX-OS list is standard or expanded'
            : expanded && set.regexDialect !== 'cisco'
              ? FOREIGN_REGEX
              : entries.some(([key, e]) => !isSeq(key) || !isAction(e?.action) || (expanded ? e.regexes?.length !== 1 || !isRegex(e.regexes[0]) : !e.members?.length || e.members.some((m) => nxCommunity(m) === null)))
                ? 'an entry NX-OS can\'t write: a sequence number past its range, several regexes in one entry, none, a double quote in one, or a community NX-OS has no word for'
                : undefined
    if (why) {
      skipAll(set, at, why)
      continue
    }
    entries.forEach(([key, e], i) =>
      lines.push({
        text: `ip community-list ${expanded ? 'expanded' : 'standard'} ${name} seq ${key} ${e.action} ${expanded ? `"${e.regexes![0]}"` : e.members!.map(nxCommunity).join(' ')}`,
        fields: [[...at, 'entries', key, 'action'], [...at, 'entries', key, expanded ? 'regexes' : 'members'], ...(i === 0 ? (['type', 'regexDialect'] as const).filter((leaf) => set[leaf] !== undefined).map((leaf) => [...at, leaf]) : [])]
      })
    )
    written.communitySets.add(name)
  }

  // ---- prefix lists, by their entries' sequence numbers
  empty(rp.prefixLists, [...at0, 'prefixLists'])
  for (const family of ['ipv4', 'ipv6'] as const) {
    empty(rp.prefixLists?.[family], [...at0, 'prefixLists', family])
    const bits = family === 'ipv4' ? 32 : 128
    for (const [name, list] of Object.entries(rp.prefixLists?.[family] ?? {})) {
      const at = [...at0, 'prefixLists', family, name]
      const entries = Object.entries(list.entries ?? {})
      const valid = (key: string, e: PrefixListEntry) => {
        const p = parsePrefix(e?.prefix)
        return isSeq(key) && isAction(e.action) && p !== null && p.family === family && Number.isInteger(e.minLength) && Number.isInteger(e.maxLength) && p.length <= e.minLength && e.minLength <= e.maxLength && e.maxLength <= bits
      }
      const why = !isWord(name)
        ? 'not a prefix list name NX-OS takes (one word, up to 63 characters)'
        : !entries.length
          ? 'NX-OS can\'t write a prefix list with no entries'
          : entries.some(([key, e]) => !valid(key, e))
            ? 'an entry NX-OS can\'t write: a sequence number from 1 to 4294967294, a permit or deny, and a prefix of the family'
            : list.description !== undefined && !isOneLine(list.description)
              ? 'a description NX-OS can\'t write on one line'
              : undefined
      if (why) {
        skipAll(list, at, why)
        continue
      }
      const command = `${family === 'ipv4' ? 'ip' : 'ipv6'} prefix-list ${name}`
      if (list.description !== undefined) lines.push({ text: `${command} description ${list.description}`, fields: [[...at, 'description']] })
      for (const [key, e] of entries) {
        const length = parsePrefix(e.prefix)!.length
        // One length longer than the prefix's is `eq`, unless the source wrote it as a range; `eq` is no form of the model's.
        const [form, range] =
          e.minLength === length && e.maxLength === length
            ? ['exact', '']
            : e.minLength === length
              ? ['le', ` le ${e.maxLength}`]
              : e.minLength === e.maxLength && e.form === undefined
                ? [undefined, ` eq ${e.minLength}`]
                : e.maxLength === bits && e.form !== 'ge-le'
                  ? ['ge', ` ge ${e.minLength}`]
                  : ['ge-le', ` ge ${e.minLength} le ${e.maxLength}`]
        const fields: Segments[] = (['action', 'prefix', 'minLength', 'maxLength'] as const).map((leaf) => [...at, 'entries', key, leaf])
        if (e.form !== undefined && e.form === form) fields.push([...at, 'entries', key, 'form'])
        else if (e.form !== undefined) skip([...at, 'entries', key, 'form'], 'not-applicable', 'NX-OS writes a prefix\'s lengths with ge, le and eq')
        lines.push({ text: `${command} seq ${key} ${e.action} ${e.prefix}${range}`, fields })
      }
      written[family].add(name)
    }
  }
  // ---- route maps, a sequence a term
  empty(rp.policies, [...at0, 'policies'])
  for (const [name, policy] of Object.entries(rp.policies ?? {})) {
    const at = [...at0, 'policies', name]
    if (!isWord(name)) {
      skipAll(policy, at, 'not a route map name NX-OS takes (one word, up to 63 characters)')
      continue
    }
    const terms = Object.entries(policy.terms ?? {})
    const planned = terms.map(([key, term]) => ({ key, term, plan: planTerm(name, key, term) }))
    // A source that passes undecided routes on gets a final permit (below), which is a later term too: leaving out a
    // last term that rejects would then accept what it rejected.
    const last = terms.length ? Math.max(...terms.map(([key]) => Number(key))) : 0
    const judged: Policy = policy.fallThrough === 'next-policy' && Number.isSafeInteger(last) ? { ...policy, terms: { ...policy.terms, [String(last + 1)]: { actions: { flow: 'accept' } } } } : policy
    const unsafe = planned.find((t) => typeof t.plan === 'string' && !termSkipSafe(judged, t.key))
    const kept = planned.filter((t) => typeof t.plan !== 'string')
    if (unsafe || !kept.length) {
      skipAll(policy, at, unsafe ? `left out whole: term ${unsafe.key} can't be written (${unsafe.plan as string}), and leaving it out would change what the terms after it see` : 'no term NX-OS can write: a route map needs a sequence')
      continue
    }
    const out: PolicyLine[] = []
    for (const t of planned) {
      if (typeof t.plan === 'string') skipAll(t.term, [...at, 'terms', t.key], t.plan)
      else out.push(...t.plan)
    }
    // What happens to a route no term decides. Nothing reaches the end when a written term matches every route and decides.
    const fallThrough = [...at, 'fallThrough']
    const decidesAll = kept.some((t) => Object.keys(t.term.matches ?? {}).length === 0 && (t.term.actions?.flow === 'accept' || t.term.actions?.flow === 'reject'))
    if (policy.fallThrough === 'reject' || decidesAll) skip(fallThrough, 'not-applicable', policy.fallThrough === 'reject' ? 'an NX-OS route map denies a route no sequence permits or denies, as the source does' : 'no route reaches it: a sequence matches every route and decides')
    else if (policy.fallThrough === 'next-policy') {
      // A final permit sequence after the last written, to accept what the source passes on.
      const highest = Math.max(...kept.map((t) => Number(t.key)))
      const seq = highest + 10 <= 65535 ? highest + 10 : highest < 65535 ? 65535 : undefined
      if (seq === undefined) {
        skipAll(policy, at, 'no sequence number is left for the final permit that keeps the source\'s fall-through')
        continue
      }
      skip(fallThrough, 'not-applicable', 'kept by a final permit sequence, with a warning: an NX-OS route map denies a route no sequence decides')
      out.push({
        text: `route-map ${name} permit ${seq}`,
        fields: [],
        warning: { severity: 'warning', category: 'semantic', code: 'nxos.policy-fall-through', message: 'The source passes a route no term decides on to the next policy, and after the last to the protocol\'s default, where an NX-OS route map denies it: a final permit sequence is added, which accepts it as BGP\'s default does. Check it where the policy isn\'t the last of a chain, or isn\'t BGP\'s.', field: fieldPath(...fallThrough) }
      })
    } else skip(fallThrough, 'unsupported', 'not a fall-through the model has')
    lines.push(...out)
    written.policies.add(name)
  }

  return { lines, policies: written.policies }

  /** A term's lines (its sequence, matches and sets), or why NX-OS can't write it whole. */
  function planTerm(name: string, key: string, term: PolicyTerm): PolicyLine[] | string {
    const termAt = [...at0, 'policies', name, 'terms', key]
    if (inRange(key, 0, 65535) === null) return 'not a sequence number NX-OS takes (0 to 65535)'
    const flow = term.actions?.flow
    if (flow !== 'accept' && flow !== 'reject') return 'NX-OS\'s sequences permit or deny: a term that goes on to the next term or policy isn\'t converted'
    const out: PolicyLine[] = [{ text: `route-map ${name} ${flow === 'accept' ? 'permit' : 'deny'} ${key}`, fields: [[...termAt, 'actions', 'flow']] }]
    const later: [Segments, 'not-applicable', string][] = []
    if (term.name !== undefined) later.push([[...termAt, 'name'], 'not-applicable', 'NX-OS route map sequences have no names: the sequence number orders them'])

    const m = term.matches
    const mAt = [...termAt, 'matches']
    if (m !== undefined) {
      if (!Object.keys(m).length) later.push([mAt, 'not-applicable', 'configured empty: nothing to write'])
      for (const leaf of Object.keys(m)) if (!['prefixLists', 'prefixListMatch', 'communitySets', 'asPathSets', 'tags'].includes(leaf)) return leaf === 'routeFilters' ? 'an inline route filter: NX-OS route maps match prefix lists' : 'a match NX-OS route maps don\'t have here (a protocol, a neighbor or a family)'
      const names = (values: readonly string[] | undefined, set: ReadonlySet<string>, what: string, line: string, field: Segments): string | undefined => {
        if (values === undefined) return undefined
        if (!values.length) return `an empty list of ${what}s, which matches nothing`
        if (!values.every((v) => set.has(v))) return `names ${what} NX-OS doesn't write`
        out.push({ text: `${line} ${values.join(' ')}`, fields: [field] })
        return undefined
      }
      const why =
        names(m.asPathSets, written.asPathSets, 'an AS-path access list', '  match as-path', [...mAt, 'asPathSets']) ??
        names(m.communitySets, written.communitySets, 'a community list', '  match community', [...mAt, 'communitySets']) ??
        names(m.prefixLists?.ipv4, written.ipv4, 'an IPv4 prefix list', '  match ip address prefix-list', [...mAt, 'prefixLists', 'ipv4']) ??
        names(m.prefixLists?.ipv6, written.ipv6, 'an IPv6 prefix list', '  match ipv6 address prefix-list', [...mAt, 'prefixLists', 'ipv6'])
      if (why) return why
      if (m.prefixLists !== undefined && !Object.keys(m.prefixLists).length) later.push([[...mAt, 'prefixLists'], 'not-applicable', 'configured empty: nothing to write'])
      if (m.prefixListMatch !== undefined) {
        if (m.prefixListMatch !== 'exact') return 'a prefix list matched or longer: an NX-OS list says its own lengths'
        later.push([[...mAt, 'prefixListMatch'], 'not-applicable', 'NX-OS prefix lists match as their entries say'])
      }
      if (m.tags !== undefined) {
        if (!m.tags.length || !m.tags.every(isUint32)) return 'not a list of tags from 0 to 4294967295'
        out.push({ text: `  match tag ${m.tags.join(' ')}`, fields: [[...mAt, 'tags']] })
      }
    }

    // A flow was checked above, so there are actions.
    const a = term.actions!
    const aAt = [...termAt, 'actions']
    for (const leaf of Object.keys(a)) if (!['flow', 'localPreference', 'med', 'communityAdd', 'communitySet', 'communityDelete', 'asPathPrepend', 'nextHop', 'nextHopSelf', 'tag'].includes(leaf)) return 'an action this renderer doesn\'t know'
    if (a.nextHopSelf !== undefined) return 'next hop self: NX-OS sets it per neighbor (next-hop-self), not in a route map'
    if (a.asPathPrepend !== undefined) {
      if (!a.asPathPrepend.length || !a.asPathPrepend.every(isAsNumber)) return 'not a list of AS numbers to prepend'
      out.push({ text: `  set as-path prepend ${a.asPathPrepend.join(' ')}`, fields: [[...aAt, 'asPathPrepend']] })
    }
    if (a.communityDelete !== undefined) {
      const d = a.communityDelete
      if (d.values !== undefined || d.sets?.length !== 1 || !written.communitySets.has(d.sets[0])) return 'NX-OS deletes the communities of one community list it writes (set comm-list … delete), not values'
      out.push({ text: `  set comm-list ${d.sets[0]} delete`, fields: [[...aAt, 'communityDelete', 'sets']] })
    }
    if (a.communityAdd !== undefined && a.communitySet !== undefined) return 'communities both added and replaced: NX-OS has one set community'
    const values = a.communityAdd ?? a.communitySet
    if (values !== undefined) {
      const leaf = a.communityAdd !== undefined ? 'communityAdd' : 'communitySet'
      if (values.sets !== undefined) return 'a community list\'s communities set on the route: NX-OS sets literal communities'
      const nx = (values.values ?? []).map(nxCommunity)
      if (!nx.length || nx.some((c) => c === null)) return 'a community NX-OS has no word for, or none'
      out.push({ text: `  set community ${nx.join(' ')}${leaf === 'communityAdd' ? ' additive' : ''}`, fields: [[...aAt, leaf, 'values']] })
    }
    if (a.nextHop !== undefined) {
      if (!isIpAddress(a.nextHop)) return 'not an IP address'
      out.push({ text: `  set ${isIpv4(a.nextHop) ? 'ip' : 'ipv6'} next-hop ${a.nextHop}`, fields: [[...aAt, 'nextHop']] })
    }
    for (const [leaf, keyword] of [['localPreference', 'local-preference'], ['med', 'metric'], ['tag', 'tag']] as const) {
      const n = a[leaf]
      if (n === undefined) continue
      if (!isUint32(n)) return `not a ${keyword} from 0 to 4294967295`
      out.push({ text: `  set ${keyword} ${n}`, fields: [[...aAt, leaf]] })
    }
    // Only once the whole term can be written: its fields are all written or all unsupported.
    for (const [field, kind, reason] of later) skip(field, kind, reason)
    return out
  }
}
