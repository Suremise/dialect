// The Docs view's documents and About's engine line, without a browser. The documents are bundled from the repo's
// files (?raw): each must be exactly the committed file, so the app never shows stale notices; `npm run licenses --
// --check` (tests/licenses.test.ts) checks the committed notices against what ships.
import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { BUNDLED, DOCS, docForLink } from '../src/help/docs'
import { engineFromUserAgent } from '../src/help/engine'

const repo = join(__dirname, '..', '..', '..')

describe('the bundled documents', () => {
  it.each(Object.entries(BUNDLED))('%s is the committed file', (file, text) => {
    expect(text).toBe(readFileSync(join(repo, file), 'utf8'))
  })

  it('has the four pages, in order, and the notices list the shipped packages', () => {
    expect(DOCS.map((d) => d.label)).toEqual(['User Guide', 'Release Notes', 'License', 'Third-Party Notices'])
    const notices = DOCS.find((d) => d.id === 'notices')!.source
    expect(notices).toMatch(/^\| \[react\]\(https:\/\/github\.com\/[^)]+\) \| 19\.[\d.]+ \| MIT \|/m)
    expect(notices).toMatch(/^\| \[marked\]\(https:\/\/[^)]+\) \| 18\.[\d.]+ \| MIT \|/m)
    expect(notices).toMatch(/^\| \[dompurify\]\(https:\/\/[^)]+\) \| 3\.[\d.]+ \| \(?MPL-2\.0 OR Apache-2\.0\)?/m)
    expect(DOCS.find((d) => d.id === 'license')!.source).toContain('MIT License')
  })

  it('finds the page a link points at, by its file', () => {
    expect(docForLink('THIRD_PARTY_NOTICES.md')?.id).toBe('notices')
    expect(docForLink('../CHANGELOG.md#unreleased')?.id).toBe('changelog')
    expect(docForLink('docs/USER_GUIDE.md')?.id).toBe('guide')
    expect(docForLink('LICENSE')?.id).toBe('license')
    expect(docForLink('docs/SPEC.md')).toBeNull()
    expect(docForLink('https://github.com/owner/LICENSE')?.id).toBe('license')
  })
})

describe("About's engine line", () => {
  const edge = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36 Edg/155.0.4283.45'
  it.each([
    [edge, 'desktop', 'WebView2 155.0.4283.45'],
    [edge, 'web', 'Microsoft Edge 155.0.4283.45'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36', 'web', 'Chrome 155.0.0.0'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0', 'web', 'Firefox 140.0'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Safari/605.1.15', 'web', 'Safari 18.4'],
    ['curl/8.0', 'web', null]
  ] as const)('%s (%s) → %s', (ua, kind, want) => {
    expect(engineFromUserAgent(ua, kind)).toBe(want)
  })
})
