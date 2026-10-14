// Field paths: how the coverage ledger and the plugins name a leaf of the model. One spelling for every path, so a
// renderer's dispositions and the core's walk of the model always agree: a segment that is an identifier is `.name`
// (`.description`), any other key is `["key"]` with JSON quoting (`["ge-0/0/0"]`, `["10.0.0.2"]`), and an array index
// is `[0]`. The first segment has no dot: `interfaces["ge-0/0/0"].description`. Plugins build paths with fieldPath(),
// never by hand.

/** One step in a path: an object key or an array index. */
export type PathSegment = string | number

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/

/** The path of a field, from its segments: `fieldPath('interfaces', 'ge-0/0/0', 'description')`. */
export function fieldPath(...segments: readonly PathSegment[]): string {
  let out = ''
  for (const s of segments) {
    if (typeof s === 'number') out += `[${s}]`
    else if (IDENTIFIER.test(s)) out += out ? `.${s}` : s
    else out += `[${JSON.stringify(s)}]`
  }
  return out
}

/** A path's segments, the inverse of fieldPath(). Throws on a string fieldPath() wouldn't make. */
export function pathSegments(path: string): PathSegment[] {
  const segments: PathSegment[] = []
  const re = /\.?([A-Za-z_$][\w$]*)|\[(\d+)\]|\[("(?:[^"\\]|\\.)*")\]/y
  let at = 0
  while (at < path.length) {
    re.lastIndex = at
    const m = re.exec(path)
    if (!m || (at === 0 && path[0] === '.') || (at > 0 && m[1] !== undefined && path[at] !== '.')) throw new SyntaxError(`Not a field path: ${path}`)
    segments.push(m[1] ?? (m[2] !== undefined ? Number(m[2]) : (JSON.parse(m[3]) as string)))
    at = re.lastIndex
  }
  if (fieldPath(...segments) !== path) throw new SyntaxError(`Not a field path: ${path}`)
  return segments
}

/** A leaf of a model: its path and value. An entry configured with nothing in it is a leaf whose value is `{}`. */
export interface Leaf {
  readonly path: string
  readonly value: string | number | boolean | readonly (string | number | boolean)[] | Readonly<Record<string, never>>
}

const isPrimitive = (v: unknown): v is string | number | boolean => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'

/**
 * Every populated leaf of a value, in key order: strings, numbers, booleans, and arrays of those (a leaf-list, one leaf).
 * Objects and arrays of objects are walked; undefined and null are not populated. An object below the top that holds no
 * leaf of its own is itself a leaf, valued `{}`: an NTP server with no options (`servers["192.0.2.1"]: {}`), an
 * interface with nothing set, is configured, and so must be accounted for like any other leaf.
 */
export function populatedLeaves(value: unknown, prefix: readonly PathSegment[] = []): Leaf[] {
  const out: Leaf[] = []
  /** Walks `v`; whether it held anything. */
  const walk = (v: unknown, at: PathSegment[]): boolean => {
    if (v === undefined || v === null) return false
    if (isPrimitive(v)) out.push({ path: fieldPath(...at), value: v })
    else if (Array.isArray(v)) {
      if (v.every(isPrimitive)) out.push({ path: fieldPath(...at), value: v as (string | number | boolean)[] })
      else v.forEach((item, i) => walk(item, [...at, i]))
    } else if (typeof v === 'object') {
      let held = false
      for (const [k, child] of Object.entries(v)) held = walk(child, [...at, k]) || held
      if (!held && at.length) out.push({ path: fieldPath(...at), value: {} })
    }
    return true
  }
  walk(value, [...prefix])
  return out
}
