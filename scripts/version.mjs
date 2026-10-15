// Dialect's version, in every place it's written: the root package.json (what the apps and About show), each
// workspace's package.json and its @dialect/* dependencies, package-lock.json, the desktop app's tauri.conf.json (the
// installer's), Cargo.toml and Cargo.lock. They are one version, always the same (tests/version.test.ts).
//
//   npm run set-version -- 0.2.0   sets it everywhere (RELEASING.md)
//   npm run set-version            prints each place's version
import { readdirSync, readFileSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { fileURLToPath } from 'url'

const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/
const TAURI = 'apps/desktop/src-tauri/tauri.conf.json'
const CARGO_TOML = 'apps/desktop/src-tauri/Cargo.toml'
const CARGO_LOCK = 'apps/desktop/src-tauri/Cargo.lock'

const read = (root, file) => readFileSync(join(root, file), 'utf8')
const readJson = (root, file) => JSON.parse(read(root, file))
// Two-space JSON with a final newline, as npm writes package.json and package-lock.json.
const writeJson = (root, file, value) => writeFileSync(join(root, file), JSON.stringify(value, null, 2) + '\n')

/** The workspaces' folders, relative to the root: packages/* and apps/*. */
export function workspaces(root) {
  return ['packages', 'apps'].flatMap((dir) =>
    readdirSync(join(root, dir), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => `${dir}/${d.name}`)
      .filter((ws) => {
        try {
          return !!read(root, `${ws}/package.json`)
        } catch {
          return false
        }
      })
  )
}

const dialectDeps = (pkg) =>
  ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'].flatMap((field) =>
    Object.entries(pkg[field] ?? {})
      .filter(([name]) => name.startsWith('@dialect/'))
      .map(([name, range]) => ({ field, name, range }))
  )

// tauri.conf.json's top-level version (edited as text, keeping its layout), the [package] table's in Cargo.toml, and the
// dialect package's in Cargo.lock.
const TAURI_VERSION = /^(  "version": ")([^"]*)(")/m
const CARGO_TOML_VERSION = /^(\[package\][^[]*?^version = ")([^"]*)(")/m
const CARGO_LOCK_VERSION = /^(name = "dialect"\r?\nversion = ")([^"]*)(")/m

/** Every place's version, as "where: version" pairs. */
export function versions(root) {
  const found = []
  const add = (where, version) => found.push({ where, version })
  add('package.json', readJson(root, 'package.json').version)
  for (const ws of workspaces(root)) {
    const pkg = readJson(root, `${ws}/package.json`)
    add(`${ws}/package.json`, pkg.version)
    for (const d of dialectDeps(pkg)) add(`${ws}/package.json ${d.field} ${d.name}`, d.range)
  }
  const lock = readJson(root, 'package-lock.json')
  add('package-lock.json', lock.version)
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (entry.link || !('version' in entry) || !(key === '' || key.startsWith('packages/') || key.startsWith('apps/'))) continue
    add(`package-lock.json packages["${key}"]`, entry.version)
    for (const d of dialectDeps(entry)) add(`package-lock.json packages["${key}"] ${d.field} ${d.name}`, d.range)
  }
  add(TAURI, readJson(root, TAURI).version)
  add(CARGO_TOML, CARGO_TOML_VERSION.exec(read(root, CARGO_TOML))?.[2])
  add(CARGO_LOCK, CARGO_LOCK_VERSION.exec(read(root, CARGO_LOCK))?.[2])
  return found
}

/** Sets the version everywhere. */
export function setVersion(root, version) {
  if (!SEMVER.test(version)) throw new Error(`'${version}' isn't a version: give one like 0.2.0, or 0.2.0-beta.1`)
  const bump = (pkg) => {
    if ('version' in pkg) pkg.version = version
    for (const d of dialectDeps(pkg)) pkg[d.field][d.name] = version
  }
  for (const file of ['package.json', ...workspaces(root).map((ws) => `${ws}/package.json`)]) {
    const pkg = readJson(root, file)
    bump(pkg)
    writeJson(root, file, pkg)
  }
  const lock = readJson(root, 'package-lock.json')
  lock.version = version
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (!entry.link && (key === '' || key.startsWith('packages/') || key.startsWith('apps/'))) bump(entry)
  }
  writeJson(root, 'package-lock.json', lock)
  for (const [file, pattern] of [[TAURI, TAURI_VERSION], [CARGO_TOML, CARGO_TOML_VERSION], [CARGO_LOCK, CARGO_LOCK_VERSION]]) {
    const text = read(root, file)
    if (!pattern.test(text)) throw new Error(`${file}: no version to set`)
    writeFileSync(join(root, file), text.replace(pattern, `$1${version}$3`))
  }
}

// Run as a script, not when a test imports it. Windows paths compare without case.
if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const [wanted] = process.argv.slice(2)
  if (wanted) {
    setVersion(root, wanted)
    console.log(`Dialect is now ${wanted} everywhere. Run npx npm@12.2.0 install to check package-lock.json, then commit.`)
  } else {
    for (const { where, version } of versions(root)) console.log(`${version}\t${where}`)
  }
}
