// The release script's parts that don't build or upload (scripts/release.mjs): the version's CHANGELOG section, the
// notes made from scripts/release-notes.md, and the assets' names. The committed CHANGELOG has the section for the
// version in package.json, and the notes fill in every placeholder.
import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error: a plain .mjs module without types
import { assets, changelogSection, readmeNotice, releaseNotes } from '../scripts/release.mjs'

const repo = join(__dirname, '..')
const read = (file: string): string => readFileSync(join(repo, file), 'utf8')
const { version } = JSON.parse(read('package.json')) as { version: string }

describe('the release', () => {
  it("finds a version's CHANGELOG section, up to the next version's", () => {
    const changelog = '# Release Notes\n\n## 0.2.0 — 1 November 2026\n\n### Convert\n- B\n\n## 0.1.0 — 15 October 2026\r\n\r\n- A\r\n'
    expect(changelogSection(changelog, '0.2.0')).toBe('### Convert\n- B')
    expect(changelogSection(changelog, '0.1.0')).toBe('- A')
    expect(changelogSection(changelog, '0.1')).toBeNull()
    expect(changelogSection('## Unreleased\n\n- C\n', '0.3.0')).toBeNull()
  })

  it("has the package.json version's section in the committed CHANGELOG", () => {
    expect(changelogSection(read('CHANGELOG.md'), version)).toMatch(/\S/)
  })

  it('fills in every placeholder of the notes, with each asset and its SHA-256', () => {
    const names = (assets(repo, version) as { name: string }[]).map((a) => a.name)
    expect(names).toEqual([`Dialect_${version}_x64-setup.exe`, `Dialect_${version}_x64-offline-setup.exe`, 'dialect-cli.exe', 'dialect.html', 'LICENSE', 'THIRD_PARTY_NOTICES.md'])
    const checksums = names.map((name, i) => ({ name, sha256: String(i).repeat(64) }))
    const notice = readmeNotice(read('README.md'))
    expect(notice).toMatch(/^© 2026 Darren Marshall\. Dialect is independently developed/)
    const notes: string = releaseNotes(read('scripts/release-notes.md'), { version, changes: '### Convert\n- A change', checksums, notice })
    expect(notes).not.toMatch(/\{\{|\}\}/)
    expect(notes).toContain(`Dialect ${version} for Windows`)
    expect(notes).toContain("## What's new\n\n### Convert\n- A change\n")
    for (const { name, sha256 } of checksums) expect(notes).toContain(`| \`${name}\` | \`${sha256}\` |`)
    for (const name of names.slice(0, 2)) expect(notes).toContain(`| \`${name}\` |`)
    expect(notes).toContain('**Always review converted configuration before applying it to a device.**')
    expect(notes).toContain('unsigned')
    expect(notes).toContain('**More info** → **Run anyway**')
    expect(notes.trimEnd().endsWith(notice)).toBe(true)
    expect(() => releaseNotes('{{nope}}', { version, changes: '', checksums, notice })).toThrow('unknown placeholder {{nope}}')
  })
})
