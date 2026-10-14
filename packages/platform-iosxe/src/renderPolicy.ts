// The model's `routingPolicy` (model 0.5.0) → IOS lines: `ip as-path access-list`, `ip community-list`, `ip prefix-list`
// and `ipv6 prefix-list`, and `route-map`. Planned before BGP, which writes a neighbor's route map only when the policy
// it names is written, and emitted after it.
//
// A list IOS can't write in full (a name it can't take, an entry it has no words for, another dialect's regex, never
// translated) is left out whole, as a list missing an entry would match other routes, and a term naming it can't be
// written either. A policy is written term by term, each whole or not at all (the per-term rule): a term IOS can't write
// is left out whole, and the whole policy with it when that isn't safe (termSkipSafe()). A policy that passes an
// undecided route to the next policy (Junos) gets a final permit sequence that accepts it, as BGP's default does, with a
// semantic warning, since an IOS route map denies a route no sequence decides.
import { communityType, fieldPath, isAsNumber, isIpAddress, parsePrefix, termSkipSafe, type Diagnostic, type Policy, type PolicyTerm, type PrefixListEntry, type RoutingPolicy } from '@dialect/core'
import { inRange, isIpv4 } from './addresses'
import { IOS_COMMUNITY_NAMES } from './policy'

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
/** A name IOS reads back as one word. */
const isWord = (s: string) => /^[^\s"]+$/.test(s)
/**
 * A regex as IOS reads it back from its line, or null when it can't be: written bare, or in double quotes when it starts
 * or ends with a space (IOS takes the quotes off, as the parse does). One line, not empty; quotes around it are taken
 * off on reading, so a regex that is itself quoted, or needs quotes and has one inside, can't be written.
 */
export function iosRegex(s: unknown): string | null {
  if (typeof s !== 'string' || s === '' || /[\r\n]/.test(s)) return null
  if (s.trim() !== s) return s.includes('"') ? null : `"${s}"`
  return s.length >= 2 && s.startsWith('"') && s.endsWith('"') ? null : s
}
const isRegex = (s: unknown): s is string => iosRegex(s) !== null
/** Text IOS reads back the same from the end of its line (a description): one line, not empty, no space at its ends. */
const isOneLine = (s: unknown): s is string => typeof s === 'string' && s.trim() === s && s !== '' && !/[\r\n]/.test(s)
const isUint32 = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 0 && (n as number) <= 4294967295
/** A community as IOS writes it, or null for one it has no word for. */
const iosCommunity = (v: unknown): string | null => (typeof v !== 'string' ? null : Object.hasOwn(IOS_COMMUNITY_NAMES, v) ? IOS_COMMUNITY_NAMES[v] : /^\d+:\d+$/.test(v) && communityType(v) === 'standard' ? v : null)
const FOREIGN_REGEX = 'a Junos regex: regexes are never translated silently, and IOS\'s are another dialect'

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

  // ---- AS-path access lists: IOS numbers them, from 1 to 500
  empty(rp.asPathSets, [...at0, 'asPathSets'])
  for (const [name, set] of Object.entries(rp.asPathSets ?? {})) {
    const at = [...at0, 'asPathSets', name]
    const entries = Object.entries(set.entries ?? {})
    const why =
      inRange(name, 1, 500) === null
        ? 'IOS numbers its AS-path access lists from 1 to 500, and this name isn\'t one'
        : set.regexDialect !== 'cisco'
          ? FOREIGN_REGEX
          : !entries.length
            ? 'IOS can\'t write an AS-path access list with no entries'
            : entries.some(([, e]) => !isAction(e?.action) || !isRegex(e?.regex))
              ? 'an entry IOS can\'t write (a permit or deny and a one-line regex it reads back the same)'
              : undefined
    if (why) {
      skipAll(set, at, why)
      continue
    }
    entries.forEach(([key, e], i) => lines.push({ text: `ip as-path access-list ${name} ${e.action} ${iosRegex(e.regex)}`, fields: [[...at, 'entries', key, 'action'], [...at, 'entries', key, 'regex'], ...(i === 0 ? [[...at, 'regexDialect']] : [])] }))
    written.asPathSets.add(name)
  }

  // ---- community lists: standard (literal communities) or expanded (one regex an entry), named or numbered
  empty(rp.communitySets, [...at0, 'communitySets'])
  for (const [name, set] of Object.entries(rp.communitySets ?? {})) {
    const at = [...at0, 'communitySets', name]
    const entries = Object.entries(set.entries ?? {})
    const expanded = entries.some(([, e]) => e?.regexes !== undefined)
    const literal = entries.some(([, e]) => e?.members !== undefined)
    const numbered = /^\d+$/.test(name)
    const number = inRange(name, 1, 500)
    const why = !isWord(name)
      ? 'not a name IOS takes (one word)'
      : numbered && (number === null || (number <= 99) === expanded)
        ? 'IOS numbers community lists 1 to 99 (standard) and 100 to 500 (expanded), and this number isn\'t one for its kind'
        : set.type !== undefined && set.type !== 'standard'
          ? 'extended and large community lists aren\'t converted yet'
          : !entries.length
            ? 'IOS can\'t write a community list with no entries'
            : expanded && literal
              ? 'literal communities and regexes in one list: an IOS list is standard or expanded'
              : expanded && set.regexDialect !== 'cisco'
                ? FOREIGN_REGEX
                : entries.some(([, e]) => !isAction(e?.action) || (expanded ? e.regexes?.length !== 1 || !isRegex(e.regexes[0]) : !e.members?.length || e.members.some((m) => iosCommunity(m) === null)))
                  ? 'an entry IOS can\'t write: several regexes in one entry, none, or a community IOS has no word for'
                  : undefined
    if (why) {
      skipAll(set, at, why)
      continue
    }
    const head = numbered ? `ip community-list ${name}` : `ip community-list ${expanded ? 'expanded' : 'standard'} ${name}`
    entries.forEach(([key, e], i) =>
      lines.push({
        text: `${head} ${e.action} ${expanded ? iosRegex(e.regexes![0]) : e.members!.map(iosCommunity).join(' ')}`,
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
        return inRange(key, 1, 4294967294) !== null && isAction(e.action) && p !== null && p.family === family && Number.isInteger(e.minLength) && Number.isInteger(e.maxLength) && p.length <= e.minLength && e.minLength <= e.maxLength && e.maxLength <= bits
      }
      const why = !isWord(name) || name.toLowerCase() === 'sequence-number'
        ? 'not a prefix list name IOS takes'
        : !entries.length
          ? 'IOS can\'t write a prefix list with no entries'
          : entries.some(([key, e]) => !valid(key, e))
            ? 'an entry IOS can\'t write: a sequence number from 1 to 4294967294, a permit or deny, and a prefix of the family'
            : list.description !== undefined && !isOneLine(list.description)
              ? 'a description IOS can\'t write on one line'
              : undefined
      if (why) {
        skipAll(list, at, why)
        continue
      }
      const command = `${family === 'ipv4' ? 'ip' : 'ipv6'} prefix-list ${name}`
      if (list.description !== undefined) lines.push({ text: `${command} description ${list.description}`, fields: [[...at, 'description']] })
      for (const [key, e] of entries) {
        const length = parsePrefix(e.prefix)!.length
        const [form, range] =
          e.minLength === length && e.maxLength === length
            ? ['exact', '']
            : e.minLength === length
              ? ['le', ` le ${e.maxLength}`]
              : e.maxLength === bits && e.form !== 'ge-le'
                ? ['ge', ` ge ${e.minLength}`]
                : ['ge-le', ` ge ${e.minLength} le ${e.maxLength}`]
        const fields: Segments[] = (['action', 'prefix', 'minLength', 'maxLength'] as const).map((leaf) => [...at, 'entries', key, leaf])
        if (e.form === form) fields.push([...at, 'entries', key, 'form'])
        else if (e.form !== undefined) skip([...at, 'entries', key, 'form'], 'not-applicable', 'IOS writes a prefix\'s lengths with ge and le')
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
      skipAll(policy, at, 'not a route map name IOS takes (one word)')
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
      // No term key in a reason: a key of the config can be a secret's value reused (AGENTS.md).
      skipAll(policy, at, unsafe ? `left out whole: one of its terms can't be written (${unsafe.plan as string}), and leaving it out would change what the terms after it see` : 'no term IOS can write: a route map needs a sequence')
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
    if (policy.fallThrough === 'reject' || decidesAll) skip(fallThrough, 'not-applicable', policy.fallThrough === 'reject' ? 'an IOS route map denies a route no sequence permits or denies, as the source does' : 'no route reaches it: a sequence matches every route and decides')
    else if (policy.fallThrough === 'next-policy') {
      // A final permit sequence after the last written, to accept what the source passes on.
      const highest = Math.max(...kept.map((t) => Number(t.key)))
      const seq = highest + 10 <= 65535 ? highest + 10 : highest < 65535 ? 65535 : undefined
      if (seq === undefined) {
        skipAll(policy, at, 'no sequence number is left for the final permit that keeps the source\'s fall-through')
        continue
      }
      skip(fallThrough, 'not-applicable', 'kept by a final permit sequence, with a warning: an IOS route map denies a route no sequence decides')
      out.push({
        text: `route-map ${name} permit ${seq}`,
        fields: [],
        warning: { severity: 'warning', category: 'semantic', code: 'iosxe.policy-fall-through', message: 'The source passes a route no term decides on to the next policy, and after the last to the protocol\'s default, where an IOS route map denies it: a final permit sequence is added, which accepts it as BGP\'s default does. Check it where the policy isn\'t the last of a chain, or isn\'t BGP\'s.', field: fieldPath(...fallThrough) }
      })
    } else skip(fallThrough, 'unsupported', 'not a fall-through the model has')
    lines.push(...out)
    written.policies.add(name)
  }

  return { lines, policies: written.policies }

  /** A term's lines (its sequence, matches and sets), or why IOS can't write it whole. */
  function planTerm(name: string, key: string, term: PolicyTerm): PolicyLine[] | string {
    const termAt = [...at0, 'policies', name, 'terms', key]
    if (inRange(key, 0, 65535) === null) return 'not a sequence number IOS takes (0 to 65535)'
    const flow = term.actions?.flow
    if (flow !== 'accept' && flow !== 'reject') return 'IOS\'s sequences permit or deny: a term that goes on to the next term or policy isn\'t converted'
    const out: PolicyLine[] = [{ text: `route-map ${name} ${flow === 'accept' ? 'permit' : 'deny'} ${key}`, fields: [[...termAt, 'actions', 'flow']] }]
    const later: [Segments, 'not-applicable', string][] = []
    if (term.name !== undefined) later.push([[...termAt, 'name'], 'not-applicable', 'IOS route map sequences have no names: the sequence number orders them'])

    const m = term.matches
    const mAt = [...termAt, 'matches']
    if (m !== undefined) {
      if (!Object.keys(m).length) later.push([mAt, 'not-applicable', 'configured empty: nothing to write'])
      for (const leaf of Object.keys(m)) if (!['prefixLists', 'prefixListMatch', 'communitySets', 'asPathSets', 'tags'].includes(leaf)) return leaf === 'routeFilters' ? 'an inline route filter: IOS route maps match prefix lists' : 'a match IOS route maps don\'t have here (a protocol, a neighbor or a family)'
      const names = (values: readonly string[] | undefined, set: ReadonlySet<string>, what: string, line: string, field: Segments): string | undefined => {
        if (values === undefined) return undefined
        if (!values.length) return `an empty list of ${what}s, which matches nothing`
        if (!values.every((v) => set.has(v))) return `names ${what} IOS doesn't write`
        out.push({ text: `${line} ${values.join(' ')}`, fields: [field] })
        return undefined
      }
      const why =
        names(m.asPathSets, written.asPathSets, 'an AS-path access list', ' match as-path', [...mAt, 'asPathSets']) ??
        names(m.communitySets, written.communitySets, 'a community list', ' match community', [...mAt, 'communitySets']) ??
        names(m.prefixLists?.ipv4, written.ipv4, 'an IPv4 prefix list', ' match ip address prefix-list', [...mAt, 'prefixLists', 'ipv4']) ??
        names(m.prefixLists?.ipv6, written.ipv6, 'an IPv6 prefix list', ' match ipv6 address prefix-list', [...mAt, 'prefixLists', 'ipv6'])
      if (why) return why
      if (m.prefixLists !== undefined && !Object.keys(m.prefixLists).length) later.push([[...mAt, 'prefixLists'], 'not-applicable', 'configured empty: nothing to write'])
      if (m.prefixListMatch !== undefined) {
        if (m.prefixListMatch !== 'exact') return 'a prefix list matched or longer: an IOS list says its own lengths'
        later.push([[...mAt, 'prefixListMatch'], 'not-applicable', 'IOS prefix lists match as their entries say'])
      }
      if (m.tags !== undefined) {
        if (!m.tags.length || !m.tags.every(isUint32)) return 'not a list of tags from 0 to 4294967295'
        out.push({ text: ` match tag ${m.tags.join(' ')}`, fields: [[...mAt, 'tags']] })
      }
    }

    // A flow was checked above, so there are actions.
    const a = term.actions!
    const aAt = [...termAt, 'actions']
    for (const leaf of Object.keys(a)) if (!['flow', 'localPreference', 'med', 'communityAdd', 'communitySet', 'communityDelete', 'asPathPrepend', 'nextHop', 'nextHopSelf', 'tag'].includes(leaf)) return 'an action this renderer doesn\'t know'
    if (a.nextHopSelf !== undefined) return 'next hop self: IOS sets it per neighbor (next-hop-self), not in a route map'
    if (a.asPathPrepend !== undefined) {
      if (!a.asPathPrepend.length || !a.asPathPrepend.every(isAsNumber)) return 'not a list of AS numbers to prepend'
      out.push({ text: ` set as-path prepend ${a.asPathPrepend.join(' ')}`, fields: [[...aAt, 'asPathPrepend']] })
    }
    if (a.communityDelete !== undefined) {
      const d = a.communityDelete
      if (d.values !== undefined || d.sets?.length !== 1 || !written.communitySets.has(d.sets[0])) return 'IOS deletes the communities of one community list it writes (set comm-list … delete), not values'
      out.push({ text: ` set comm-list ${d.sets[0]} delete`, fields: [[...aAt, 'communityDelete', 'sets']] })
    }
    if (a.communityAdd !== undefined && a.communitySet !== undefined) return 'communities both added and replaced: IOS has one set community'
    const values = a.communityAdd ?? a.communitySet
    if (values !== undefined) {
      const leaf = a.communityAdd !== undefined ? 'communityAdd' : 'communitySet'
      if (values.sets !== undefined) return 'a community list\'s communities set on the route: IOS sets literal communities'
      const ios = (values.values ?? []).map(iosCommunity)
      if (!ios.length || ios.some((c) => c === null)) return 'a community IOS has no word for, or none'
      out.push({ text: ` set community ${ios.join(' ')}${leaf === 'communityAdd' ? ' additive' : ''}`, fields: [[...aAt, leaf, 'values']] })
    }
    if (a.nextHop !== undefined) {
      if (!isIpAddress(a.nextHop)) return 'not an IP address'
      out.push({ text: ` set ${isIpv4(a.nextHop) ? 'ip' : 'ipv6'} next-hop ${a.nextHop}`, fields: [[...aAt, 'nextHop']] })
    }
    for (const [leaf, keyword] of [['localPreference', 'local-preference'], ['med', 'metric'], ['tag', 'tag']] as const) {
      const n = a[leaf]
      if (n === undefined) continue
      if (!isUint32(n)) return `not a ${keyword} from 0 to 4294967295`
      out.push({ text: ` set ${keyword} ${n}`, fields: [[...aAt, leaf]] })
    }
    // Only once the whole term can be written: its fields are all written or all unsupported.
    for (const [field, kind, reason] of later) skip(field, kind, reason)
    return out
  }
}
