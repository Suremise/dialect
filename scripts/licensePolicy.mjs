// The license rule (docs/SPEC.md, License), as code: what may ship and what may only be used to build. scripts/licenses.mjs
// applies it to every installed package, and tests/licenses.test.ts checks it in `npm test` and CI.
//
// Two categories for packages:
// - **Shipped** (bundled into the desktop app, the web build or the CLI): MIT or equally permissive, from
//   SHIPPED_ALLOWED. MPL-2.0 is pre-approved only while the package is used unmodified: never patch one.
// - **Build-only** (never ships: compilers, linters, test runners, the icon pipeline): any open-source license, GPL and
//   LGPL included (OPEN_SOURCE). They are listed in docs/BUILD_ONLY_PACKAGES.md, not just allowed silently.
// Anything else fails unless EXCEPTIONS records the package, its license, why, and who decided. Material copied into the
// repo that doesn't ship (fixtures/) is held to SHIPPED_ALLOWED too, by fixtureLicenses.mjs.

/** Licenses a shipped package may have (SPDX ids). */
export const SHIPPED_ALLOWED = new Set([
  'MIT', 'MIT-0', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', '0BSD', 'Zlib', 'Unicode-3.0', 'BSL-1.0', 'CC0-1.0', 'Unlicense',
  // Pre-approved when used unmodified (decided 2026-10-14).
  'MPL-2.0'
])

/** Open-source licenses (OSI-approved, plus the public-domain dedications above) a build-only package may have. */
export const OPEN_SOURCE = new Set([
  ...SHIPPED_ALLOWED,
  'BlueOak-1.0.0', 'Artistic-2.0', 'Python-2.0', 'PSF-2.0', 'BSD-1-Clause', 'UPL-1.0', 'NCSA', 'PostgreSQL', 'Unicode-DFS-2016', 'MPL-1.1',
  'EPL-1.0', 'EPL-2.0', 'CDDL-1.0', 'CDDL-1.1', 'EUPL-1.2', 'OFL-1.1', 'W3C', 'WTFPL',
  'GPL-2.0-only', 'GPL-2.0-or-later', 'GPL-3.0-only', 'GPL-3.0-or-later', 'LGPL-2.1-only', 'LGPL-2.1-or-later', 'LGPL-3.0-only',
  'LGPL-3.0-or-later', 'AGPL-3.0-only', 'AGPL-3.0-or-later',
  // Deprecated SPDX ids still found in package.json files.
  'GPL-2.0', 'GPL-2.0+', 'GPL-3.0', 'GPL-3.0+', 'LGPL-2.1', 'LGPL-2.1+', 'LGPL-3.0', 'LGPL-3.0+', 'AGPL-3.0'
])

/**
 * Packages allowed although their license fails the rule for their category. Each records the package (any version), the
 * license it was allowed with (a changed license fails again), the category, why, and who decided. Only the user decides.
 * Material that isn't a package (installer components) is recorded here too, with `notices`: its hand-written entry in
 * scripts/notices, which OTHER in thirdPartyNotices.mjs must list (tests/licenses.test.ts checks).
 * @type {readonly { name: string, license: string, category: 'shipped' | 'build-only', why: string, decidedBy: string, date: string, notices?: string }[]}
 */
export const EXCEPTIONS = [
  {
    name: 'Microsoft Edge WebView2 Runtime installers',
    license: 'LicenseRef-Microsoft-WebView2-distribution',
    category: 'shipped',
    why: "Every Dialect download must work with no prerequisites (#89): the installers carry Microsoft's WebView2 bootstrapper and offline installer, unmodified, run only on a PC without the WebView2 Runtime, as Microsoft's distribution guide allows",
    decidedBy: 'Darren Marshall',
    date: '2026-10-14',
    notices: 'webview2-installers.md'
  }
]

/** A package.json's declared license as one SPDX expression, from `license` (string or legacy object) or `licenses`. */
export function declaredLicense(meta) {
  if (typeof meta.license === 'string') return meta.license.trim() || null
  if (meta.license && typeof meta.license.type === 'string') return meta.license.type
  if (Array.isArray(meta.licenses) && meta.licenses.length) {
    const ids = meta.licenses.map((l) => (typeof l === 'string' ? l : l?.type)).filter(Boolean)
    return ids.length ? (ids.length > 1 ? `(${ids.join(' OR ')})` : ids[0]) : null
  }
  return null
}

/**
 * An SPDX expression as a tree: `{ license, exception }` for `X` or `X WITH exception`, `{ op: 'AND' | 'OR', terms }`
 * for the rest, AND binding tighter than OR. Null when it isn't a valid expression ("SEE LICENSE IN …", "UNLICENSED",
 * free text).
 */
function parseLicense(expression) {
  const tokens = expression.match(/\(|\)|[^\s()]+/g) ?? []
  let at = 0
  const peek = () => tokens[at]
  const fail = () => {
    throw new SyntaxError(expression)
  }
  const id = (t) => t && !/^(AND|OR|WITH|\(|\))$/i.test(t) && /^[A-Za-z0-9.+-]+$/.test(t) && !/^(UNLICENSED|SEE)$/i.test(t)
  const primary = () => {
    const t = tokens[at++]
    if (t === '(') {
      const v = or()
      if (tokens[at++] !== ')') fail()
      return v
    }
    if (!id(t)) fail()
    if (peek()?.toUpperCase() !== 'WITH') return { license: t, exception: null }
    at++
    const exception = tokens[at++]
    if (!id(exception)) fail()
    return { license: t, exception }
  }
  const list = (op, next) => () => {
    const terms = [next()]
    while (peek()?.toUpperCase() === op) {
      at++
      terms.push(next())
    }
    return terms.length > 1 ? { op, terms } : terms[0]
  }
  const and = list('AND', primary)
  const or = list('OR', and)
  try {
    const v = or()
    return at === tokens.length ? v : null
  } catch {
    return null
  }
}

/** Whether a parsed expression is satisfied when every license id passes `ok`. */
const holds = (node, ok) =>
  node.op === 'OR' ? node.terms.some((t) => holds(t, ok)) : node.op === 'AND' ? node.terms.every((t) => holds(t, ok)) : !!ok(node.license)

/**
 * Whether an SPDX expression is satisfied when every license id passes `ok`: OR needs one side, AND both, and `X WITH
 * exception` is judged on X. Null when it isn't a valid expression ("SEE LICENSE IN …", "UNLICENSED", free text).
 */
export function satisfies(expression, ok) {
  const tree = parseLicense(expression)
  return tree ? holds(tree, ok) : null
}

/**
 * The license terms Dialect takes a package under, when its expression offers a choice (an OR): at each OR, MIT where it
 * is offered, otherwise the first choice whose terms are all in `allowed` (decided 2026-10-14). "MIT OR Apache-2.0"
 * gives "MIT", "(MIT OR Apache-2.0) AND Unicode-3.0" gives "MIT AND Unicode-3.0". Null when it offers no choice, isn't
 * an expression, or no choice is allowed (the license check reports that).
 */
export function chosenLicense(expression, allowed = SHIPPED_ALLOWED) {
  const tree = typeof expression === 'string' ? parseLicense(expression) : null
  const offersChoice = (node) => node.op === 'OR' || (node.op === 'AND' && node.terms.some(offersChoice))
  if (!tree || !offersChoice(tree) || !holds(tree, (l) => allowed.has(l))) return null
  // Each node, with every OR decided, as the terms it is taken under.
  const choose = (node) => {
    if (!node.op) return node.exception ? `${node.license} WITH ${node.exception}` : node.license
    // With every OR decided only ANDs are left, so no brackets are needed.
    if (node.op === 'AND') return node.terms.map(choose).join(' AND ')
    const choices = node.terms.filter((t) => holds(t, (l) => allowed.has(l)))
    return choose(choices.find((t) => !t.op && t.license === 'MIT' && !t.exception) ?? choices[0])
  }
  return choose(tree)
}

/**
 * What is wrong with a package's license for its category, or null when it is allowed. `pkg`: its name, version and
 * declared license (null when it has none).
 */
export function licenseProblem(pkg, category, exceptions = EXCEPTIONS) {
  const id = `${pkg.name}@${pkg.version}`
  const excepted = exceptions.find((e) => e.name === pkg.name && e.category === category)
  if (excepted && excepted.license === (pkg.license ?? 'none')) return null
  if (!pkg.license) return `${id} (${category}): no license`
  const allowed = category === 'shipped' ? SHIPPED_ALLOWED : OPEN_SOURCE
  const verdict = satisfies(pkg.license, (l) => allowed.has(l))
  if (verdict === null) return `${id} (${category}): "${pkg.license}" isn't an SPDX license expression`
  if (verdict) return null
  return category === 'shipped'
    ? `${id} (shipped): ${pkg.license} isn't allowed in what ships (MIT or equally permissive, MPL-2.0 unmodified)`
    : `${id} (build-only): ${pkg.license} isn't an open-source license`
}
