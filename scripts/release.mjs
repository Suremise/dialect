// Builds every asset of the version in package.json and uploads them to a DRAFT GitHub release v<version> of
// Suremise/dialect, with notes made from scripts/release-notes.md and the version's CHANGELOG section. Uses the GitHub
// CLI's login. Nothing reaches users until Darren reviews the draft on GitHub and publishes it. See RELEASING.md.
//
//   npm run release              checks, builds, and creates or updates the draft
//   npm run release -- --dry-run checks and builds into dist/release/v<version>, touching nothing on GitHub
import { execFileSync, spawnSync } from 'child_process'
import { createHash } from 'crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { versions } from './version.mjs'

export const REPO = 'Suremise/dialect'

/** The release's assets, in the order the notes list them: where each is built, and its name on the release. */
export function assets(root, version) {
  const nsis = join(root, 'apps', 'desktop', 'src-tauri', 'target', 'release', 'bundle', 'nsis')
  return [
    { name: `Dialect_${version}_x64-setup.exe`, from: join(nsis, `Dialect_${version}_x64-setup.exe`) },
    { name: `Dialect_${version}_x64-offline-setup.exe`, from: join(nsis, `Dialect_${version}_x64-offline-setup.exe`) },
    { name: 'dialect-cli.exe', from: join(root, 'packages', 'cli', 'dist', 'dialect.exe') },
    { name: 'dialect.html', from: join(root, 'apps', 'web', 'dist', 'dialect.html') },
    { name: 'LICENSE', from: join(root, 'LICENSE') },
    { name: 'THIRD_PARTY_NOTICES.md', from: join(root, 'THIRD_PARTY_NOTICES.md') }
  ]
}

/** The body of the CHANGELOG's `## <version> — <date>` section, or null if it has none. */
export function changelogSection(changelog, version) {
  const lines = changelog.replaceAll('\r\n', '\n').split('\n')
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const start = lines.findIndex((l) => new RegExp(`^## ${escaped} — \\S`).test(l))
  if (start < 0) return null
  const end = lines.findIndex((l, i) => i > start && l.startsWith('## '))
  return lines
    .slice(start + 1, end < 0 ? undefined : end)
    .join('\n')
    .trim()
}

/** README.md's Trademarks section: the copyright and the independence notice, as About shows it. */
export function readmeNotice(readme) {
  return /^## Trademarks\n\n([\s\S]*?)\n\n## /m.exec(readme.replaceAll('\r\n', '\n'))?.[1].replaceAll('\n', ' ') ?? null
}

/** The release notes: the template with the version, its changes, each asset's SHA-256 and the notice filled in. */
export function releaseNotes(template, { version, changes, checksums, notice }) {
  const fill = {
    version,
    setup: `Dialect_${version}_x64-setup.exe`,
    offline: `Dialect_${version}_x64-offline-setup.exe`,
    // The changelog's own ### headings sit under the notes' ## What's new.
    changes,
    checksums: checksums.map(({ name, sha256 }) => `| \`${name}\` | \`${sha256}\` |`).join('\n'),
    notice
  }
  return template.replaceAll('\r\n', '\n').replace(/\{\{(\w+)\}\}/g, (all, key) => {
    if (!(key in fill)) throw new Error(`release-notes.md: unknown placeholder ${all}`)
    return fill[key]
  })
}

export const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')

function main() {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const dryRun = process.argv.includes('--dry-run')
  const fail = (message) => {
    console.error(`release: ${message}`)
    process.exit(1)
  }
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  const gh = (...args) => spawnSync('gh', args, { cwd: root, encoding: 'utf8' })
  const npm = (command) => {
    const r = spawnSync(`npm ${command}`, { cwd: root, stdio: 'inherit', shell: true })
    if (r.status !== 0) fail(`npm ${command} failed`)
  }

  const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const tag = `v${version}`

  // Checks first: nothing is built or uploaded unless they all pass.
  if (!dryRun && gh('auth', 'status').status !== 0) fail('the GitHub CLI is not signed in. Run: gh auth login')
  const dirty = git('status', '--porcelain')
  if (dirty) fail(`commit your changes first; a release is built from a clean tree.\n${dirty}`)
  const stray = versions(root).filter((v) => v.version !== version)
  if (stray.length) fail(`not every place says ${version}: ${stray.map((v) => `${v.where} (${v.version})`).join(', ')}. Run: npm run set-version -- ${version}`)
  const changes = changelogSection(readFileSync(join(root, 'CHANGELOG.md'), 'utf8'), version)
  if (!changes) fail(`CHANGELOG.md has no "## ${version} — <date>" section: turn Unreleased into it (RELEASING.md)`)
  const notice = readmeNotice(readFileSync(join(root, 'README.md'), 'utf8'))
  if (!notice) fail('README.md has no Trademarks section for the notes')
  if (spawnSync('node', ['scripts/licenses.mjs', '--check'], { cwd: root, stdio: 'inherit' }).status !== 0) fail('the committed notices are stale: run npm run licenses and commit them')
  const commit = git('rev-parse', 'HEAD')
  if (!dryRun) {
    git('fetch', 'origin', 'main')
    if (spawnSync('git', ['merge-base', '--is-ancestor', commit, 'origin/main'], { cwd: root }).status !== 0) fail(`${commit} isn't on origin/main: release only what's pushed to main, with CI green on it`)
    const view = gh('release', 'view', tag, '--repo', REPO, '--json', 'isDraft')
    if (view.status === 0 && JSON.parse(view.stdout || '{}').isDraft !== true) fail(`${tag} is already published. Set a new version for a new release.`)
  }

  // Build: the web page, then both installers, whose build makes dialect.exe too (tauri.conf.json's beforeBuildCommand).
  console.log(`Building Dialect ${version} (${commit.slice(0, 7)})…`)
  npm('run build -w @dialect/web')
  npm('run build:installers -w @dialect/desktop')
  if (git('status', '--porcelain')) fail(`the build changed the tree; nothing was uploaded.\n${git('status', '--porcelain')}`)

  const stage = join(root, 'dist', 'release', tag)
  rmSync(stage, { recursive: true, force: true })
  mkdirSync(stage, { recursive: true })
  const checksums = []
  for (const { name, from } of assets(root, version)) {
    if (!existsSync(from)) fail(`${from} wasn't built`)
    copyFileSync(from, join(stage, name))
    checksums.push({ name, sha256: sha256(join(stage, name)) })
  }
  const notes = join(stage, 'release-notes.md')
  writeFileSync(notes, releaseNotes(readFileSync(join(root, 'scripts', 'release-notes.md'), 'utf8'), { version, changes, checksums, notice }))
  console.log(`\n${tag} in ${stage}:`)
  for (const { name, sha256: hash } of checksums) console.log(`  ${hash}  ${name}`)
  if (dryRun) {
    console.log('\n--dry-run: nothing was uploaded.')
    return
  }

  // A draft names its commit; the tag is made when Darren publishes it. An existing draft gets these files and notes.
  const files = checksums.map(({ name }) => join(stage, name))
  const run = (...args) => {
    const r = spawnSync('gh', args, { cwd: root, stdio: 'inherit' })
    if (r.status !== 0) fail(`gh ${args.slice(0, 2).join(' ')} failed`)
  }
  if (gh('release', 'view', tag, '--repo', REPO).status === 0) {
    run('release', 'edit', tag, '--repo', REPO, '--draft', '--target', commit, '--title', `Dialect ${version}`, '--notes-file', notes)
    run('release', 'upload', tag, '--repo', REPO, '--clobber', ...files)
  } else {
    run('release', 'create', tag, '--repo', REPO, '--draft', '--target', commit, '--title', `Dialect ${version}`, '--notes-file', notes, ...files)
  }
  const url = gh('release', 'view', tag, '--repo', REPO, '--json', 'url', '--jq', '.url').stdout.trim()
  console.log(`\nDraft ${tag} uploaded: ${url}\nReview it on GitHub and publish it there.`)
}

// Run as a script, not when a test imports it. Windows paths compare without case.
if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) main()
