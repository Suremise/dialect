// The license rule and the generated files (scripts/licenses.mjs): THIRD_PARTY_NOTICES.md lists what ships with full
// license texts and working https links, docs/BUILD_ONLY_PACKAGES.md lists what only builds, both are up to date, and
// a package that breaks the rule for its category fails. Checked against the repo itself and against fixture
// checkouts made in a temp folder.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error: a plain .mjs module without types
import { licenseText, noticesDrift, noticesToWrite, staleNoticesMessage, toLf } from '../scripts/licenseText.mjs'
// @ts-expect-error: a plain .mjs module without types
import { declaredLicense, licenseProblem, satisfies, SHIPPED_ALLOWED } from '../scripts/licensePolicy.mjs'
// @ts-expect-error: a plain .mjs module without types
import { buildOnlyText, generateLicenses, licenseProblems, noticesText, packageLink, repositoryUrl } from '../scripts/thirdPartyNotices.mjs'
// @ts-expect-error: a plain .mjs module without types
import { cargoLicense, classifyCrates, treeCrates } from '../scripts/crateNotices.mjs'
import { tempDir } from './tempDir'

const repo = join(__dirname, '..')
const notices = join(repo, 'scripts', 'notices')

/** Every link target in a Markdown text: [text](target) links and bare scheme://… addresses. */
const links = (text: string): string[] => [...[...text.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]), ...[...text.matchAll(/(?<![\w(])[a-z][a-z0-9+.-]*:\/\/[^\s)`>|]+/gi)].map((m) => m[0])]

type Pkg = {
  name: string
  version: string
  license?: unknown
  licenses?: unknown
  repository?: unknown
  homepage?: string
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  os?: string[]
  /** The LICENSE file's text; null for none. */
  licenseFile?: string | null
  /** False: in the lockfile only, as another platform's package is. */
  installed?: boolean
}
type Options = { optional?: string[]; supplements?: Record<string, unknown>; texts?: Record<string, string> }

/**
 * A checkout in a temp folder: an app (the one product, apps/app) depending on `shipped`'s names (and optionally on
 * `optional`'s), the packages installed in node_modules unless `installed: false`, and a lockfile listing them all
 * with their dependencies, so the ones the app doesn't reach are build-only.
 */
function checkout(shipped: string[], packages: Pkg[], { optional = [] }: Options = {}): string {
  const root = tempDir('dialect-licenses-')
  const write = (file: string, text: string) => {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, text)
  }
  const deps = (names: string[]) => Object.fromEntries(names.map((n) => [n, '*']))
  const app = { name: '@fixture/app', version: '0.0.0', dependencies: deps(shipped), optionalDependencies: deps(optional) }
  write(join(root, 'package.json'), JSON.stringify({ name: 'fixture', private: true, workspaces: ['apps/*'] }))
  write(join(root, 'apps', 'app', 'package.json'), JSON.stringify(app))
  const lock: Record<string, unknown> = { '': { name: 'fixture', workspaces: ['apps/*'] }, 'apps/app': app, 'node_modules/@fixture/app': { resolved: 'apps/app', link: true } }
  for (const { licenseFile, installed = true, ...meta } of packages) {
    if (installed) {
      write(join(root, 'node_modules', meta.name, 'package.json'), JSON.stringify(meta))
      if (licenseFile !== null) write(join(root, 'node_modules', meta.name, 'LICENSE'), licenseFile ?? `${String(meta.license)} license of ${meta.name}
`)
    }
    const { version, license, dependencies, optionalDependencies, os } = meta
    lock[`node_modules/${meta.name}`] = { version, ...(typeof license === 'string' ? { license } : {}), dependencies, optionalDependencies, os, ...(os ? { optional: true } : {}) }
  }
  write(join(root, 'package-lock.json'), JSON.stringify({ name: 'fixture', lockfileVersion: 3, packages: lock }))
  return root
}

const made: string[] = []
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const fixture = (shipped: string[], packages: Pkg[], options: Options = {}) => {
  const root = checkout(shipped, packages, options)
  made.push(root)
  // Supplements' texts go in a notices folder of the fixture's own.
  let noticesDir = notices
  if (options.texts) {
    noticesDir = join(root, 'notices')
    mkdirSync(join(noticesDir, 'texts'), { recursive: true })
    for (const [file, text] of Object.entries(options.texts)) writeFileSync(join(noticesDir, 'texts', file), text)
  }
  return generateLicenses(root, { products: { desktop: 'apps/app' }, noticesDir, exceptions: [], supplements: options.supplements ?? {}, other: [] })
}

describe('the repository', () => {
  const now = generateLicenses(repo)

  it('keeps the license rule: no shipped or build-only package breaks it', () => {
    expect(now.problems).toEqual([])
  })

  it('THIRD_PARTY_NOTICES.md and docs/BUILD_ONLY_PACKAGES.md match what scripts/licenses.mjs makes', () => {
    for (const [file, text] of [['THIRD_PARTY_NOTICES.md', now.notices.text], ['docs/BUILD_ONLY_PACKAGES.md', now.buildOnly.text]]) {
      const drift = noticesDrift(text, readFileSync(join(repo, file), 'utf8'))
      expect(drift && staleNoticesMessage(drift, file)).toBeNull()
    }
  })

  it('every link in the committed THIRD_PARTY_NOTICES.md starts with https://', () => {
    // Every link Dialect gives (the tables, the hand-written entries), but not the addresses inside a quoted license text
    // (```text blocks): those are the licenses' own words, such as Apache-2.0's http://www.apache.org/licenses/.
    const text = readFileSync(join(repo, 'THIRD_PARTY_NOTICES.md'), 'utf8')
    const found = links(text.replace(/^```text\r?\n[\s\S]*?^```$/gm, ''))
    expect(found.length).toBeGreaterThan(100)
    expect(found.filter((l) => !l.startsWith('https://'))).toEqual([])
  })

  it('lists no copied fixtures: they don\'t ship, and fixtures/LICENSES/ is their attribution', () => {
    for (const repoName of ['juniper-config-converter', 'batfish', 'cml-community']) expect(now.notices.text).not.toContain(repoName)
    expect(now.notices.text).toContain('# Other material\n\nNeither npm packages nor Rust crates: material Dialect includes or adapts, such as copied code, the installer\'s components and native libraries.\n\n## NSIS (the installer)\n')
  })

  it('lists the desktop app\'s runtime crates, with option-ext as MPL-2.0, and no proc-macro or other host-only crate', () => {
    const text = now.notices.text
    expect(text).toContain('# Rust crates\n')
    expect(text).toContain('| [option-ext](https://github.com/soc/option-ext) | 0.2.0 | MPL-2.0 | desktop app |')
    for (const crate of ['tauri', 'tauri-plugin-dialog', 'tauri-plugin-fs', 'wry', 'webview2-com']) expect(text).toMatch(new RegExp(`^\\| \\[${crate}\\]\\(https://[^)]+\\) \\| [0-9.]+ \\|`, 'm'))
    // Proc-macros and build scripts run on the build machine: build-only, never in the notices.
    for (const hostOnly of ['cssparser-macros', 'tauri-macros', 'tauri-build', 'serde_derive']) {
      expect(text).not.toMatch(new RegExp(`^(\\| \\[?${hostOnly}\\b|## ${hostOnly} )`, 'm'))
      expect(now.buildOnly.text).toMatch(new RegExp(`^\\| ${hostOnly} \\| `, 'm'))
    }
    // The app itself is ours, not a third party's.
    expect(text).not.toMatch(/^\| \[?dialect\b/m)
  })

  it('lists the installer\'s components and the WebView2 loader under other material', () => {
    for (const title of ['NSIS (the installer)', 'nsis_tauri_utils (the installer\'s plug-in)', 'Microsoft WebView2 loader (in the desktop app)']) expect(now.notices.text).toContain(`\n## ${title}\n`)
    expect(now.notices.text).toContain('ZLIB/LIBPNG LICENSE')
    // NSIS's CPL-licensed LZMA module isn't used (bundle.windows.nsis.compression is zlib), so its license isn't given.
    expect(now.notices.text).not.toContain('COMMON PUBLIC LICENSE')
  })

  it('adds each hand-written entry for other material as written', () => {
    const root = checkout([], [])
    made.push(root)
    mkdirSync(join(root, 'notices'))
    writeFileSync(join(root, 'notices', 'lib.md'), '- **Project:** copied-lib\r\n- **License:** MIT\r\n')
    const r = generateLicenses(root, { products: { desktop: 'apps/app' }, noticesDir: join(root, 'notices'), exceptions: [], supplements: {}, other: [{ title: 'copied-lib', file: 'lib.md' }] })
    expect(r.notices.text).toContain('# Other material\n\nNeither npm packages nor Rust crates: material Dialect includes or adapts, such as copied code, the installer\'s components and native libraries.\n\n## copied-lib\n\n- **Project:** copied-lib\n- **License:** MIT\n')
    expect(r.notices.text).not.toContain('No other third-party material')
  })
})

describe('the license rule (scripts/licensePolicy.mjs)', () => {
  it('fails a shipped GPL package', () => {
    const r = fixture(['gpl-lib'], [{ name: 'gpl-lib', version: '1.0.0', license: 'GPL-3.0-only' }])
    expect(r.problems).toEqual(["gpl-lib@1.0.0 (shipped): GPL-3.0-only isn't allowed in what ships (MIT or equally permissive, MPL-2.0 unmodified)"])
  })

  it('fails a build-only package with no license', () => {
    const r = fixture([], [{ name: 'no-license-tool', version: '2.0.0', licenseFile: null }])
    expect(r.problems).toEqual(['no-license-tool@2.0.0 (build-only): no license'])
    expect(r.buildOnly.text).toContain('| no-license-tool | 2.0.0 | none |')
  })

  it('passes a build-only LGPL package and lists it as build-only, not in the notices', () => {
    const r = fixture(['mit-lib'], [
      { name: 'mit-lib', version: '1.0.0', license: 'MIT' },
      { name: 'lgpl-tool', version: '3.1.0', license: 'LGPL-3.0-or-later' }
    ])
    expect(r.problems).toEqual([])
    expect(r.buildOnly.text).toContain('| lgpl-tool | 3.1.0 | LGPL-3.0-or-later |')
    expect(r.buildOnly.text).not.toContain('mit-lib')
    expect(r.notices.text).not.toContain('lgpl-tool')
    expect(r.notices.text).toContain('| mit-lib | 1.0.0 | MIT | desktop app |')
  })

  it('passes MPL-2.0 that ships (pre-approved when unmodified) and the permissive allowlist', () => {
    for (const l of ['MPL-2.0', 'Apache-2.0', 'BSD-3-Clause', 'ISC', '0BSD', 'Zlib', 'Unicode-3.0', 'BSL-1.0', 'CC0-1.0', 'Unlicense', 'MIT-0', '(MIT OR GPL-3.0-only)', 'Apache-2.0 WITH LLVM-exception'])
      expect(licenseProblem({ name: 'x', version: '1.0.0', license: l }, 'shipped', []), l).toBeNull()
    expect(SHIPPED_ALLOWED.has('LGPL-3.0-or-later')).toBe(false)
  })

  it('judges SPDX expressions: OR needs one side, AND both, WITH on its license; anything else is not an expression', () => {
    const ok = (l: string) => l === 'MIT' || l === 'Apache-2.0'
    expect(satisfies('(MIT OR GPL-3.0-only)', ok)).toBe(true)
    expect(satisfies('Apache-2.0 AND LGPL-3.0-or-later', ok)).toBe(false)
    expect(satisfies('(MIT AND (Apache-2.0 OR GPL-2.0-only))', ok)).toBe(true)
    expect(satisfies('GPL-2.0-only WITH Classpath-exception-2.0', ok)).toBe(false)
    for (const bad of ['SEE LICENSE IN LICENSE.md', 'UNLICENSED', 'MIT OR', '(MIT', 'MIT)', ''])
      expect(satisfies(bad, ok), bad).toBeNull()
    expect(licenseProblem({ name: 'x', version: '1.0.0', license: 'SEE LICENSE IN EULA.txt' }, 'build-only', [])).toBe(
      'x@1.0.0 (build-only): "SEE LICENSE IN EULA.txt" isn\'t an SPDX license expression'
    )
  })

  it('reads the legacy license forms', () => {
    expect(declaredLicense({ license: { type: 'MIT' } })).toBe('MIT')
    expect(declaredLicense({ licenses: [{ type: 'MIT' }, { type: 'Apache-2.0' }] })).toBe('(MIT OR Apache-2.0)')
    expect(declaredLicense({ licenses: ['BSD-3-Clause'] })).toBe('BSD-3-Clause')
    expect(declaredLicense({})).toBeNull()
  })

  it('an exception allows a package for its category until its license changes', () => {
    const exception = { name: 'odd', license: 'CC-BY-4.0', category: 'build-only', why: 'data, not code', decidedBy: 'the user', date: '2026-10-14' }
    expect(licenseProblem({ name: 'odd', version: '1.0.0', license: 'CC-BY-4.0' }, 'build-only', [exception])).toBeNull()
    expect(licenseProblem({ name: 'odd', version: '1.0.0', license: 'CC-BY-4.0' }, 'shipped', [exception])).not.toBeNull()
    expect(licenseProblem({ name: 'odd', version: '2.0.0', license: 'CC-BY-NC-4.0' }, 'build-only', [exception])).not.toBeNull()
  })

  it('follows dependencies through what ships, but not devDependencies or type definitions', () => {
    const r = fixture(['top'], [
      { name: 'top', version: '1.0.0', license: 'MIT', dependencies: { inner: '*', '@types/inner': '*' } },
      { name: 'inner', version: '2.0.0', license: 'ISC' },
      { name: '@types/inner', version: '2.0.0', license: 'MIT' },
      { name: 'tool', version: '9.0.0', license: 'GPL-3.0-or-later' }
    ])
    expect(r.inventory.shipped.map((p: { name: string }) => p.name)).toEqual(['inner', 'top'])
    expect(r.inventory.buildOnly.map((p: { name: string }) => p.name)).toEqual(['@types/inner', 'tool'])
    expect(r.problems).toEqual([])
  })

  it('puts each shipped package\'s full license text in the notices', () => {
    const r = fixture(['lib'], [{ name: 'lib', version: '1.0.0', license: 'MIT', licenseFile: 'MIT License\r\n\r\nCopyright (c) 2026 Someone\r\n' }])
    expect(r.notices.text).toContain('## lib 1.0.0\n\nLicense: MIT\n\n```text\nMIT License\n\nCopyright (c) 2026 Someone\n```')
  })
})

describe('what ships on another platform, and full license texts', () => {
  const mac = { os: ['darwin'], installed: false }

  it('judges an optional runtime package that only another platform installs as shipped, not build-only', () => {
    const r = fixture([], [{ name: 'other-platform-runtime', version: '1.0.0', license: 'GPL-3.0-only', ...mac }], { optional: ['other-platform-runtime'] })
    expect(r.inventory.buildOnly).toEqual([])
    expect(r.inventory.shipped.map((p: { name: string }) => p.name)).toEqual(['other-platform-runtime'])
    expect(r.problems).toContain("other-platform-runtime@1.0.0 (shipped): GPL-3.0-only isn't allowed in what ships (MIT or equally permissive, MPL-2.0 unmodified)")
    expect(r.buildOnly.text).not.toContain('other-platform-runtime')
  })

  it('follows such a package\'s own dependencies, and says when it can\'t give their license texts', () => {
    const r = fixture([], [
      { name: 'mac-runtime', version: '1.0.0', license: 'MIT', dependencies: { 'mac-helper': '*' }, ...mac },
      { name: 'mac-helper', version: '2.0.0', license: 'ISC', installed: false }
    ], { optional: ['mac-runtime'] })
    expect(r.inventory.shipped.map((p: { name: string }) => p.name)).toEqual(['mac-helper', 'mac-runtime'])
    expect(r.problems).toEqual([
      "mac-helper@2.0.0 (shipped): isn't installed on this machine (another platform's package?), so its license text can't be read: add a reviewed supplement (SUPPLEMENTS in scripts/thirdPartyNotices.mjs)",
      "mac-runtime@1.0.0 (shipped): isn't installed on this machine (another platform's package?), so its license text can't be read: add a reviewed supplement (SUPPLEMENTS in scripts/thirdPartyNotices.mjs)"
    ])
  })

  it('with a supplement, gives the same notices whether or not this machine installed the package', () => {
    const pkg = { name: 'mac-runtime', version: '1.0.0', license: 'MIT', repository: 'github:owner/mac-runtime', os: ['darwin'] }
    const options = {
      optional: ['mac-runtime'],
      supplements: { 'mac-runtime@1.0.0': { text: 'mac-runtime.txt', link: 'https://github.com/owner/mac-runtime', why: 'macOS only', reviewedBy: 'a test' } },
      texts: { 'mac-runtime.txt': 'MIT License\r\n\r\nCopyright (c) 2026 Mac Person\r\n' }
    }
    const here = fixture([], [{ ...pkg, installed: true, licenseFile: 'A different LICENSE file\n' }], options)
    const elsewhere = fixture([], [{ ...pkg, installed: false }], options)
    expect(here.problems).toEqual([])
    expect(elsewhere.problems).toEqual([])
    expect(elsewhere.notices.text).toBe(here.notices.text)
    expect(here.notices.text).toContain('| [mac-runtime](https://github.com/owner/mac-runtime) | 1.0.0 | MIT | desktop app |')
    expect(here.notices.text).toContain('```text\nMIT License\n\nCopyright (c) 2026 Mac Person\n```')
  })

  it('a dependency the lockfile doesn\'t have fails; a missing optional one doesn\'t', () => {
    const r = fixture(['lib'], [{ name: 'lib', version: '1.0.0', license: 'MIT', dependencies: { gone: '*' }, optionalDependencies: { 'not-for-here': '*' } }])
    expect(r.problems).toEqual(["gone (a dependency of lib) isn't in package-lock.json: run npm install"])
  })

  it('fails a shipped package with a license but no license file, and takes a reviewed supplement\'s text', () => {
    const bare = { name: 'bare', version: '1.0.0', license: 'MIT', licenseFile: null }
    expect(fixture(['bare'], [bare]).problems).toEqual([
      'bare@1.0.0 (shipped): the package has no license file (LICENSE or COPYING) with text to give its full text: add a reviewed supplement (SUPPLEMENTS in scripts/thirdPartyNotices.mjs)'
    ])
    const r = fixture(['bare'], [bare], {
      supplements: { 'bare@1.0.0': { text: 'bare.txt', link: null, why: 'publishes no LICENSE file', reviewedBy: 'a test' } },
      texts: { 'bare.txt': 'MIT License\n\nCopyright (c) 2026 Bare Author\n' }
    })
    expect(r.problems).toEqual([])
    expect(r.notices.text).toContain('## bare 1.0.0\n\nLicense: MIT\n\n```text\nMIT License\n\nCopyright (c) 2026 Bare Author\n```')
  })

  it('fails an empty or whitespace-only license file and supplement text, and leaves out an empty NOTICE', () => {
    const blank = ' \n\t\r\n'
    const empty = fixture(['blank'], [{ name: 'blank', version: '1.0.0', license: 'MIT', licenseFile: blank }])
    expect(empty.problems).toEqual([
      'blank@1.0.0 (shipped): the package has no license file (LICENSE or COPYING) with text to give its full text: add a reviewed supplement (SUPPLEMENTS in scripts/thirdPartyNotices.mjs)'
    ])
    expect(empty.notices.text).not.toMatch(/```text\n\s*```/)
    const supplemented = fixture(['bare'], [{ name: 'bare', version: '1.0.0', license: 'MIT', licenseFile: null }], {
      supplements: { 'bare@1.0.0': { text: 'blank.txt', link: null, why: '', reviewedBy: '' } },
      texts: { 'blank.txt': blank }
    })
    expect(supplemented.problems).toEqual(["bare@1.0.0 (shipped): its supplement's text scripts/notices/texts/blank.txt is empty"])
    expect(supplemented.notices.text).not.toMatch(/```text\n\s*```/)
    // A LICENSE with text beside an empty NOTICE passes, and the empty file isn't quoted.
    const root = checkout(['lib'], [{ name: 'lib', version: '1.0.0', license: 'MIT', licenseFile: 'MIT License\n' }])
    made.push(root)
    writeFileSync(join(root, 'node_modules', 'lib', 'NOTICE'), blank)
    const r = generateLicenses(root, { products: { desktop: 'apps/app' }, noticesDir: notices, exceptions: [], supplements: {} })
    expect(r.problems).toEqual([])
    expect(r.notices.text).toContain('## lib 1.0.0\n\nLicense: MIT\n\n```text\nMIT License\n```')
    expect(r.notices.text).not.toContain('*NOTICE*')
  })

  it('fails a supplement whose text file is missing, and a package with only a NOTICE file', () => {
    expect(fixture(['bare'], [{ name: 'bare', version: '1.0.0', license: 'MIT', licenseFile: null }], { supplements: { 'bare@1.0.0': { text: 'none.txt', link: null, why: '', reviewedBy: '' } }, texts: {} }).problems).toEqual([
      "bare@1.0.0 (shipped): its supplement's text scripts/notices/texts/none.txt is missing"
    ])
    const root = checkout(['noticed'], [{ name: 'noticed', version: '1.0.0', license: 'Apache-2.0', licenseFile: null }])
    made.push(root)
    writeFileSync(join(root, 'node_modules', 'noticed', 'NOTICE'), 'Noticed\nCopyright 2026\n')
    expect(generateLicenses(root, { products: { desktop: 'apps/app' }, noticesDir: notices, exceptions: [], supplements: {} }).problems).toEqual([
      'noticed@1.0.0 (shipped): the package has no license file (LICENSE or COPYING) with text to give its full text: add a reviewed supplement (SUPPLEMENTS in scripts/thirdPartyNotices.mjs)'
    ])
  })
})

describe('repository links', () => {
  const gh = 'https://github.com/owner/repo'
  const cases: [unknown, string | null][] = [
    // The string and object forms, with and without a directory.
    ['https://github.com/owner/repo', gh],
    [{ type: 'git', url: 'https://github.com/owner/repo.git' }, gh],
    [{ type: 'git', url: 'git+https://github.com/owner/repo.git', directory: 'packages/lib' }, `${gh}/tree/HEAD/packages/lib`],
    [{ type: 'git', url: 'https://gitlab.com/owner/repo.git', directory: '/packages/lib/' }, 'https://gitlab.com/owner/repo/tree/HEAD/packages/lib'],
    // The shortcuts.
    ['owner/repo', gh],
    ['github:owner/repo', gh],
    ['gist:11081aaa281', 'https://gist.github.com/11081aaa281'],
    ['bitbucket:owner/repo', 'https://bitbucket.org/owner/repo'],
    ['gitlab:owner/repo', 'https://gitlab.com/owner/repo'],
    // The URL forms.
    ['git+https://github.com/owner/repo.git', gh],
    ['git+ssh://git@github.com/owner/repo.git', gh],
    ['git@github.com:owner/repo.git', gh],
    ['git://github.com/owner/repo.git', gh],
    ['ssh://git@github.com/owner/repo.git', gh],
    ['http://github.com/owner/repo', gh],
    // A commit-ish is dropped.
    ['https://github.com/owner/repo.git#v1.2.3', gh],
    ['github:owner/repo#semver:^5.0', gh],
    ['git+https://git.example.org/team/repo.git#main', 'https://git.example.org/team/repo'],
    // Another host keeps only an https address.
    ['https://git.example.org/team/repo', 'https://git.example.org/team/repo'],
    ['git://git.example.org/team/repo.git', null],
    ['ssh://git@git.example.org/team/repo.git', null],
    ['http://git.example.org/team/repo', null],
    // Nothing usable.
    ['', null],
    [{ type: 'git' }, null],
    ['not a url', null],
    [undefined, null]
  ]
  it.each(cases)('%j → %s', (repository, want) => {
    expect(repositoryUrl(repository)).toBe(want)
  })

  it('falls back to an https homepage, and gives no link when there is neither', () => {
    expect(packageLink({ repository: 'git://git.example.org/x.git', homepage: 'https://x.example.org/docs' })).toBe('https://x.example.org/docs')
    expect(packageLink({ repository: 'git://git.example.org/x.git', homepage: 'http://x.example.org' })).toBeNull()
    expect(packageLink({ homepage: 'https://x.example.org#readme' })).toBe('https://x.example.org#readme')
    expect(packageLink({})).toBeNull()
  })

  it('every link in generated notices starts with https://, whatever form the packages give', () => {
    const forms = cases.map(([repository], i) => ({ name: `pkg-${String(i).padStart(2, '0')}`, version: '1.0.0', license: 'MIT', repository, homepage: i % 3 ? 'https://example.org/home' : 'http://example.org/home' }))
    const r = fixture(forms.map((f) => f.name), forms)
    const found = links(r.notices.text)
    expect(found.length).toBeGreaterThan(cases.length / 2)
    expect(found.filter((l) => !l.startsWith('https://'))).toEqual([])
    // A package with neither a usable repository nor an https homepage is listed by name alone.
    const bare = forms.find((f, i) => cases[i][1] === null && f.homepage.startsWith('http:'))
    expect(bare).toBeDefined()
    expect(r.notices.text).toContain(`| ${bare?.name} | 1.0.0 | MIT |`)
  })
})

describe('the generated files stay up to date (scripts/licenseText.mjs)', () => {
  const lines = ['MIT License', '', 'Copyright (c) 2026 Someone', '', 'Permission is hereby granted…']

  it('quotes a license file the same whether it has CRLF, LF, lone CR or mixed endings', () => {
    const want = lines.join('\n')
    for (const raw of [lines.join('\r\n'), lines.join('\n'), lines.join('\r'), `${lines[0]}\r\n${lines[1]}\n${lines[2]}\r${lines[3]}\r\n${lines[4]}\n`, `\r\n\n${lines.join('\r\n')}\r\n\r\n`])
      expect(licenseText(raw), JSON.stringify(raw.slice(0, 40))).toBe(want)
    expect(toLf('a\r\nb\rc\nd')).toBe('a\nb\nc\nd')
  })

  it('leaves the file alone when only line endings differ, and writes a change with the endings on disk', () => {
    const text = '# Third-party notices\n\n| lib | 1.1.0 | MIT |\n'
    expect(noticesToWrite(text, text)).toBeNull()
    expect(noticesToWrite(text, text.replace(/\n/g, '\r\n'))).toBeNull()
    const old = '# Third-party notices\r\n\r\n| lib | 1.0.0 | MIT |\r\n'
    expect(noticesToWrite(text, old)).toBe(text.replace(/\n/g, '\r\n'))
    expect(noticesToWrite(text, toLf(old))).toBe(text)
    expect(noticesToWrite(text, null)).toBe(text)
  })

  it('fails on a stale notices file: a version changed, a package added and one gone', () => {
    const before = fixture(['alpha', 'gamma'], [{ name: 'alpha', version: '1.0.0', license: 'MIT' }, { name: 'gamma', version: '3.0.0', license: 'MIT' }])
    const committed = before.notices.text.replace(/\n/g, '\r\n')
    expect(noticesDrift(before.notices.text, committed)).toBeNull()
    const after = fixture(['alpha', 'beta'], [{ name: 'alpha', version: '1.1.0', license: 'MIT' }, { name: 'beta', version: '2.0.0', license: 'MIT' }])
    const drift = noticesDrift(after.notices.text, committed)
    expect(drift).toEqual({ packages: ['alpha 1.0.0 → 1.1.0', 'gone: gamma 3.0.0', 'new: beta 2.0.0'] })
    expect(staleNoticesMessage(drift)).toBe(
      'THIRD_PARTY_NOTICES.md is out of date: run `npm run licenses` and commit it. Changed: alpha 1.0.0 → 1.1.0; gone: gamma 3.0.0; new: beta 2.0.0.'
    )
  })

  it('fails on a stale file whose packages are the same (a license text changed), and on a missing file', () => {
    const text = '# Third-party notices\n\n| Package | Version | License | Ships in |\n|---|---|---|---|\n| [lib](https://github.com/o/lib) | 1.0.0 | MIT | CLI |\n\nMIT license\n'
    const drift = noticesDrift(text, text.replace('MIT license', 'MIT license, old'))
    expect(drift).toEqual({ packages: [] })
    expect(staleNoticesMessage(drift, 'docs/BUILD_ONLY_PACKAGES.md')).toBe('docs/BUILD_ONLY_PACKAGES.md is out of date: run `npm run licenses` and commit it.')
    expect(noticesDrift(text, null)).toEqual({ packages: ['new: lib 1.0.0'] })
  })
})

describe('Rust crates (scripts/crateNotices.mjs)', () => {
  /** A crate's source folder with these license files. */
  const crateDir = (files: Record<string, string>): string => {
    const dir = tempDir('dialect-crate-')
    made.push(dir)
    for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text)
    return dir
  }
  type Crate = { name: string; version: string; license?: string; repository?: string; homepage?: string; files?: Record<string, string> }
  /** `cargo metadata` and the two `cargo tree` outputs for an app (ours) whose runtime crates are `runtime` and whose host-only ones are `host`. */
  const cargoOutput = (runtime: Crate[], host: Crate[]) => {
    const pkg = (c: Crate) => ({ id: `registry+${c.name}@${c.version}`, name: c.name, version: c.version, license: c.license ?? null, repository: c.repository ?? null, homepage: c.homepage ?? null, manifest_path: join(crateDir(c.files ?? { 'LICENSE-MIT': `MIT license of ${c.name}\n` }), 'Cargo.toml') })
    const app = { id: 'path+app@0.0.0', name: 'app', version: '0.0.0', license: 'MIT', manifest_path: join(repo, 'Cargo.toml') }
    const metadata = { workspace_members: [app.id], packages: [app, ...[...runtime, ...host].map(pkg)] }
    const line = (c: Crate) => `${c.name} v${c.version}`
    return { metadata, runtimeTree: ['app v0.0.0 (D:\\app)', ...runtime.map(line), `${line(runtime[0])} (*)`].join('\r\n'), allTree: ['app v0.0.0 (D:\\app)', ...runtime.map(line), ...host.map(line)].join('\n') }
  }
  const inventoryOf = (runtime: Crate[], host: Crate[]) => {
    const out = cargoOutput(runtime, host)
    const crates = classifyCrates(out.metadata, out.runtimeTree, out.allTree)
    for (const c of crates.shipped) c.products = new Set(['desktop'])
    return { shipped: [], buildOnly: [], problems: [], crates }
  }

  it('reads cargo tree\'s crates, without the repeats\' (*) or a path crate\'s folder', () => {
    expect([...treeCrates('app v0.1.0 (D:\\x)\r\nserde v1.0.200\nserde v1.0.200 (*)\n\n')].sort()).toEqual(['app@0.1.0', 'serde@1.0.200'])
  })

  it('reads Cargo\'s deprecated A/B license form as A OR B', () => {
    expect(cargoLicense('MIT/Apache-2.0')).toBe('MIT OR Apache-2.0')
    expect(cargoLicense('Apache-2.0 / MIT')).toBe('Apache-2.0 OR MIT')
    expect(cargoLicense('MIT OR Apache-2.0')).toBe('MIT OR Apache-2.0')
    expect(cargoLicense(null)).toBeNull()
  })

  it('ships only the runtime crates: a proc-macro and a build script\'s dependency are build-only, and the app is ours', () => {
    const inv = inventoryOf([{ name: 'tauri', version: '2.0.0', license: 'MIT OR Apache-2.0' }], [
      { name: 'cssparser-macros', version: '0.6.1', license: 'MPL-2.0' },
      { name: 'cc', version: '1.0.0', license: 'MIT OR Apache-2.0' }
    ])
    expect(inv.crates.shipped.map((c: { name: string }) => c.name)).toEqual(['tauri'])
    expect(inv.crates.buildOnly.map((c: { name: string }) => c.name)).toEqual(['cc', 'cssparser-macros'])
    const text = noticesText(inv, emptyNoticesDir(), [], {}).text
    expect(text).toContain('| tauri | 2.0.0 | MIT OR Apache-2.0 | desktop app |')
    expect(text).not.toContain('cssparser-macros')
    expect(buildOnlyText(inv, []).text).toContain('| cssparser-macros | 0.6.1 | MPL-2.0 |')
    expect(licenseProblems(inv, [])).toEqual([])
  })

  it('links a crate to its repository, normalised (git+ssh://, .git), else its https homepage, else nothing', () => {
    const inv = inventoryOf(
      [
        { name: 'a-ssh', version: '1.0.0', license: 'MIT', repository: 'git+ssh://git@github.com/owner/a-ssh.git' },
        { name: 'b-dotgit', version: '1.0.0', license: 'MIT', repository: 'https://github.com/owner/b-dotgit.git' },
        { name: 'c-home', version: '1.0.0', license: 'MIT', homepage: 'https://c.example.org' },
        { name: 'd-none', version: '1.0.0', license: 'MIT', repository: 'git://git.example.org/d.git', homepage: 'http://d.example.org' }
      ],
      []
    )
    const text = noticesText(inv, emptyNoticesDir(), [], {}).text
    expect(text).toContain('| [a-ssh](https://github.com/owner/a-ssh) | 1.0.0 |')
    expect(text).toContain('| [b-dotgit](https://github.com/owner/b-dotgit) | 1.0.0 |')
    expect(text).toContain('| [c-home](https://c.example.org) | 1.0.0 |')
    expect(text).toContain('| d-none | 1.0.0 |')
    expect(links(text).filter((l) => !l.startsWith('https://'))).toEqual([])
  })

  it('gives a license text once and refers back to it when another crate has the same one', () => {
    const apache = 'Apache License\nVersion 2.0, January 2004\n'
    const inv = inventoryOf(
      [
        { name: 'first', version: '1.0.0', license: 'MIT OR Apache-2.0', files: { 'LICENSE-APACHE': apache, 'LICENSE-MIT': 'MIT, first\n' } },
        { name: 'second', version: '1.0.0', license: 'MIT OR Apache-2.0', files: { 'LICENSE-APACHE': apache, 'LICENSE-MIT': 'MIT, second\n' } }
      ],
      []
    )
    const text = noticesText(inv, emptyNoticesDir(), [], {}).text
    expect(text.split('Version 2.0, January 2004').length).toBe(2)
    expect(text).toContain("*LICENSE-APACHE*: the same text as first 1.0.0's LICENSE-APACHE, above.")
    expect(text).toContain('MIT, second')
  })

  it('fails a shipped crate with no license file, and takes a reviewed supplement\'s text; judges crates by the license rule', () => {
    const inv = inventoryOf([{ name: 'bare', version: '1.0.0', license: 'MIT', files: { 'README.md': 'no license here\n' } }], [{ name: 'tool', version: '1.0.0' }])
    expect(noticesText(inv, emptyNoticesDir(), [], {}).problems).toEqual([expect.stringContaining('bare@1.0.0 (shipped crate): publishes no license file')])
    const dir = emptyNoticesDir()
    mkdirSync(join(dir, 'texts'))
    writeFileSync(join(dir, 'texts', 'bare.txt'), 'MIT License, bare\n')
    const supplemented = noticesText(inv, dir, [], { 'bare@1.0.0': { text: 'bare.txt', link: 'https://github.com/owner/bare', why: 'a test', reviewedBy: 'a test' } })
    expect(supplemented.problems).toEqual([])
    expect(supplemented.text).toContain('| [bare](https://github.com/owner/bare) | 1.0.0 | MIT | desktop app |')
    expect(supplemented.text).toContain('```text\nMIT License, bare\n```')
    expect(licenseProblems(inv, [])).toEqual(['tool (crate)@1.0.0 (build-only): no license'])
    inv.crates.shipped[0].license = 'GPL-3.0-only'
    expect(licenseProblems(inv, [])).toEqual([expect.stringContaining('bare (crate)@1.0.0 (shipped): GPL-3.0-only isn\'t allowed'), 'tool (crate)@1.0.0 (build-only): no license'])
  })

  /** An empty notices folder of the test's own. */
  function emptyNoticesDir(): string {
    const dir = tempDir('dialect-crate-notices-')
    made.push(dir)
    return dir
  }
})
