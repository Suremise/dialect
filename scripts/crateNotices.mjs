// The desktop app's Rust crates, for THIRD_PARTY_NOTICES.md and docs/BUILD_ONLY_PACKAGES.md (thirdPartyNotices.mjs adds
// them to the npm packages). Only crates compiled into the app ship; proc-macros, build scripts and what only they use
// run on the build machine and are build-only (docs/spike-desktop-app.md, Desktop app stack).
//
// Classified with `cargo tree`, which applies resolver 2's separate host and target features (`cargo metadata`'s merged
// resolve doesn't, and would count host-only crates such as cssparser-macros as shipped), for the Windows target:
// - **runtime**: `-e normal,no-proc-macro`, the normal dependencies, not entering a proc-macro;
// - **host-only**: the rest of `-e normal,build`, the proc-macros, build scripts and their dependencies.
// `cargo metadata` gives each crate's license, links and source folder (its license files). Both run with --locked
// against the committed Cargo.lock; cargo downloads crates it doesn't have yet.
import { execFileSync } from 'child_process'
import { existsSync, readdirSync, readFileSync } from 'fs'
import { dirname, join } from 'path'
import { licenseText } from './licenseText.mjs'

/** The products with Rust crates: the manifest of each, relative to the checkout, and the target it's built for. */
export const CRATE_PRODUCTS = { desktop: { manifest: 'apps/desktop/src-tauri/Cargo.toml', target: 'x86_64-pc-windows-msvc' } }

/**
 * Shipped crates whose notices entry comes from here, by `name@version` (a new version needs a new review), for a crate
 * that publishes no license file. `text` is a file in scripts/notices/texts with the full text, checked against the
 * crate's repository at that version; `link` its https page; `why` and `reviewedBy` as for npm's SUPPLEMENTS.
 * @type {Record<string, { text: string, link: string | null, why: string, reviewedBy: string }>}
 */
export const CRATE_SUPPLEMENTS = {
  'alloc-stdlib@0.3.0': {
    text: 'alloc-stdlib@0.3.0.txt',
    link: 'https://github.com/dropbox/rust-alloc-no-stdlib',
    why: 'the crate publishes no license file; its repository\'s LICENSE (BSD-3-Clause, Dropbox), which alloc-no-stdlib from the same repository ships',
    reviewedBy: 'JB3 (#30), against github.com/dropbox/rust-alloc-no-stdlib LICENSE and alloc-no-stdlib 3.0.0\'s copy'
  },
  'webview2-com@0.39.1': {
    text: 'webview2-com@0.39.1.txt',
    link: 'https://github.com/wravery/webview2-rs',
    why: 'the crate publishes no license file; its repository\'s LICENSE (MIT, Bill Avery)',
    reviewedBy: 'JB3 (#30), against github.com/wravery/webview2-rs LICENSE'
  },
  'webview2-com-sys@0.39.1': {
    text: 'webview2-com-sys@0.39.1.txt',
    link: 'https://github.com/wravery/webview2-rs',
    why: 'the crate publishes no license file; its repository\'s LICENSE (MIT, Bill Avery). The Microsoft WebView2 loader it links is under Other material',
    reviewedBy: 'JB3 (#30), against github.com/wravery/webview2-rs LICENSE'
  }
}

/**
 * A crate's license as an SPDX expression: Cargo's deprecated `A/B` form (still in some crates) means `A OR B`. Null for
 * none (a crate with only `license-file`).
 */
export function cargoLicense(license) {
  if (typeof license !== 'string' || !license.trim()) return null
  return license.trim().split(/\s*\/\s*/).join(' OR ')
}

/** The `name@version`s a `cargo tree --prefix none --format {p}` output lists ("name v1.2.3", "(*)" and paths aside). */
export function treeCrates(output) {
  const ids = new Set()
  for (const line of output.split(/\r?\n/)) {
    const m = /^(\S+) v(\S+)/.exec(line.trim())
    if (m) ids.add(`${m[1]}@${m[2]}`)
  }
  return ids
}

/**
 * The crates of one product, split into what ships and what is build-only, from `cargo metadata` (parsed) and the two
 * `cargo tree` outputs. The workspace's own crates (the app) are left out. Each crate: name, version, license (SPDX),
 * repository, homepage and its source folder.
 */
export function classifyCrates(metadata, runtimeTree, allTree) {
  const ours = new Set(metadata.workspace_members ?? [])
  const byId = new Map()
  for (const p of metadata.packages ?? []) if (!ours.has(p.id)) byId.set(`${p.name}@${p.version}`, p)
  const runtime = treeCrates(runtimeTree)
  const all = treeCrates(allTree)
  const crate = (id) => {
    const p = byId.get(id)
    return p && { name: p.name, version: p.version, license: cargoLicense(p.license), repository: p.repository ?? null, homepage: p.homepage ?? null, dir: p.manifest_path ? dirname(p.manifest_path) : null }
  }
  const byName = (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version, undefined, { numeric: true })
  const shipped = [...runtime].map(crate).filter(Boolean).sort(byName)
  const buildOnly = [...all].filter((id) => !runtime.has(id)).map(crate).filter(Boolean).sort(byName)
  return { shipped, buildOnly }
}

const cargo = (args, cwd) => execFileSync('cargo', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 })

/**
 * Every product's crates in the checkout at `root`, each shipped one with the products it ships in. `problems` when
 * cargo can't list them. A product whose manifest isn't in the checkout has none (the license tests' fixture checkouts).
 */
export function crateInventory(root, products = CRATE_PRODUCTS) {
  const shipped = new Map()
  const buildOnly = new Map()
  const problems = []
  for (const [product, { manifest, target }] of Object.entries(products)) {
    const path = join(root, manifest)
    if (!existsSync(path)) continue
    let found
    try {
      const metadata = JSON.parse(cargo(['metadata', '--format-version', '1', '--locked', '--manifest-path', path], root))
      const tree = (edges) => cargo(['tree', '--locked', '--manifest-path', path, '--target', target, '-e', edges, '--prefix', 'none', '--format', '{p}'], root)
      found = classifyCrates(metadata, tree('normal,no-proc-macro'), tree('normal,build'))
    } catch (error) {
      const why = error.code === 'ENOENT' ? 'cargo isn\'t installed (install Rust with rustup)' : String(error.stderr || error.message).trim().split('\n').slice(-3).join(' ')
      problems.push(`the ${product} product's Rust crates (${manifest}) can't be listed: ${why}`)
      continue
    }
    for (const c of found.shipped) {
      const id = `${c.name}@${c.version}`
      const listed = shipped.get(id) ?? { ...c, products: new Set() }
      listed.products.add(product)
      shipped.set(id, listed)
    }
    for (const c of found.buildOnly) buildOnly.set(`${c.name}@${c.version}`, c)
  }
  for (const id of shipped.keys()) buildOnly.delete(id)
  const byName = (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version, undefined, { numeric: true })
  return { shipped: [...shipped.values()].sort(byName), buildOnly: [...buildOnly.values()].sort(byName), problems }
}

/** A crate's license files (LICENSE, LICENSE-MIT, LICENSE-APACHE, COPYING, NOTICE…), with \n endings. */
export const crateLicenseFiles = (dir) =>
  readdirSync(dir)
    // LICENSE.spdx (Tauri's crates) is SPDX metadata, not a license text.
    .filter((f) => /^(licen[cs]e|copying|notice)/i.test(f) && !/\.spdx$/i.test(f))
    .sort()
    .map((f) => ({ file: f, text: licenseText(readFileSync(join(dir, f), 'utf8')) }))
    .filter((f) => f.text)

/**
 * A shipped crate's notices entry: its license files, from its supplement when it has one, else from its source.
 * `problem` when there is no full license text to give.
 */
export function crateNotice(c, noticesDir, supplements = CRATE_SUPPLEMENTS) {
  const id = `${c.name}@${c.version}`
  const supplement = supplements[id]
  if (supplement) {
    const file = join(noticesDir, 'texts', supplement.text)
    const text = existsSync(file) ? licenseText(readFileSync(file, 'utf8')) : ''
    if (!text) return { link: supplement.link, files: [], problem: `${id} (shipped crate): its supplement's text scripts/notices/texts/${supplement.text} is missing or empty` }
    return { link: supplement.link, files: [{ file: supplement.text, text }] }
  }
  const files = c.dir && existsSync(c.dir) ? crateLicenseFiles(c.dir) : []
  if (!files.some((f) => /^(licen[cs]e|copying)/i.test(f.file))) return { files, problem: `${id} (shipped crate): publishes no license file (LICENSE or COPYING) with text to give its full text: add a reviewed supplement (CRATE_SUPPLEMENTS in scripts/crateNotices.mjs)` }
  return { files }
}
