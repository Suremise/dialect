// The documents the app carries, as Hive's Docs view does: bundled at build time (Vite's ?raw) from the repo's own
// files, so the app shows exactly what was committed. tests/help.test.ts checks they are the committed files, and
// `npm run licenses -- --check` that the committed notices are current.
import changelog from '../../../../CHANGELOG.md?raw'
import guide from '../../../../docs/USER_GUIDE.md?raw'
import license from '../../../../LICENSE?raw'
import notices from '../../../../THIRD_PARTY_NOTICES.md?raw'

export type DocId = 'guide' | 'changelog' | 'license' | 'notices'

export interface Doc {
  id: DocId
  label: string
  /** The repo file it comes from: a link to it from another page opens it here. */
  file: string
  /** Markdown. */
  source: string
}

export const DOCS: readonly Doc[] = [
  { id: 'guide', label: 'User Guide', file: 'USER_GUIDE.md', source: guide },
  { id: 'changelog', label: 'Release Notes', file: 'CHANGELOG.md', source: changelog },
  { id: 'license', label: 'License', file: 'LICENSE', source: `# License\n\n\`\`\`text\n${license.trim()}\n\`\`\`\n\nDialect includes third-party software: see the [third-party notices](THIRD_PARTY_NOTICES.md).\n` },
  { id: 'notices', label: 'Third-Party Notices', file: 'THIRD_PARTY_NOTICES.md', source: notices }
]

/** The raw files, as bundled: for the check that they match the committed ones. */
export const BUNDLED = { 'docs/USER_GUIDE.md': guide, 'CHANGELOG.md': changelog, LICENSE: license, 'THIRD_PARTY_NOTICES.md': notices }

/** The page a link points at, when it is one of these files ("THIRD_PARTY_NOTICES.md", "../CHANGELOG.md#unreleased"). */
export function docForLink(href: string): Doc | null {
  const path = href.split('#')[0]
  return DOCS.find((d) => path === d.file || path.endsWith(`/${d.file}`)) ?? null
}
