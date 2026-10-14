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
 * @type {readonly { name: string, license: string, category: 'shipped' | 'build-only', why: string, decidedBy: string, date: string }[]}
 */
export const EXCEPTIONS = []

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
 * Whether an SPDX expression is satisfied when every license id passes `ok`: OR needs one side, AND both, and `X WITH
 * exception` is judged on X. Null when it isn't a valid expression ("SEE LICENSE IN …", "UNLICENSED", free text).
 */
export function satisfies(expression, ok) {
  const tokens = expression.match(/\(|\)|[^\s()]+/g) ?? []
  let at = 0
  const peek = () => tokens[at]
  const fail = () => {
    throw new SyntaxError(expression)
  }
  const primary = () => {
    const t = tokens[at++]
    if (t === '(') {
      const v = or()
      if (tokens[at++] !== ')') fail()
      return v
    }
    if (!t || /^(AND|OR|WITH|\))$/i.test(t) || !/^[A-Za-z0-9.+-]+$/.test(t) || /^(UNLICENSED|SEE)$/i.test(t)) fail()
    if (peek()?.toUpperCase() === 'WITH') {
      at++
      if (!tokens[at++]) fail()
    }
    return ok(t)
  }
  const and = () => {
    let v = primary()
    while (peek()?.toUpperCase() === 'AND') {
      at++
      v = primary() && v
    }
    return v
  }
  const or = () => {
    let v = and()
    while (peek()?.toUpperCase() === 'OR') {
      at++
      v = and() || v
    }
    return v
  }
  try {
    const v = or()
    return at === tokens.length ? v : null
  } catch {
    return null
  }
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
