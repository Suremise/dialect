// THIRD_PARTY_NOTICES.md's and docs/BUILD_ONLY_PACKAGES.md's content, made in memory, and the license check over the
// same packages (scripts/licensePolicy.mjs). scripts/licenses.mjs writes them (or, with --check, compares them with the
// committed files), and tests/licenses.test.ts checks both are up to date and the license rule holds. Adapted from
// Hive's scripts/thirdPartyNotices.mjs. It reads the checkout under `root` (package-lock.json, node_modules and the
// hand-written texts in scripts/notices): no network.
//
// What ships is worked out, not listed by hand: every package reached through the `dependencies`, `optionalDependencies`
// and `peerDependencies` of a product's workspace (PRODUCTS), through our own workspace packages, is bundled into that
// product. So a library that ends up in a bundle goes in `dependencies` of the workspace package that imports it, never
// `devDependencies` (AGENTS.md). Everything else in the lockfile is build-only.
//
// Both are worked out from package-lock.json, not from what this machine installed, so a package another platform
// installs (an optional dependency for macOS, say) is judged the same on every machine: as shipped when a product
// reaches it. What only an installed package gives (its repository link and license files) is read from node_modules;
// a shipped package that isn't installed here, or has no license file, needs a reviewed supplement (SUPPLEMENTS) or the
// check fails.
//
// The desktop app's Rust crates come from crateNotices.mjs (cargo's view of what is compiled into it), listed in their own
// section of both files and judged by the same rule.
import { existsSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { createRequire } from 'module'
import { licenseText } from './licenseText.mjs'
import { chosenLicense, declaredLicense, EXCEPTIONS, licenseProblem } from './licensePolicy.mjs'
import { CRATE_PRODUCTS, CRATE_SUPPLEMENTS, crateInventory, crateNotice } from './crateNotices.mjs'

const hostedGitInfo = createRequire(import.meta.url)('hosted-git-info')

/** The products that ship, by the workspace folder whose package.json is their root. */
export const PRODUCTS = { desktop: 'apps/desktop', web: 'apps/web', cli: 'packages/cli' }

// What a package's own license field leaves out, from its license files.
const NOTES = {}

/**
 * Shipped packages whose notices entry comes from here instead of node_modules, by `name@version` (a new version needs
 * a new review): for one that publishes no license file, or isn't installed on every platform (so the notices are the
 * same wherever they're made). `text` is a file in scripts/notices/texts with the license's full text, as reviewed;
 * `link` its https page (or null); `why` and `reviewedBy` say why it's needed and who checked the text.
 * @type {Record<string, { text: string, link: string | null, why: string, reviewedBy: string }>}
 */
export const SUPPLEMENTS = {}

/**
 * Material that ships but isn't an npm package (copied or adapted code, from B7 the installer's components), written by
 * hand in scripts/notices, shown under "Other material". Copied material that doesn't ship, such as the test configs in
 * fixtures/, isn't listed: fixtures/LICENSES/ is its attribution (docs/SPEC.md, License).
 * @type {readonly { title: string, file: string }[]}
 */
export const OTHER = [
  { title: 'NSIS (the installer)', file: 'nsis.md' },
  { title: 'nsis_tauri_utils (the installer\'s plug-in)', file: 'nsis-tauri-utils.md' },
  { title: 'Microsoft WebView2 loader (in the desktop app)', file: 'webview2-loader.md' },
  { title: 'Node.js (the runtime inside the standalone dialect.exe)', file: 'node.md' }
]

/**
 * A package's or crate's license as its entry shows it: where it offers a choice, the one Dialect takes it under
 * (chosenLicense(): MIT where offered, else the first allowed), as "MIT OR Apache-2.0, used under MIT".
 */
export function shownLicense(license, note = null) {
  const chosen = chosenLicense(license)
  return `${license ?? 'no license field; see the license text'}${chosen ? `, used under ${chosen}` : ''}${note ? `; ${note}` : ''}`
}

/**
 * A package's repository as a working `https://` browse URL, or null. Takes every form npm documents for `repository`
 * (https://docs.npmjs.com/cli/v12/configuring-npm/package-json/#repository): the string or `{ type, url, directory }`
 * (linking to the directory), the `owner/repo`, `github:`, `gist:`, `bitbucket:` and `gitlab:` shortcuts, and the
 * `git+https://`, `git+ssh://`, scp-style `git@host:`, `git://`, `ssh://` and `http(s)://` URLs, with `.git` and
 * `#commit-ish` dropped. GitHub, GitLab, Bitbucket and gists go through npm's own parser, hosted-git-info. Another host
 * keeps only an https URL (git+https too): its git://, ssh:// or http:// address may have no https page, so it gets none.
 */
export function repositoryUrl(repository) {
  const url = typeof repository === 'string' ? repository : repository?.url
  if (typeof url !== 'string' || !url.trim()) return null
  const directory = typeof repository === 'object' && typeof repository.directory === 'string' ? repository.directory.replace(/^\.?\/+|\/+$/g, '') : ''
  const hosted = hostedGitInfo.fromUrl(url.trim())
  if (hosted) {
    const link = directory && hosted.type !== 'gist' ? hosted.browse(directory, { noCommittish: true }) : hosted.browse({ noCommittish: true })
    return link?.startsWith('https://') ? link : null
  }
  const plain = url.trim().replace(/^git\+(?=https:\/\/)/, '').replace(/#.*$/, '').replace(/\.git\/?$/, '').replace(/\/+$/, '')
  if (!/^https:\/\/[^/\s]+\.[^/\s]+(\/|$)/.test(plain)) return null
  return directory ? `${plain}/${directory}` : plain
}

/** The link a package gets in the notices: its repository, else its homepage if that is https, else none. */
export function packageLink(meta) {
  const repo = repositoryUrl(meta.repository)
  if (repo) return repo
  const home = typeof meta.homepage === 'string' ? meta.homepage.trim() : ''
  return /^https:\/\/[^/\s]+\.[^/\s]+(\/|$|#)/.test(home) ? home : null
}


/** A package's license files (LICENSE, LICENCE, COPYING, NOTICE…), with \n endings. */
const licenseFiles = (dir) =>
  readdirSync(dir)
    .filter((f) => /^(licen[cs]e|copying|notice|thirdpartynotices)/i.test(f))
    .sort()
    .map((f) => ({ file: f, text: licenseText(readFileSync(join(dir, f), 'utf8')) }))
    // An empty or whitespace-only file gives no text: it's left out.
    .filter((f) => f.text)
/** Whether those include the license itself (a LICENSE or COPYING with text), not only a NOTICE. */
const hasLicenseText = (files) => files.some((f) => /^(licen[cs]e|copying)/i.test(f.file))

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))

/**
 * Where `name` resolves from the lockfile entry at `from` ("apps/app", "node_modules/a"), as Node resolves it: the
 * package's own node_modules first, then each enclosing one up to the root's. Null when the lockfile has none.
 */
function resolveInLock(packages, from, name) {
  for (let base = from; ; ) {
    const path = `${base ? `${base}/` : ''}node_modules/${name}`
    if (packages[path]) return path
    if (!base) return null
    const nested = base.lastIndexOf('/node_modules/')
    base = nested >= 0 ? base.slice(0, nested) : ''
  }
}

/**
 * Every package in the checkout at `root`, split into what ships (with the products it ships in) and what is build-only,
 * from its lockfile. Our own workspace packages are walked through, never listed. `problems`: shipped dependencies the
 * lockfile doesn't have.
 */
export function inventory(root, products = PRODUCTS, supplements = SUPPLEMENTS) {
  const lock = readJson(join(root, 'package-lock.json'))
  const packages = lock.packages ?? {}
  const isOurs = (path) => !path.split('/').includes('node_modules')
  const nameOf = (path, entry) => entry.name ?? path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length)

  const shipped = new Map()
  const problems = []
  const walked = new Set()
  function walk(path, product) {
    let entry = packages[path]
    // A workspace package, linked into node_modules: walk the workspace itself.
    if (entry?.link) {
      path = entry.resolved
      entry = packages[path]
    }
    if (!entry || walked.has(`${path}\0${product}`)) return
    walked.add(`${path}\0${product}`)
    if (!isOurs(path)) {
      const listed = shipped.get(path) ?? { path, entry, products: new Set() }
      listed.products.add(product)
      shipped.set(path, listed)
    }
    const optional = new Set([...Object.keys(entry.optionalDependencies ?? {}), ...Object.entries(entry.peerDependenciesMeta ?? {}).filter(([, m]) => m?.optional).map(([n]) => n)])
    const names = new Set([...Object.keys(entry.dependencies ?? {}), ...Object.keys(entry.optionalDependencies ?? {}), ...Object.keys(entry.peerDependencies ?? {})])
    for (const name of names) {
      // Type definitions are compile-time only.
      if (name.startsWith('@types/')) continue
      const found = resolveInLock(packages, path, name)
      if (found) walk(found, product)
      else if (!optional.has(name)) problems.push(`${name} (a dependency of ${nameOf(path, entry)}) isn't in package-lock.json: run npm install`)
    }
  }
  for (const [product, folder] of Object.entries(products)) {
    if (packages[folder]) walk(folder, product)
    else problems.push(`the ${product} product's workspace ${folder} isn't in package-lock.json: run npm install`)
  }

  /** Its license: the lockfile's (npm copies the string form there), else a legacy form from the installed package. */
  const licenseAt = (path, entry, meta) => entry.license ?? (meta ? declaredLicense(meta) : null)
  const installed = (path) => (existsSync(join(root, path, 'package.json')) ? readJson(join(root, path, 'package.json')) : null)

  const ships = new Map()
  for (const { path, entry, products: where } of shipped.values()) {
    const name = nameOf(path, entry)
    const id = `${name}@${entry.version}`
    const meta = installed(path)
    const prior = ships.get(id)
    if (prior) {
      for (const p of where) prior.products.add(p)
      continue
    }
    ships.set(id, { name, version: entry.version, license: licenseAt(path, entry, meta), products: new Set(where), dir: meta ? join(root, path) : null, meta, supplement: supplements[id] ?? null })
  }
  const buildOnly = new Map()
  for (const [path, entry] of Object.entries(packages)) {
    if (isOurs(path) || entry.link) continue
    const name = nameOf(path, entry)
    const id = `${name}@${entry.version}`
    if (ships.has(id) || buildOnly.has(id)) continue
    buildOnly.set(id, { name, version: entry.version, license: licenseAt(path, entry, entry.license ? null : installed(path)) })
  }
  const byName = (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version, undefined, { numeric: true })
  return { shipped: [...ships.values()].sort(byName), buildOnly: [...buildOnly.values()].sort(byName), problems }
}

/**
 * A shipped package's notices entry: its link and license files, from its supplement when it has one, else from the
 * installed package. `problem` when there is no full license text to give.
 */
function noticeOf(p, noticesDir) {
  const id = `${p.name}@${p.version}`
  if (p.supplement) {
    const file = join(noticesDir, 'texts', p.supplement.text)
    if (!existsSync(file)) return { link: null, files: [], problem: `${id} (shipped): its supplement's text scripts/notices/texts/${p.supplement.text} is missing` }
    const text = licenseText(readFileSync(file, 'utf8'))
    if (!text) return { link: p.supplement.link, files: [], problem: `${id} (shipped): its supplement's text scripts/notices/texts/${p.supplement.text} is empty` }
    return { link: p.supplement.link, files: [{ file: p.supplement.text, text }] }
  }
  if (!p.dir) return { link: null, files: [], problem: `${id} (shipped): isn't installed on this machine (another platform's package?), so its license text can't be read: add a reviewed supplement (SUPPLEMENTS in scripts/thirdPartyNotices.mjs)` }
  const files = licenseFiles(p.dir)
  return {
    link: packageLink(p.meta),
    files,
    ...(hasLicenseText(files) ? {} : { problem: `${id} (shipped): the package has no license file (LICENSE or COPYING) with text to give its full text: add a reviewed supplement (SUPPLEMENTS in scripts/thirdPartyNotices.mjs)` })
  }
}

const PRODUCT_NAMES = { desktop: 'desktop app', web: 'web build', cli: 'CLI' }
const productList = (products) => [...products].sort().map((p) => PRODUCT_NAMES[p] ?? p).join(', ')

/**
 * THIRD_PARTY_NOTICES.md for an inventory, with \n line endings, how many packages it lists, and the shipped packages
 * whose full license text it can't give. `noticesDir` holds the hand-written entries and supplements' texts
 * (scripts/notices).
 */
export function noticesText(inv, noticesDir, other = OTHER, crateSupplements = CRATE_SUPPLEMENTS) {
  const out = [
    '# Third-party notices',
    '',
    'Dialect is licensed under the MIT License (`LICENSE`). It includes the open-source software listed below, each under its own license, reproduced in full further down, and the other material listed at the end.',
    '',
    'Where a package or crate offers a choice of licenses, its entry says which one Dialect uses: MIT where it is offered, otherwise the first of its choices that Dialect may ship under.',
    '',
    'This file is generated by `scripts/licenses.mjs` (`npm run licenses`): never edit it by hand. Hand-written entries for material that isn\'t a package are in `scripts/notices`. Tools used only to build Dialect never ship and aren\'t listed here; they are in `docs/BUILD_ONLY_PACKAGES.md`.',
    ''
  ]
  const entries = inv.shipped.map((p) => ({ p, ...noticeOf(p, noticesDir) }))
  if (!entries.length) out.push('No third-party packages ship in Dialect yet.', '')
  else {
    out.push('| Package | Version | License | Ships in |', '|---|---|---|---|')
    for (const { p, link } of entries) out.push(`| ${link ? `[${p.name}](${link})` : p.name} | ${p.version} | ${shownLicense(p.license, NOTES[p.name])} | ${productList(p.products)} |`)
    out.push('')
    for (const { p, files } of entries) {
      out.push(`## ${p.name} ${p.version}`, '', `License: ${shownLicense(p.license, NOTES[p.name])}`, '')
      if (!files.length) out.push('Its license text is missing (see the license check).', '')
      for (const f of files) out.push(...(files.length > 1 ? [`*${f.file}*`, ''] : []), '```text', f.text, '```', '')
    }
  }
  const crates = (inv.crates?.shipped ?? []).map((c) => ({ c, ...crateNotice(c, noticesDir, crateSupplements) }))
  if (crates.length) {
    out.push(
      '# Rust crates',
      '',
      'Compiled into the desktop app. Crates that only run while it is built (proc-macros, build scripts and what they use) never ship and are listed in `docs/BUILD_ONLY_PACKAGES.md`. A license text that is the same, word for word, as one given earlier is given once and referred to.',
      '',
      '| Crate | Version | License | Ships in |',
      '|---|---|---|---|'
    )
    for (const { c } of crates) {
      const link = crateSupplements[`${c.name}@${c.version}`]?.link ?? packageLink(c)
      out.push(`| ${link ? `[${c.name}](${link})` : c.name} | ${c.version} | ${shownLicense(c.license)} | ${productList(c.products)} |`)
    }
    out.push('')
    const given = new Map()
    for (const { c, files } of crates) {
      out.push(`## ${c.name} ${c.version} (crate)`, '', `License: ${shownLicense(c.license)}`, '')
      if (!files.length) out.push('Its license text is missing (see the license check).', '')
      for (const f of files) {
        const first = given.get(f.text)
        if (first) out.push(`*${f.file}*: the same text as ${first}, above.`, '')
        else {
          given.set(f.text, `${c.name} ${c.version}'s ${f.file}`)
          out.push(...(files.length > 1 ? [`*${f.file}*`, ''] : []), '```text', f.text, '```', '')
        }
      }
    }
  }
  out.push('# Other material', '', 'Neither npm packages nor Rust crates: material Dialect includes or adapts, such as copied code, the installer\'s components and native libraries.', '')
  if (!other.length) out.push('No other third-party material ships in Dialect yet.', '')
  for (const o of other) out.push(`## ${o.title}`, '', licenseText(readFileSync(join(noticesDir, o.file), 'utf8')), '')
  return { text: out.join('\n'), packages: inv.shipped.length + crates.length, problems: [...entries, ...crates].map((e) => e.problem).filter(Boolean) }
}

/** What breaks the license rule (scripts/licensePolicy.mjs) in an inventory. */
export function licenseProblems(inv, exceptions = EXCEPTIONS) {
  const crate = (c) => ({ ...c, name: `${c.name} (crate)` })
  return [
    ...inv.shipped.map((p) => licenseProblem(p, 'shipped', exceptions)),
    ...inv.buildOnly.map((p) => licenseProblem(p, 'build-only', exceptions)),
    ...(inv.crates?.shipped ?? []).map((c) => licenseProblem(crate(c), 'shipped', exceptions)),
    ...(inv.crates?.buildOnly ?? []).map((c) => licenseProblem(crate(c), 'build-only', exceptions))
  ].filter(Boolean)
}

/** docs/BUILD_ONLY_PACKAGES.md for an inventory, with \n line endings, and how many packages it lists. */
export function buildOnlyText(inv, exceptions = EXCEPTIONS) {
  const out = [
    '# Build-only packages',
    '',
    'Every npm package installed to build, check or test Dialect that never ships in it: compilers, linters, test runners and the icon pipeline. Under the license rule (docs/SPEC.md) they may have any open-source license, GPL and LGPL included; what ships is in `THIRD_PARTY_NOTICES.md`.',
    '',
    'This file is generated by `scripts/licenses.mjs` (`npm run licenses`) from `package-lock.json`, so it lists the packages every platform installs: never edit it by hand.',
    ''
  ]
  if (!inv.buildOnly.length) out.push('None yet.', '')
  else {
    out.push('| Package | Version | License |', '|---|---|---|')
    for (const p of inv.buildOnly) {
      const excepted = exceptions.find((e) => e.name === p.name && e.category === 'build-only')
      out.push(`| ${p.name} | ${p.version} | ${p.license ?? 'none'}${excepted ? ` (allowed by exception: ${excepted.why})` : ''} |`)
    }
    out.push('')
  }
  const crates = inv.crates?.buildOnly ?? []
  if (crates.length) {
    out.push('## Rust crates', '', 'Crates that run only on the build machine while the desktop app is built: proc-macros, build scripts and what they use.', '', '| Crate | Version | License |', '|---|---|---|')
    for (const c of crates) out.push(`| ${c.name} | ${c.version} | ${c.license ?? 'none'} |`)
    out.push('')
  }
  return { text: out.join('\n'), packages: inv.buildOnly.length + crates.length }
}

/**
 * Both generated files for the checkout at `root`, and every problem: shipped dependencies missing from the lockfile,
 * shipped packages without a full license text, and packages that break the license rule.
 */
export function generateLicenses(root, { products = PRODUCTS, noticesDir = join(root, 'scripts', 'notices'), exceptions = EXCEPTIONS, supplements = SUPPLEMENTS, other = OTHER, crates = CRATE_PRODUCTS, crateSupplements = CRATE_SUPPLEMENTS } = {}) {
  const crateInv = crateInventory(root, crates)
  const inv = { ...inventory(root, products, supplements), crates: crateInv }
  inv.problems = [...inv.problems, ...crateInv.problems]
  const notices = noticesText(inv, noticesDir, other, crateSupplements)
  return { inventory: inv, notices, buildOnly: buildOnlyText(inv, exceptions), problems: [...inv.problems, ...notices.problems, ...licenseProblems(inv, exceptions)] }
}
