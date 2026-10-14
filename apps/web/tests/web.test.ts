// The built web page (vite.config.ts → dialect.html), opened from file:// in Microsoft Edge by Playwright with the
// network blocked: open, drop, paste, save and copy, the output against the display set fixtures, a syntax error and
// warnings in the problems panel, the themes, and no CSP violation or console error along the way. Edge comes with
// Windows (and GitHub's Windows runners), so no browser is downloaded.
//
// The page updates after an action through React effects, so every check after one polls for the state it expects
// (expect.poll, bounded by UI_WAIT), never reads it once.
import { readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core'
import { build } from 'vite'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { tempDir } from '../../../tests/tempDir'
import { version } from '../../../package.json'

const webRoot = join(__dirname, '..')
const FIXTURES = join(__dirname, '../../../packages/platform-junos/tests/fixtures/display-set')
/** How long the page may take to show what an action leads to: a bound for a hung page, not a wait. */
const UI_WAIT = { timeout: 10_000 }

let dir: string
let pageUrl: string
let browser: Browser
let context: BrowserContext
let page: Page
/** Requests for anything but the page itself: there must be none. */
let blocked: string[]
/** Console errors and warnings, page errors and CSP violations: there must be none. */
let problems: string[]
let downloads = 0

beforeAll(async () => {
  dir = tempDir('dialect-web-')
  // A production build, as `npm run build` makes: Vitest sets NODE_ENV to "test", which would give React's dev build.
  const nodeEnv = process.env.NODE_ENV
  process.env.NODE_ENV = 'production'
  try {
    await build({ root: webRoot, configFile: join(webRoot, 'vite.config.ts'), logLevel: 'silent', build: { outDir: join(dir, 'dist') } })
  } finally {
    process.env.NODE_ENV = nodeEnv
  }
  pageUrl = pathToFileURL(join(dir, 'dist', 'dialect.html')).href
  try {
    browser = await chromium.launch({ channel: 'msedge' })
  } catch (error) {
    throw new Error(`These tests drive Microsoft Edge, which comes with Windows: ${(error as Error).message}`, { cause: error })
  }
}, 120_000)

afterAll(async () => {
  await browser?.close()
  if (dir) rmSync(dir, { recursive: true, force: true })
})

async function openPage(colorScheme: 'dark' | 'light' = 'dark'): Promise<void> {
  context = await browser.newContext({ offline: true, colorScheme, acceptDownloads: true, viewport: { width: 1280, height: 760 } })
  blocked = []
  problems = []
  await context.route('**/*', (route) => {
    const url = route.request().url()
    if (url === pageUrl || url.startsWith('data:') || url.startsWith('blob:')) return route.continue()
    blocked.push(url)
    return route.abort()
  })
  await context.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => console.error(`CSP violation: ${e.violatedDirective} ${e.blockedURI}`))
  })
  page = await context.newPage()
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') problems.push(`${m.type()}: ${m.text()}`)
  })
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`))
  await page.goto(pageUrl)
  await page.locator('[data-pane=source] .cm-content').waitFor(UI_WAIT)
}

afterEach(async () => {
  const seen = { blocked, problems }
  await context?.close()
  expect(seen).toEqual({ blocked: [], problems: [] })
})

const fixture = (name: string): string => join(FIXTURES, name)

/** A fixture's expected set lines as the page saves them: one per line, each ended by a newline. */
function expectedOutput(n: number): string {
  const lines = readFileSync(fixture(`config_${n}.set`), 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line !== '')
  return lines.join('\n') + '\n'
}

const setLines = (n: number): string => `${n} set line${n === 1 ? '' : 's'}`

async function openWithPicker(path: string): Promise<void> {
  const chooser = page.waitForEvent('filechooser', UI_WAIT)
  await page.getByRole('button', { name: /^Open/ }).click()
  await (await chooser).setFiles(path)
}

/** Saves the output and returns the downloaded file's name and text. */
async function saveOutput(): Promise<{ name: string; text: string }> {
  const download = page.waitForEvent('download', UI_WAIT)
  await page.getByRole('button', { name: 'Save output' }).click()
  const file = await download
  const path = join(dir, `download-${++downloads}-${file.suggestedFilename()}`)
  await file.saveAs(path)
  return { name: file.suggestedFilename(), text: readFileSync(path, 'utf8') }
}

async function typeSource(text: string): Promise<void> {
  await page.locator('[data-pane=source] .cm-content').click()
  await page.keyboard.press('Control+A')
  await page.keyboard.insertText(text)
}

const text = (testId: string): Promise<string> => page.getByTestId(testId).innerText()

/** What the page shows about the source and its result, for one poll to compare whole. */
async function summary(): Promise<{ name: string; output: string; problems: string; status: string; saveDisabled: boolean }> {
  return {
    name: await text('source-name'),
    output: await text('output-summary'),
    problems: await text('problem-count'),
    status: await text('status-result'),
    saveDisabled: await page.getByRole('button', { name: 'Save output' }).isDisabled()
  }
}

describe('the web build', () => {
  it('is one file with a strict content security policy', async () => {
    const html = readFileSync(join(dir, 'dist', 'dialect.html'), 'utf8')
    expect(html).not.toMatch(/<script\b[^>]*\bsrc=|<link\b[^>]*rel="stylesheet"/)
    const policy = /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1] ?? ''
    const directives = Object.fromEntries(policy.split('; ').map((d) => [d.split(' ')[0], d.split(' ').slice(1)]))
    expect(directives['default-src']).toEqual(["'none'"])
    expect(directives['script-src'].length).toBeGreaterThan(0)
    expect(directives['style-src'].length).toBeGreaterThan(0)
    for (const source of [...directives['script-src'], ...directives['style-src']]) expect(source).toMatch(/^'sha256-[A-Za-z0-9+/]+=*'$/)
    expect(directives['img-src']).toEqual(['data:'])
    expect(policy).not.toMatch(/unsafe|https?:|\*|blob:/)
    expect(directives['connect-src']).toBeUndefined()
    await openPage()
  })

  it.each([1, 15, 17, 22])('opens config_%i with the picker and saves its display set', async (n) => {
    await openPage()
    await openWithPicker(fixture(`config_${n}.conf`))
    const lineCount = expectedOutput(n).split('\n').length - 1
    await expect
      .poll(summary, UI_WAIT)
      .toEqual({ name: `config_${n}.conf`, output: setLines(lineCount), problems: '0 warnings', status: setLines(lineCount), saveDisabled: false })
    expect(await saveOutput()).toEqual({ name: `config_${n}.set`, text: expectedOutput(n) })
  })

  it('shows the display set in the output pane, deactivate after its subtree', async () => {
    await openPage()
    await openWithPicker(fixture('config_8.conf'))
    const output = page.locator('[data-pane=output] .cm-line')
    await expect.poll(() => output.allInnerTexts(), UI_WAIT).toEqual(expectedOutput(8).trimEnd().split('\n'))
  })

  it('opens a file dropped on the window, even on an editor', async () => {
    await openPage()
    const conf = readFileSync(fixture('config_16.conf'), 'utf8')
    const data = await page.evaluateHandle((content) => {
      const transfer = new DataTransfer()
      transfer.items.add(new File([content], 'dropped.conf', { type: 'text/plain' }))
      return transfer
    }, conf)
    const target = page.locator('[data-pane=source]')
    await target.dispatchEvent('dragover', { dataTransfer: data })
    await target.dispatchEvent('drop', { dataTransfer: data })
    await expect.poll(() => text('source-name'), UI_WAIT).toBe('dropped.conf')
    await expect.poll(() => text('output-summary'), UI_WAIT).toBe(setLines(7))
    expect(await saveOutput()).toEqual({ name: 'dropped.set', text: expectedOutput(16) })
  })

  it('ignores a byte order mark at the start of typed or pasted text', async () => {
    await openPage()
    await typeSource('﻿system { host-name r1; }')
    await expect.poll(() => text('output-summary'), UI_WAIT).toBe(setLines(1))
    expect(await saveOutput()).toEqual({ name: 'display-set.set', text: 'set system host-name r1\n' })
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await page.evaluate(() => navigator.clipboard.writeText('﻿system {\n    host-name r2;\n}\n'))
    await page.getByRole('button', { name: 'Paste' }).click()
    await expect.poll(() => page.locator('[data-pane=output] .cm-line').allInnerTexts(), UI_WAIT).toEqual(['set system host-name r2'])
    expect(await saveOutput()).toEqual({ name: 'display-set.set', text: 'set system host-name r2\n' })
  })

  it('shows a syntax error in the problems panel, with no output, and jumps to it', async () => {
    await openPage()
    await typeSource('system {\n    host-name r1\n}\n')
    await expect
      .poll(summary, UI_WAIT)
      .toEqual({ name: 'Pasted text', output: 'No output: the config has a syntax error', problems: '1 error', status: 'Syntax error, line 3', saveDisabled: true })
    await expect.poll(() => page.locator('.problem.error').innerText(), UI_WAIT).toBe("missing ';' after the statement at line 2, column 5\nline 3, column 1")
    await expect.poll(() => page.locator('[data-pane=output] .cm-placeholder').innerText(), UI_WAIT).toBe('Fix the syntax error to see the display set.')
    await expect.poll(() => page.locator('[data-pane=source] .cm-mark-error').innerText(), UI_WAIT).toBe('}')
    // Clicking the problem puts the cursor on it, in the source.
    await page.locator('.problem.error').click()
    await expect.poll(() => page.locator('[data-pane=source] .cm-activeLine').innerText(), UI_WAIT).toBe('}')
    // Fixing it brings the output back.
    await typeSource('system {\n    host-name r1;\n}\n')
    await expect.poll(summary, UI_WAIT).toEqual({ name: 'Pasted text', output: setLines(1), problems: '0 warnings', status: setLines(1), saveDisabled: false })
    await expect.poll(() => page.locator('.problem').count(), UI_WAIT).toBe(0)
  })

  it('lists warnings with their positions', async () => {
    await openPage()
    await typeSource('system {\n    /* lab */\n    host-name r1;\n    deleted: services;\n}\n')
    await expect
      .poll(() => page.locator('.problem.warning').allInnerTexts(), UI_WAIT)
      .toEqual(["annotation on this statement isn't shown in display set\nline 3, column 5", "unknown tag 'deleted:' kept as a word\nline 4, column 5"])
    await expect.poll(summary, UI_WAIT).toEqual({ name: 'Pasted text', output: setLines(2), problems: '2 warnings', status: setLines(2), saveDisabled: false })
  })

  it('pastes from the clipboard and copies the output to it', async () => {
    await openPage()
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await page.evaluate((t) => navigator.clipboard.writeText(t), readFileSync(fixture('config_3.conf'), 'utf8'))
    await page.getByRole('button', { name: 'Paste' }).click()
    const lineCount = expectedOutput(3).split('\n').length - 1
    await expect.poll(summary, UI_WAIT).toEqual({ name: 'Pasted text', output: setLines(lineCount), problems: '0 warnings', status: setLines(lineCount), saveDisabled: false })
    await page.evaluate(() => navigator.clipboard.writeText(''))
    await page.getByRole('button', { name: 'Copy output' }).click()
    // Windows' clipboard keeps text with CRLF line endings.
    await expect.poll(async () => (await page.evaluate(() => navigator.clipboard.readText())).replaceAll('\r\n', '\n'), UI_WAIT).toBe(expectedOutput(3))
    await expect.poll(() => page.getByRole('status').innerText(), UI_WAIT).toBe(`Copied ${setLines(lineCount)}.`)
  })

  it('asks for Ctrl+V when it may not read the clipboard', async () => {
    await openPage()
    await page.getByRole('button', { name: 'Paste' }).click()
    await expect.poll(() => page.getByRole('status').innerText(), UI_WAIT).toContain('press Ctrl+V')
  })

  it("follows the system's theme, and the theme button cycles light, dark and system", async () => {
    await openPage('light')
    const button = page.locator('.toolbar .icon-only')
    const theme = async (): Promise<{ label: string | null; theme: string | undefined; background: string }> => ({
      label: await button.getAttribute('aria-label'),
      theme: await page.evaluate(() => document.documentElement.dataset.theme),
      background: await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
    })
    await expect.poll(theme, UI_WAIT).toEqual({ label: 'System theme', theme: 'light', background: 'rgb(255, 255, 255)' })
    await button.click()
    await expect.poll(theme, UI_WAIT).toEqual({ label: 'Light theme', theme: 'light', background: 'rgb(255, 255, 255)' })
    await button.click()
    await expect.poll(theme, UI_WAIT).toEqual({ label: 'Dark theme', theme: 'dark', background: 'rgb(30, 30, 30)' })
    await button.click()
    await expect.poll(theme, UI_WAIT).toEqual({ label: 'System theme', theme: 'light', background: 'rgb(255, 255, 255)' })
  })

  it('links an output line to its source statement', async () => {
    await openPage()
    await typeSource('system {\n    host-name r1;\n    inactive: services {\n        ssh;\n    }\n}\n')
    await expect.poll(() => text('output-summary'), UI_WAIT).toBe(setLines(3))
    await page.locator('[data-pane=output] .cm-line').nth(2).click()
    await expect.poll(() => page.locator('[data-pane=source] .cm-mark-link').innerText(), UI_WAIT).toBe('    inactive: services {')
  })

  it('shows About with the version, the build, the browser and the disclaimer, and copies the version information', async () => {
    await openPage()
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await page.getByRole('button', { name: 'Help' }).click()
    await page.getByRole('menuitem', { name: 'About Dialect' }).click()
    const dialog = page.getByRole('dialog', { name: 'Dialect' })
    await expect.poll(() => dialog.getByTestId('about-info').innerText(), UI_WAIT).toMatch(new RegExp(`^Version\\s+${version.replaceAll('.', '\\.')}\\s+Build\\s+Web build\\s+Browser\\s+Microsoft Edge \\d+\\.\\d+\\.\\d+\\.\\d+$`))
    expect(await dialog.innerText()).toContain('Dialect is not affiliated with or endorsed by Juniper Networks or Cisco Systems.')
    await dialog.getByRole('button', { name: 'Copy' }).click()
    await expect
      .poll(async () => (await page.evaluate(() => navigator.clipboard.readText())).replaceAll('\r\n', '\n'), UI_WAIT)
      .toMatch(new RegExp(`^Dialect ${version.replaceAll('.', '\\.')}\nBuild: Web build\nBrowser: Microsoft Edge [\\d.]+\n$`))
    await dialog.getByRole('button', { name: 'OK' }).click()
    await expect.poll(() => dialog.count(), UI_WAIT).toBe(0)
  })

  it('renders each Docs page, from Help and from About, and goes back to the display set', async () => {
    await openPage()
    const page1 = (): Promise<string> => page.locator('.docs-page h1').first().innerText()
    await page.getByRole('button', { name: 'Help' }).click()
    await page.getByRole('menuitem', { name: 'User Guide' }).click()
    await expect.poll(page1, UI_WAIT).toBe('Dialect user guide')
    // The view takes the panes' and the problems panel's rows: the status bar keeps its height.
    expect((await page.locator('.statusbar').boundingBox())?.height).toBe(24)
    for (const [label, heading] of [['Release Notes', 'Release Notes'], ['License', 'License'], ['Third-Party Notices', 'Third-party notices']]) {
      await page.getByRole('navigation', { name: 'Documents' }).getByRole('button', { name: label }).click()
      await expect.poll(page1, UI_WAIT).toBe(heading)
    }
    // From About's links too.
    await page.getByRole('navigation', { name: 'Documents' }).getByRole('button', { name: 'About Dialect' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'License' }).click()
    await expect.poll(page1, UI_WAIT).toBe('License')
    expect(await page.locator('.docs-page pre').first().innerText()).toContain('MIT License')
    // A link to another document opens it here.
    await page.locator('.docs-page a', { hasText: 'third-party notices' }).click()
    await expect.poll(page1, UI_WAIT).toBe('Third-party notices')
    await page.keyboard.press('Escape')
    await expect.poll(() => page.locator('[data-pane=source] .cm-content').count(), UI_WAIT).toBe(1)
    // F1 opens the guide.
    await page.keyboard.press('F1')
    await expect.poll(page1, UI_WAIT).toBe('Dialect user guide')
  })

  it('lists a shipped package in the notices with its version, license and full license text, as committed', async () => {
    await openPage()
    await page.getByRole('button', { name: 'Help' }).click()
    await page.getByRole('menuitem', { name: 'Third-Party Notices' }).click()
    const docs = page.locator('.docs-page')
    await expect.poll(() => docs.locator('h2', { hasText: /^zustand / }).count(), UI_WAIT).toBe(1)
    const committed = readFileSync(join(webRoot, '../../THIRD_PARTY_NOTICES.md'), 'utf8')
    const zustand = /^\| \[zustand\]\(([^)]+)\) \| ([\d.]+) \| MIT \| desktop app, web build \|$/m.exec(committed)
    expect(zustand).not.toBeNull()
    const [, link, zustandVersion] = zustand!
    const row = docs.locator('tr', { has: page.locator(`a[href="${link}"]`) })
    expect((await row.innerText()).split('\t').map((c) => c.trim())).toEqual(['zustand', zustandVersion, 'MIT', 'desktop app, web build'])
    const heading = docs.locator('h2', { hasText: `zustand ${zustandVersion}` })
    expect(await heading.count()).toBe(1)
    const licenseText = await heading.locator('xpath=following-sibling::pre[1]').innerText()
    expect(licenseText).toMatch(/^MIT License\s+Copyright \(c\) \d{4}/)
    expect(licenseText).toContain('THE SOFTWARE IS PROVIDED "AS IS"')
    // Every package and crate the committed file lists is on the page.
    const rows = committed.split('\n').filter((l) => /^\| \[?[\w@./-]+/.test(l) && !l.startsWith('| Package') && !l.startsWith('| Crate'))
    expect(await docs.locator('table tbody tr').count()).toBe(rows.length)
  })
})

// Writes light and dark screenshots of a fixture for the card's report, when asked: DIALECT_SCREENSHOTS=<folder>.
const shots = process.env.DIALECT_SCREENSHOTS
describe.runIf(Boolean(shots))('screenshots', () => {
  it.each(['dark', 'light'] as const)('%s', async (scheme) => {
    await openPage(scheme)
    await openWithPicker(fixture('config_15.conf'))
    await expect.poll(() => text('output-summary'), UI_WAIT).toBe(setLines(12))
    await page.locator('[data-pane=output] .cm-line').nth(6).click()
    await expect.poll(() => page.locator('[data-pane=source] .cm-mark-link').count(), UI_WAIT).toBe(1)
    await page.screenshot({ path: join(shots!, `dialect-${scheme}.png`) })
    await typeSource('system {\n    /* lab */\n    host-name r1\n}\n')
    await expect.poll(() => text('problem-count'), UI_WAIT).toBe('1 error')
    await page.screenshot({ path: join(shots!, `dialect-${scheme}-error.png`) })
    writeFileSync(join(shots!, 'size.txt'), `${readFileSync(join(dir, 'dist', 'dialect.html')).length}\n`)
  })
})
