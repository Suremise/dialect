// The text steps of scripts/licenses.mjs, kept pure so tests/licenses.test.ts can check them: a license file's text with
// one kind of line ending, and whether (and how) to write a generated file over what is on disk. From Hive's
// scripts/licenseText.mjs.

/** Text with every line ending as \n: CRLF (Windows), lone CR (old Mac) and LF alike. */
export const toLf = (text) => text.replace(/\r\n?/g, '\n')

/** A license file's text as the notices quote it: \n endings, no blank lines around it. */
export const licenseText = (raw) => toLf(raw).trim()

/**
 * What to write over the generated file on disk (`existing`, null when there is none), or null to leave it alone: when
 * the content is the same but for line endings, so a run never rewrites it. A real change is written with the file's
 * own line endings: CRLF if the file on disk has them (a checkout with core.autocrlf), else \n.
 */
export function noticesToWrite(text, existing) {
  const body = toLf(text)
  if (existing != null && toLf(existing) === body) return null
  return existing != null && existing.includes('\r\n') ? body.replace(/\n/g, '\r\n') : body
}

/** The packages a generated file lists, as "name version", from its table. */
const listed = (text) =>
  new Set(toLf(text).split('\n').map((line) => /^\| (?:\[([^\]]+)\]\([^)]*\)|([^|[]+?)) \| ([^|]+?) \|/.exec(line)).filter((m) => m && m[3] !== 'Version' && !/^-+$/.test(m[3])).map((m) => `${m[1] ?? m[2]} ${m[3]}`))

/**
 * Whether a committed file (`existing`, null when there is none) is out of date against a freshly made one (`text`),
 * line endings aside: null when they match, else the packages that changed ("react 19.1.0 → 19.2.0", "new: x 1.0.0",
 * "gone: y 2.0.0"); none when only other text differs (a license text, a hand-written entry).
 */
export function noticesDrift(text, existing) {
  if (existing != null && toLf(existing) === toLf(text)) return null
  const now = listed(text)
  const before = listed(existing ?? '')
  const byName = (set, other) => {
    const map = new Map()
    for (const id of set) {
      if (other.has(id)) continue
      const at = id.lastIndexOf(' ')
      map.set(id.slice(0, at), [...(map.get(id.slice(0, at)) ?? []), id.slice(at + 1)])
    }
    return map
  }
  const added = byName(now, before)
  const removed = byName(before, now)
  const changes = []
  for (const [name, versions] of added) changes.push(removed.has(name) ? `${name} ${removed.get(name).join(', ')} → ${versions.join(', ')}` : `new: ${name} ${versions.join(', ')}`)
  for (const [name, versions] of removed) if (!added.has(name)) changes.push(`gone: ${name} ${versions.join(', ')}`)
  return { packages: changes.sort() }
}

/** What the check says when a committed file (`file`, THIRD_PARTY_NOTICES.md by default) is out of date. */
export const staleNoticesMessage = (drift, file = 'THIRD_PARTY_NOTICES.md') =>
  `${file} is out of date: run \`npm run licenses\` and commit it.${drift.packages.length ? ` Changed: ${drift.packages.join('; ')}.` : ''}`
