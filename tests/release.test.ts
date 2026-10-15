// The release script's parts that don't build (scripts/release.mjs): the version's CHANGELOG section, the notes made
// from scripts/release-notes.md, the assets' names, and the upload against a scripted GitHub CLI, which never touches a
// published release. The committed CHANGELOG has the section for the
// version in package.json, and the notes fill in every placeholder.
import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error: a plain .mjs module without types
import { assets, changelogSection, readmeNotice, releaseNotes, releaseState, uploadDraft } from '../scripts/release.mjs'

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

type Gh = { status: number; stdout?: string; stderr?: string }

/** A GitHub CLI that answers each `release view --json isDraft` from `states` in turn, and records every call. */
function scriptedGh(states: ('missing' | 'draft' | 'published')[]) {
  const calls: string[][] = []
  const gh = (args: string[]): Gh => {
    calls.push(args)
    if (args[1] === 'view' && args.includes('isDraft')) {
      const state = states.shift() ?? 'published'
      if (state === 'missing') return { status: 1, stderr: 'release not found' }
      return { status: 0, stdout: JSON.stringify({ isDraft: state === 'draft' }) }
    }
    if (args[1] === 'view') return { status: 0, stdout: 'https://github.com/Suremise/dialect/releases/tag/untagged-1 ' }
    return { status: 0, stdout: '' }
  }
  const writes = (): string[] => calls.filter((c) => c[1] !== 'view').map((c) => c[1])
  return { gh, calls, writes }
}

describe('the upload', () => {
  const draft = { repo: 'Suremise/dialect', tag: 'v0.1.0', commit: 'abc123', title: 'Dialect 0.1.0', notes: 'notes.md', files: ['a.exe', 'b.html'] }

  it('creates a draft naming the commit when there is no release', () => {
    const { gh, calls, writes } = scriptedGh(['missing'])
    expect(uploadDraft(gh, draft)).toBe('https://github.com/Suremise/dialect/releases/tag/untagged-1')
    expect(writes()).toEqual(['create'])
    expect(calls.find((c) => c[1] === 'create')).toEqual(['release', 'create', 'v0.1.0', '--repo', 'Suremise/dialect', '--draft', '--target', 'abc123', '--title', 'Dialect 0.1.0', '--notes-file', 'notes.md', 'a.exe', 'b.html'])
  })

  it('gives an existing draft the notes and files, without --draft on the edit', () => {
    const { gh, calls, writes } = scriptedGh(['draft', 'draft'])
    uploadDraft(gh, draft)
    expect(writes()).toEqual(['edit', 'upload'])
    expect(calls.find((c) => c[1] === 'edit')).not.toContain('--draft')
    expect(calls.find((c) => c[1] === 'upload')).toEqual(['release', 'upload', 'v0.1.0', '--repo', 'Suremise/dialect', '--clobber', 'a.exe', 'b.html'])
  })

  it('changes nothing on a release published while the installers built', () => {
    const { gh, writes } = scriptedGh(['published'])
    expect(() => uploadDraft(gh, draft)).toThrow('v0.1.0 is already published: nothing was changed')
    expect(writes()).toEqual([])
  })

  it('uploads no files to a draft published between the edit and the upload', () => {
    const { gh, writes } = scriptedGh(['draft', 'published'])
    expect(() => uploadDraft(gh, draft)).toThrow('already published')
    expect(writes()).toEqual(['edit'])
  })

  it("tells a missing release from a failed lookup, which isn't taken for one", () => {
    expect(releaseState(() => ({ status: 1, stderr: 'release not found' }), 'Suremise/dialect', 'v0.1.0')).toBe('missing')
    expect(() => releaseState(() => ({ status: 1, stderr: 'error connecting to api.github.com' }), 'Suremise/dialect', 'v0.1.0')).toThrow('error connecting')
  })
})
