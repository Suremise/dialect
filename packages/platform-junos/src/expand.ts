// Configuration groups and interface ranges, expanded into the statements they stand for before mapping, as Junos
// does when it commits: the mapper then sees `interfaces ge-0/0/1 mtu 9192` whether the source said it directly, through
// `apply-groups` or through an `interface-range`.
//
// - **Groups:** `groups G <statements>` defines a group; `apply-groups G` at a hierarchy level inherits G's statements
//   under that level, and `apply-groups-except G` stops it below a level. A wildcard word in a group (`<*>`,
//   `<ge-*>`, `<[xe][et]-*>`) matches the names the configuration has at that place, so a wildcard group adds to what
//   exists rather than creating it. What the configuration says itself wins over what it inherits, a deeper
//   `apply-groups` over a shallower one, and the first group listed over the later ones: inherited statements come
//   first, in that order, and the mapper lets a later statement supersede an earlier one.
// - **Interface ranges:** `interfaces interface-range R` names its members (`member`, `member-range A to B`) and the
//   settings each of them gets. Explicit interface settings win over the range's.
import type { StatementDisposition } from '@dialect/core'
import { startsWith, type Statement } from './statements'

/** A statement as the mapper sees it: a source statement, or one a group or an interface range stands for. */
export interface Expanded extends Statement {
  /** How it got here, for reasons: `group` (inherited) or `range` (from an interface range). */
  readonly from?: 'group' | 'range'
}

export interface Expansion {
  readonly statements: Expanded[]
  /** Dispositions for the statements that define and apply groups and ranges, which map to nothing themselves. */
  readonly dispositions: Record<string, StatementDisposition>
  /** For a statement that gave no expanded statement at all, why (a group applied nowhere, a range with no members). */
  readonly unused: Record<string, StatementDisposition>
}

const ignored = (reason: string): StatementDisposition => ({ kind: 'ignored-by-design', reason })
const unsupported = (reason?: string): StatementDisposition => (reason ? { kind: 'unsupported', reason } : { kind: 'unsupported' })

const APPLY = 'apply-groups'
const EXCEPT = 'apply-groups-except'

const key = (words: readonly string[]): string => words.join('\u0000')

/** A Junos wildcard (`<…>`, the brackets removed) as a regular expression: `*`, `?` and `[…]` classes (`[!…]` negated). */
function wildcard(pattern: string): RegExp | null {
  let source = ''
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '*') source += '.*'
    else if (c === '?') source += '.'
    else if (c === '[') {
      const close = pattern.indexOf(']', i + 1)
      if (close < 0) return null
      let body = pattern.slice(i + 1, close)
      const negated = body.startsWith('!')
      if (negated) body = body.slice(1)
      source += `[${negated ? '^' : ''}${body.replace(/[\\\]^]/g, '\\$&')}]`
      i = close
    } else source += c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
  }
  try {
    return new RegExp(`^${source}$`)
  } catch {
    return null
  }
}

const isWildcard = (word: string): boolean => word.length >= 2 && word.startsWith('<') && word.endsWith('>')

function matches(pattern: string, word: string): boolean {
  if (!isWildcard(pattern)) return pattern === word
  return wildcard(pattern.slice(1, -1))?.test(word) ?? false
}

interface Site {
  readonly path: readonly string[]
  readonly group: string
  readonly statement: Statement
  readonly order: number
}

export function expand(statements: readonly Statement[]): Expansion {
  const dispositions: Record<string, StatementDisposition> = {}
  const unused: Record<string, StatementDisposition> = {}
  /**
   * Sets a node's disposition. A node can stand for several statements (a `[ … ]` list's values): one that isn't
   * converted keeps the node unsupported, whatever the others say, so it can't be hidden behind them.
   */
  const note = (node: string, d: StatementDisposition) => {
    if (dispositions[node]?.kind !== 'unsupported') dispositions[node] = d
  }

  // ---- groups

  const groups = new Map<string, { statement: Statement; body: readonly string[] }[]>()
  const applies: Site[] = []
  const excepts: Site[] = []
  const local: Statement[] = []
  statements.forEach((s, order) => {
    const w = s.words
    if (w[0] === 'groups') {
      if (w.length < 2) note(s.node, unsupported())
      else if (w.length === 2) {
        if (!groups.has(w[1])) groups.set(w[1], [])
        note(s.node, ignored('defines a group: its statements are mapped where it is applied'))
      } else if (w.includes(APPLY) || w.includes(EXCEPT)) note(s.node, unsupported('apply-groups inside a group'))
      else {
        const list = groups.get(w[1]) ?? []
        groups.set(w[1], list)
        list.push({ statement: s, body: w.slice(2) })
      }
    } else if (w.length >= 2 && (w[w.length - 2] === APPLY || w[w.length - 2] === EXCEPT)) {
      const site = { path: w.slice(0, -2), group: w[w.length - 1], statement: s, order }
      ;(w[w.length - 2] === APPLY ? applies : excepts).push(site)
    } else local.push(s)
  })

  for (const site of [...applies, ...excepts]) {
    const known = groups.has(site.group)
    const apply = applies.includes(site)
    note(site.statement.node, known ? ignored(apply ? "applies a group: the group's statements are mapped where they apply" : 'keeps a group from applying under its level') : unsupported('no group of that name is defined'))
  }

  // ---- interface ranges: their members first, so wildcards can match the interfaces a range configures

  /** Each range's members, ranges in the order the configuration defines them. */
  const members = new Map<string, string[]>()
  /** Splits off a list's range statements, collecting members; returns the range settings and the rest. */
  const classify = (list: readonly Expanded[]) => {
    const config: Expanded[] = []
    const rest: Expanded[] = []
    for (const s of list) {
      const w = s.words
      if (w[0] !== 'interfaces' || w[1] !== 'interface-range' || w.length < 3) {
        rest.push(s)
        continue
      }
      const own = members.get(w[2]) ?? []
      members.set(w[2], own)
      const tail = w.slice(3)
      if (!tail.length) note(s.node, ignored('names an interface range: its settings are mapped on each member'))
      else if (tail[0] === 'member' && tail.length === 2) {
        if (/[*?[\]<>]/.test(tail[1])) note(s.node, unsupported("a member pattern isn't expanded yet: name the members, or use member-range"))
        else {
          if (!own.includes(tail[1])) own.push(tail[1])
          note(s.node, ignored("names a member of an interface range: the range's settings are mapped on it"))
        }
      } else if (tail[0] === 'member-range' && tail.length === 4 && tail[2] === 'to') {
        const span = memberRange(tail[1], tail[3])
        if (!span) note(s.node, unsupported("a member range this converter can't expand: its two ends must differ only in their last number"))
        else {
          own.push(...span.filter((m) => !own.includes(m)))
          note(s.node, ignored("names members of an interface range: the range's settings are mapped on each"))
        }
      } else config.push(s)
    }
    return { config, rest }
  }
  /**
   * The settings of ranges, on each member. An interface in two ranges takes the first range's settings where they
   * differ (Juniper's inheritance priority): the later ranges' statements come first, so the first range's supersede them.
   */
  const expandRanges = (config: readonly Expanded[]): Expanded[] => {
    const order = [...members.keys()]
    const byRange = [...config].sort((a, b) => order.indexOf(b.words[2]) - order.indexOf(a.words[2]))
    return byRange.flatMap((s) => {
      const own = members.get(s.words[2]) ?? []
      if (!own.length) unused[s.node] ??= unsupported('an interface range with no members this converter can expand')
      return own.map((m): Expanded => ({ node: s.node, line: s.line, words: ['interfaces', m, ...s.words.slice(3)], from: s.from ?? 'range' }))
    })
  }

  const localRanges = classify(local)

  // The names the configuration has under each path, in order, for wildcards to match: what it configures, and the
  // interfaces its ranges name, settings or not (a range's members are interfaces).
  const children = new Map<string, string[]>()
  const addNames = (words: readonly string[]) => {
    for (let i = 0; i < words.length; i++) {
      const at = key(words.slice(0, i))
      const list = children.get(at) ?? []
      if (!list.includes(words[i])) list.push(words[i])
      children.set(at, list)
    }
  }
  const addMembers = () => {
    for (const list of members.values()) for (const m of list) addNames(['interfaces', m])
  }
  for (const s of [...localRanges.rest, ...expandRanges(localRanges.config)]) addNames(s.words)
  addMembers()

  /**
   * Per group, the wildcards at each place in its statements (by the words before them), in the group's order: an
   * object two of them match takes the first one's statements only, as Junos does.
   */
  const patterns = new Map<string, Map<string, string[]>>()
  for (const [name, list] of groups) {
    const at = new Map<string, string[]>()
    for (const { body } of list) {
      body.forEach((word, j) => {
        if (!isWildcard(word)) return
        const k = key(body.slice(0, j))
        const seen = at.get(k) ?? []
        if (!seen.includes(word)) seen.push(word)
        at.set(k, seen)
      })
    }
    patterns.set(name, at)
  }
  /** Whether `word`, at place `j` of `body`, is the first of the group's wildcards there to match `name`. */
  const firstMatch = (group: string, body: readonly string[], j: number, name: string) => {
    const word = body[j]
    if (!isWildcard(word)) return word === name
    return patterns.get(group)?.get(key(body.slice(0, j)))?.find((p) => matches(p, name)) === word
  }

  /** The statements a group statement's words stand for under `path`: its wildcards resolved against the configuration. */
  const resolve = (group: string, body: readonly string[], path: readonly string[]): string[][] => {
    if (body.length < path.length || !path.every((w, i) => firstMatch(group, body, i, w))) return []
    let resolved: string[][] = [[...path]]
    for (let j = path.length; j < body.length; j++) {
      const word = body[j]
      if (!isWildcard(word)) {
        for (const r of resolved) r.push(word)
        continue
      }
      resolved = resolved.flatMap((r) => (children.get(key(r)) ?? []).filter((name) => name !== APPLY && name !== EXCEPT && name !== 'interface-range' && firstMatch(group, body, j, name)).map((name) => [...r, name]))
      if (!resolved.length) return []
    }
    return resolved
  }

  // Lowest priority first: shallower levels, then later groups at a level; within a group, what its wildcards give
  // before what it names outright.
  const sites = [...applies].sort((a, b) => a.path.length - b.path.length || b.order - a.order)
  const inheritAll = (): Expanded[] => {
    const out: Expanded[] = []
    for (const site of sites) {
      const list = groups.get(site.group) ?? []
      const ordered = [...list.filter((g) => g.body.some(isWildcard)), ...list.filter((g) => !g.body.some(isWildcard))]
      for (const { statement, body } of ordered) {
        for (const words of resolve(site.group, body, site.path)) {
          if (excepts.some((e) => e.group === site.group && startsWith(words, e.path) && startsWith(e.path, site.path))) continue
          out.push({ node: statement.node, line: statement.line, words, from: 'group' })
        }
      }
    }
    return out
  }
  // Groups can name range members too, which wildcards then match: resolve once for those, then again with them.
  classify(inheritAll())
  addMembers()
  const inherited = inheritAll()
  for (const [name, list] of groups) {
    const applied = applies.some((a) => a.group === name)
    for (const { statement } of list) unused[statement.node] ??= ignored(applied ? 'in a group, but matches nothing where the group is applied' : 'in a group that is not applied')
  }

  const inheritedRanges = classify(inherited)
  return {
    statements: [...expandRanges(inheritedRanges.config), ...inheritedRanges.rest, ...expandRanges(localRanges.config), ...localRanges.rest],
    dispositions,
    unused
  }
}

/** `ge-0/0/0 to ge-0/0/3` → the four names; null unless both ends differ only in a last number, in order. */
export function memberRange(from: string, to: string): string[] | null {
  const a = /^(.*?)(\d+)$/.exec(from)
  const b = /^(.*?)(\d+)$/.exec(to)
  if (!a || !b || a[1] !== b[1]) return null
  const first = Number(a[2])
  const last = Number(b[2])
  if (last < first || last - first > 4096) return null
  return Array.from({ length: last - first + 1 }, (_, i) => `${a[1]}${first + i}`)
}
