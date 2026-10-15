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
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright-core'
import { build } from 'vite'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { tempDir } from '../../../tests/tempDir'
import { version } from '../../../package.json'

/** About's disclaimer, word for word (card #84). */
const DISCLAIMER =
  "Always review converted configuration before applying it to a device. Dialect reports what it couldn't convert, but you are responsible for what you deploy."

/** About's notice, word for word (card #42). */
const NOTICE =
  "© 2026 Darren Marshall. Dialect is independently developed and isn't affiliated with, endorsed or sponsored by Juniper Networks or Cisco Systems. Juniper and Junos are trademarks of Juniper Networks, Inc.; Cisco, IOS, IOS-XE, NX-OS and IOS-XR are trademarks of Cisco Systems, Inc."

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
  await tab().locator('[data-pane=source] .cm-content').waitFor(UI_WAIT)
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

/** The output's count in display set: its commands (set, deactivate and protect). */
const commands = (n: number): string => `${n} command${n === 1 ? '' : 's'}`

async function openWithPicker(path: string): Promise<void> {
  const chooser = page.waitForEvent('filechooser', UI_WAIT)
  await tab().getByRole('button', { name: /^Open/ }).click()
  await (await chooser).setFiles(path)
}

/** Saves the output and returns the downloaded file's name and text. */
async function saveOutput(): Promise<{ name: string; text: string }> {
  const download = page.waitForEvent('download', UI_WAIT)
  await tab().getByRole('button', { name: 'Save output' }).click()
  const file = await download
  const path = join(dir, `download-${++downloads}-${file.suggestedFilename()}`)
  await file.saveAs(path)
  return { name: file.suggestedFilename(), text: readFileSync(path, 'utf8') }
}

async function typeSource(text: string): Promise<void> {
  await tab().locator('[data-pane=source] .cm-content').click()
  await page.keyboard.press('Control+A')
  await page.keyboard.insertText(text)
}

/** The page of the tab shown: every tab keeps its page, the others hidden. */
const tab = (): Locator => page.locator('[role=tabpanel]:not([hidden])')

/** A test id's text: the status bar's, or in the tab shown. */
const text = (testId: string): Promise<string> => (testId.startsWith('status-') ? page : tab()).getByTestId(testId).innerText()

/** The menu bar's menu `name`, while it's open. */
const menuOf = (name: string): Locator => page.getByRole('menu', { name })
/** One of its items, by its label as the menu shows it (a tab's has " •" while its output is unsaved). */
const itemOf = (name: string, label: string): Locator => menuOf(name).locator('[role^=menuitem]').filter({ has: page.locator('.menu-label').getByText(label, { exact: true }) })

/** Runs a menu item with the mouse: the menu, then the item. */
async function menu(name: string, label: string): Promise<void> {
  await page.getByRole('menubar').getByRole('menuitem', { name, exact: true }).click()
  await itemOf(name, label).click()
  await expect.poll(() => menuOf(name).count(), UI_WAIT).toBe(0)
}

const DISPLAY_SET_JOB = 'Display set (Junos)'
const CONVERT_JOB = 'Convert: Junos → Cisco IOS / IOS-XE'

/** File → New Tab, and the job picked in the picker. */
async function newTab(job: string): Promise<void> {
  await menu('File', 'New Tab…')
  await page.getByRole('dialog', { name: 'New tab' }).getByRole('button', { name: job }).click()
  await expect.poll(() => page.getByRole('dialog').count(), UI_WAIT).toBe(0)
}

/** The tab strip's tabs, by title, and the one shown. */
const tabs = (): Promise<{ titles: string[]; current: string }> =>
  page.getByRole('tablist').evaluate((list) => ({
    titles: [...list.querySelectorAll('[role=tab] .tab-title')].map((t) => t.textContent ?? ''),
    current: list.querySelector('[role=tab][aria-selected=true] .tab-title')?.textContent ?? ''
  }))

/** What the page shows about the source and its result, for one poll to compare whole. */
async function summary(): Promise<{ name: string; output: string; problems: string; status: string; saveDisabled: boolean }> {
  return {
    name: await text('source-name'),
    output: await text('output-summary'),
    problems: await text('problem-count'),
    status: await text('status-result'),
    saveDisabled: await tab().getByRole('button', { name: 'Save output' }).isDisabled()
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
      .toEqual({ name: `config_${n}.conf`, output: commands(lineCount), problems: '0 warnings', status: commands(lineCount), saveDisabled: false })
    expect(await saveOutput()).toEqual({ name: `config_${n}.set`, text: expectedOutput(n) })
  })

  it('shows the display set in the output pane, deactivate after its subtree', async () => {
    await openPage()
    await openWithPicker(fixture('config_8.conf'))
    const output = tab().locator('[data-pane=output] .cm-line')
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
    const target = tab().locator('[data-pane=source]')
    await target.dispatchEvent('dragover', { dataTransfer: data })
    await target.dispatchEvent('drop', { dataTransfer: data })
    await expect.poll(() => text('source-name'), UI_WAIT).toBe('dropped.conf')
    await expect.poll(() => text('output-summary'), UI_WAIT).toBe(commands(7))
    expect(await saveOutput()).toEqual({ name: 'dropped.set', text: expectedOutput(16) })
  })

  it('ignores a byte order mark at the start of typed or pasted text', async () => {
    await openPage()
    await typeSource('﻿system { host-name r1; }')
    await expect.poll(() => text('output-summary'), UI_WAIT).toBe(commands(1))
    expect(await saveOutput()).toEqual({ name: 'display-set.set', text: 'set system host-name r1\n' })
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await page.evaluate(() => navigator.clipboard.writeText('﻿system {\n    host-name r2;\n}\n'))
    await tab().getByRole('button', { name: 'Paste' }).click()
    await expect.poll(() => tab().locator('[data-pane=output] .cm-line').allInnerTexts(), UI_WAIT).toEqual(['set system host-name r2'])
    expect(await saveOutput()).toEqual({ name: 'display-set.set', text: 'set system host-name r2\n' })
  })

  it('shows a syntax error in the problems panel, with no output, and jumps to it', async () => {
    await openPage()
    await typeSource('system {\n    host-name r1\n}\n')
    await expect
      .poll(summary, UI_WAIT)
      .toEqual({ name: 'Pasted text', output: 'No output: the config has a syntax error', problems: '1 error', status: 'Syntax error, line 3', saveDisabled: true })
    await expect.poll(() => tab().locator('.problem.error').innerText(), UI_WAIT).toBe("missing ';' after the statement at line 2, column 5\nline 3, column 1")
    await expect.poll(() => tab().locator('[data-pane=output] .cm-placeholder').innerText(), UI_WAIT).toBe('Fix the syntax error to see the display set.')
    await expect.poll(() => tab().locator('[data-pane=source] .cm-mark-error').innerText(), UI_WAIT).toBe('}')
    // Clicking the problem puts the cursor on it, in the source.
    await tab().locator('.problem.error').click()
    await expect.poll(() => tab().locator('[data-pane=source] .cm-activeLine').innerText(), UI_WAIT).toBe('}')
    // Fixing it brings the output back.
    await typeSource('system {\n    host-name r1;\n}\n')
    await expect.poll(summary, UI_WAIT).toEqual({ name: 'Pasted text', output: commands(1), problems: '0 warnings', status: commands(1), saveDisabled: false })
    await expect.poll(() => tab().locator('.problem').count(), UI_WAIT).toBe(0)
  })

  it('lists warnings with their positions', async () => {
    await openPage()
    await typeSource('system {\n    /* lab */\n    host-name r1;\n    deleted: services;\n}\n')
    await expect
      .poll(() => tab().locator('.problem.warning').allInnerTexts(), UI_WAIT)
      .toEqual(["annotation on this statement isn't shown in display set\nline 3, column 5", "unknown tag 'deleted:' kept as a word\nline 4, column 5"])
    await expect.poll(summary, UI_WAIT).toEqual({ name: 'Pasted text', output: commands(2), problems: '2 warnings', status: commands(2), saveDisabled: false })
  })

  it('pastes from the clipboard and copies the output to it', async () => {
    await openPage()
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await page.evaluate((t) => navigator.clipboard.writeText(t), readFileSync(fixture('config_3.conf'), 'utf8'))
    await tab().getByRole('button', { name: 'Paste' }).click()
    const lineCount = expectedOutput(3).split('\n').length - 1
    await expect.poll(summary, UI_WAIT).toEqual({ name: 'Pasted text', output: commands(lineCount), problems: '0 warnings', status: commands(lineCount), saveDisabled: false })
    await page.evaluate(() => navigator.clipboard.writeText(''))
    await tab().getByRole('button', { name: 'Copy output' }).click()
    // Windows' clipboard keeps text with CRLF line endings.
    await expect.poll(async () => (await page.evaluate(() => navigator.clipboard.readText())).replaceAll('\r\n', '\n'), UI_WAIT).toBe(expectedOutput(3))
    await expect.poll(() => page.getByRole('status').innerText(), UI_WAIT).toBe(`Copied ${commands(lineCount)}.`)
  })

  it('asks for Ctrl+V when it may not read the clipboard', async () => {
    await openPage()
    await tab().getByRole('button', { name: 'Paste' }).click()
    await expect.poll(() => page.getByRole('status').innerText(), UI_WAIT).toContain('press Ctrl+V')
  })

  it("follows the system's theme, and View sets light, dark or the system's, ticking the one chosen", async () => {
    await openPage('light')
    const theme = async (): Promise<{ ticked: string[]; theme: string | undefined; background: string }> => {
      await page.getByRole('menubar').getByRole('menuitem', { name: 'View', exact: true }).click()
      const ticked = await menuOf('View').locator('[role=menuitemradio][aria-checked=true] .menu-label').allInnerTexts()
      await page.keyboard.press('Escape')
      return {
        ticked,
        theme: await page.evaluate(() => document.documentElement.dataset.theme),
        background: await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
      }
    }
    await expect.poll(theme, UI_WAIT).toEqual({ ticked: ['System Theme'], theme: 'light', background: 'rgb(255, 255, 255)' })
    await menu('View', 'Dark Theme')
    await expect.poll(theme, UI_WAIT).toEqual({ ticked: ['Dark Theme'], theme: 'dark', background: 'rgb(30, 30, 30)' })
    await menu('View', 'Light Theme')
    await expect.poll(theme, UI_WAIT).toEqual({ ticked: ['Light Theme'], theme: 'light', background: 'rgb(255, 255, 255)' })
    await menu('View', 'System Theme')
    await expect.poll(theme, UI_WAIT).toEqual({ ticked: ['System Theme'], theme: 'light', background: 'rgb(255, 255, 255)' })
  })

  it("counts a banner's lines as one command, deactivate and protect as commands, and links each line to its statement", async () => {
    await openPage()
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await typeSource('system {\n    protect: host-name r1;\n    inactive: login {\n        message "one\ntwo \\"x\\"\nthree";\n    }\n}\n')
    // set host-name, protect host-name, set login message (3 lines), deactivate login.
    await expect.poll(() => text('output-summary'), UI_WAIT).toBe('4 commands (6 lines)')
    expect(await tab().locator('[data-pane=output] .cm-line').count()).toBe(6)
    await tab().locator('[data-pane=output] .cm-line').nth(3).click()
    await expect.poll(() => tab().locator('[data-pane=source] .cm-mark-link').innerText(), UI_WAIT).toBe('        message "one')
    await tab().getByRole('button', { name: 'Copy output' }).click()
    await expect.poll(() => page.getByRole('status').innerText(), UI_WAIT).toBe('Copied 4 commands (6 lines).')
  })

  it('links an output line to its source statement', async () => {
    await openPage()
    await typeSource('system {\n    host-name r1;\n    inactive: services {\n        ssh;\n    }\n}\n')
    await expect.poll(() => text('output-summary'), UI_WAIT).toBe(commands(3))
    await tab().locator('[data-pane=output] .cm-line').nth(2).click()
    await expect.poll(() => tab().locator('[data-pane=source] .cm-mark-link').innerText(), UI_WAIT).toBe('    inactive: services {')
  })

  it('shows About with the version, the build, the browser, the OS and the notice, and copies the version information', async () => {
    await openPage()
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await menu('Help', 'About Dialect')
    const dialog = page.getByRole('dialog', { name: 'Dialect' })
    await expect
      .poll(() => dialog.getByTestId('about-info').innerText(), UI_WAIT)
      .toMatch(new RegExp(`^Version\\s+${version.replaceAll('.', '\\.')}\\s+Build\\s+Web build\\s+Browser\\s+Microsoft Edge \\d+\\.\\d+\\.\\d+\\.\\d+\\s+OS\\s+Windows 1[01]$`))
    expect(await dialog.getByTestId('about-notice').innerText()).toBe(NOTICE)
    expect(await dialog.getByTestId('about-disclaimer').innerText()).toBe(DISCLAIMER)
    expect(await dialog.innerText()).toContain('Open source under the MIT License. Includes third-party software.')
    await dialog.getByRole('button', { name: 'Copy' }).click()
    await expect
      .poll(async () => (await page.evaluate(() => navigator.clipboard.readText())).replaceAll('\r\n', '\n'), UI_WAIT)
      .toMatch(new RegExp(`^Dialect ${version.replaceAll('.', '\\.')}\nBuild: Web build\nBrowser: Microsoft Edge [\\d.]+\nOS: Windows 1[01]\n$`))
    await dialog.getByRole('button', { name: 'OK' }).click()
    await expect.poll(() => dialog.count(), UI_WAIT).toBe(0)
  })

  it('opens the releases page in a browser tab from Help → Releases on GitHub', async () => {
    await openPage()
    const releases = 'https://github.com/Suremise/dialect/releases'
    // The new tab may go online (the page itself can't): answer it here, so nothing reaches the network.
    await context.route(releases, (route) => route.fulfill({ contentType: 'text/html', body: '<title>Releases</title>' }))
    const opened = context.waitForEvent('page', UI_WAIT)
    await menu('Help', 'Releases on GitHub')
    const browserTab = await opened
    await expect.poll(() => browserTab.url(), UI_WAIT).toBe(releases)
    await browserTab.close()
  })

  it("opens the Docs pages from About's links and Release Notes", async () => {
    await openPage()
    const page1 = (): Promise<string> => tab().locator('.docs-page h1').first().innerText()
    for (const [label, heading] of [['MIT License', 'License'], ['third-party software', 'Third-party notices'], ['Release Notes', 'Release Notes']]) {
      await menu('Help', 'About Dialect')
      await page.getByRole('dialog').getByRole('button', { name: label, exact: true }).click()
      await expect.poll(page1, UI_WAIT).toBe(heading)
      await expect.poll(() => page.getByRole('dialog').count(), UI_WAIT).toBe(0)
    }
  })

  it('opens each Docs page in its own tab, from Help, the Docs list, About and links, keeping the display set tab', async () => {
    await openPage()
    const page1 = (): Promise<string> => tab().locator('.docs-page h1').first().innerText()
    await menu('Help', 'User Guide')
    await expect.poll(page1, UI_WAIT).toBe('Dialect user guide')
    expect(await tabs()).toEqual({ titles: ['Untitled → Display set', 'User Guide'], current: 'User Guide' })
    // The page takes the tab's whole area: the status bar keeps its height.
    expect((await page.locator('.statusbar').boundingBox())?.height).toBe(24)
    for (const [label, heading] of [['Release Notes', 'Release Notes'], ['License', 'License'], ['Third-Party Notices', 'Third-party notices']]) {
      await tab().getByRole('navigation', { name: 'Documents' }).getByRole('button', { name: label }).click()
      await expect.poll(page1, UI_WAIT).toBe(heading)
    }
    expect((await tabs()).titles).toEqual(['Untitled → Display set', 'User Guide', 'Release Notes', 'License', 'Third-Party Notices'])
    // A page already open is shown again, not opened twice: from About's links, and from a link in a page.
    await tab().getByRole('navigation', { name: 'Documents' }).getByRole('button', { name: 'About Dialect' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'MIT License' }).click()
    await expect.poll(page1, UI_WAIT).toBe('License')
    expect(await tab().locator('.docs-page pre').first().innerText()).toContain('MIT License')
    await tab().locator('.docs-page a', { hasText: 'third-party notices' }).click()
    await expect.poll(page1, UI_WAIT).toBe('Third-party notices')
    await menu('Help', 'User Guide')
    await expect.poll(page1, UI_WAIT).toBe('Dialect user guide')
    expect((await tabs()).titles).toHaveLength(5)
    // The display set tab is still there, as it was.
    await page.getByRole('tab', { name: 'Untitled → Display set' }).click()
    await expect.poll(() => tab().locator('[data-pane=source] .cm-content').isVisible(), UI_WAIT).toBe(true)
    // F1 shows the guide.
    await page.keyboard.press('F1')
    await expect.poll(page1, UI_WAIT).toBe('Dialect user guide')
  })

  it("keeps each tab's editors and their undo history while another tab shows, and Edit undoes and redoes", async () => {
    await openPage()
    const first = 'system { host-name alpha; }'
    const both = `${first}\ninterfaces { }`
    const sourceText = (): Promise<string> => tab().locator('[data-pane=source] .cm-content').innerText()
    await typeSource(first)
    await page.keyboard.press('End')
    await page.keyboard.insertText('\ninterfaces { }')
    await expect.poll(sourceText, UI_WAIT).toBe(both)
    // The control: what one undo gives here (CodeMirror joins quick edits into one undo step), then redo.
    await page.keyboard.press('Control+Z')
    await expect.poll(sourceText, UI_WAIT).not.toBe(both)
    const undone = await sourceText()
    await page.keyboard.press('Control+Y')
    await expect.poll(sourceText, UI_WAIT).toBe(both)
    // To a Docs tab and a convert tab, and back.
    await page.keyboard.press('F1')
    await newTab(CONVERT_JOB)
    await expect.poll(() => tabs(), UI_WAIT).toEqual({ titles: ['Untitled → Display set', 'User Guide', 'Untitled → IOS-XE'], current: 'Untitled → IOS-XE' })
    await page.getByRole('tab', { name: /^Untitled → Display set/ }).click()
    await expect.poll(sourceText, UI_WAIT).toBe(both)
    expect(await text('output-summary')).toBe(commands(2))
    // Edit → Undo and Redo act on this tab's source.
    await menu('Edit', 'Undo')
    await expect.poll(sourceText, UI_WAIT).toBe(undone)
    await menu('Edit', 'Redo')
    await expect.poll(sourceText, UI_WAIT).toBe(both)
    await tab().locator('[data-pane=source] .cm-content').click()
    await page.keyboard.press('Control+Z')
    await expect.poll(sourceText, UI_WAIT).toBe(undone)
  })

  it('lists a shipped package in the notices with its version, license and full license text, as committed', async () => {
    await openPage()
    await menu('Help', 'Third-Party Notices')
    const docs = tab().locator('.docs-page')
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

describe('convert mode in the web build', () => {
  const CONVERT = join(__dirname, '../../../packages/cli/tests/fixtures/convert')
  const expected = readFileSync(join(CONVERT, 'phase1.iosxe'), 'utf8')
  const outputLines = (): Promise<string[]> => tab().locator('[data-pane=output] .cm-line').allInnerTexts()
  const interfaceInput = (name: string) => tab().getByRole('textbox', { name: `${name} on Cisco IOS / IOS-XE` })

  async function openPhase1(): Promise<void> {
    await openPage()
    await newTab(CONVERT_JOB)
    await expect.poll(() => tab().getByRole('combobox', { name: 'Target platform' }).inputValue(), UI_WAIT).toBe('iosxe')
    await openWithPicker(join(CONVERT, 'phase1.conf'))
    await expect.poll(() => text('interface-count'), UI_WAIT).toBe('4 of 4 need a name')
  }

  it('converts the phase 1 fixture to IOS-XE once the interfaces are named, and saves it', async () => {
    await openPhase1()
    const lines = expected.split('\n').length - 1
    // Unnamed, the interfaces keep their Junos names: the output says it is incomplete.
    await expect.poll(() => text('output-summary'), UI_WAIT).toBe(`${lines} lines, incomplete: 4 interfaces need a name`)
    expect(await outputLines()).toContain('interface ge-0/0/0')
    expect(await interfaceInput('ge-0/0/0').getAttribute('placeholder')).toBe('GigabitEthernet0/0/0 (suggested)')
    await tab().getByRole('button', { name: 'Use suggestions' }).click()
    await expect.poll(() => text('interface-count'), UI_WAIT).toBe('all 4 named')
    await expect.poll(() => text('output-summary'), UI_WAIT).toBe(`${lines} lines`)
    expect(await outputLines()).toEqual(expected.trimEnd().split('\n'))
    expect(await saveOutput()).toEqual({ name: 'phase1.iosxe', text: expected })
    expect(await text('status-result')).toBe(`${lines} lines`)
  })

  it('changes the output names from the interface table and from a loaded map, and saves the map', async () => {
    await openPhase1()
    await interfaceInput('ge-0/0/0').fill('GigabitEthernet1')
    await expect.poll(outputLines, UI_WAIT).toContain('interface GigabitEthernet1')
    // The Junos unit 0 next hop is the main interface on IOS.
    expect(await outputLines()).toContain('ip route 198.51.100.64 255.255.255.192 GigabitEthernet1 192.0.2.2')
    await tab().getByRole('button', { name: 'Use Loopback0 for lo0' }).click()
    await expect.poll(outputLines, UI_WAIT).toContain('interface Loopback0')
    writeFileSync(join(dir, 'names.csv'), 'ge-0/0/1,GigabitEthernet2\nxe-0/1/0,TenGigabitEthernet9/9/9\n')
    const chooser = page.waitForEvent('filechooser', UI_WAIT)
    await tab().getByRole('button', { name: /^Load map/ }).click()
    await (await chooser).setFiles(join(dir, 'names.csv'))
    await expect.poll(() => text('interface-count'), UI_WAIT).toBe('all 4 named')
    expect(await outputLines()).toEqual(expect.arrayContaining(['interface GigabitEthernet2.10', 'interface TenGigabitEthernet9/9/9']))
    const download = page.waitForEvent('download', UI_WAIT)
    await tab().getByRole('button', { name: 'Save map' }).click()
    const file = await download
    const path = join(dir, `download-${++downloads}-${file.suggestedFilename()}`)
    await file.saveAs(path)
    expect({ name: file.suggestedFilename(), text: readFileSync(path, 'utf8') }).toEqual({
      name: 'interfaces.csv',
      text: 'ge-0/0/0,GigabitEthernet1\nlo0,Loopback0\nge-0/0/1,GigabitEthernet2\nxe-0/1/0,TenGigabitEthernet9/9/9\n'
    })
  })

  it('shows what did not carry over in the warnings panel and the source gutter, and jumps to it', async () => {
    await openPhase1()
    await expect
      .poll(() => tab().locator('.problem.warning').allInnerTexts(), UI_WAIT)
      .toEqual([
        'Not written for Cisco IOS / IOS-XE: IOS has no reject route: Null0 discards\nline 66, column 9',
        'Not converted: routing protocols come later\nline 74, column 1',
        'Not converted: routing protocols come later\nline 75, column 5',
        'Not converted: routing protocols come later\nline 76, column 9'
      ])
    expect(await text('problem-count')).toBe('4 warnings')
    await tab().locator('.problem.warning').first().click()
    await expect.poll(() => tab().locator('[data-pane=source] .cm-activeLine').innerText(), UI_WAIT).toBe('        route 192.0.2.192/26 reject;')
    // The gutter marks the line, saying why on hover; the line itself is marked too.
    const marker = tab().locator('[data-pane=source] .cm-issue-warning[title^="Not written"]')
    await expect.poll(() => marker.getAttribute('title'), UI_WAIT).toBe('Not written for Cisco IOS / IOS-XE: IOS has no reject route: Null0 discards')
    expect(await tab().locator('[data-pane=source] .cm-mark-warning', { hasText: 'reject' }).count()).toBe(1)
    await tab().locator('.problem.warning').last().click()
    await expect.poll(() => tab().locator('[data-pane=source] .cm-issue-warning[title^="Not converted"]').count(), UI_WAIT).toBe(3)
  })

  it("shows a render's warning at its source statement, and marks its line of the output (#112)", async () => {
    await openPage()
    await newTab(CONVERT_JOB)
    // A term that rejects: IOS-XE writes it as deny and warns at the access list's entry.
    await typeSource('firewall {\n    family inet {\n        filter EDGE {\n            term BLOCK {\n                from {\n                    protocol tcp;\n                }\n                then reject;\n            }\n        }\n    }\n}\n')
    const problem = tab().locator('.problem.warning', { hasText: 'ICMP unreachable is written as deny' })
    await expect.poll(() => problem.locator('.problem-place').innerText(), UI_WAIT).toMatch(/^line 8, column 17; output line \d+$/)
    // The output's gutter marks its line, saying why on hover.
    const marker = tab().locator('[data-pane=output] .cm-issue-warning[title^="A term that rejects"]')
    await expect.poll(() => marker.count(), UI_WAIT).toBe(1)
    expect(await tab().locator('[data-pane=output] .cm-mark-warning', { hasText: 'deny tcp' }).count()).toBe(1)
    // Clicking it goes to the source statement.
    await problem.click()
    await expect.poll(() => tab().locator('[data-pane=source] .cm-activeLine').innerText(), UI_WAIT).toBe('                then reject;')
  })

  it('links an output line to its source statement, and back', async () => {
    await openPhase1()
    await tab().getByRole('button', { name: 'Use suggestions' }).click()
    await expect.poll(() => text('interface-count'), UI_WAIT).toBe('all 4 named')
    await tab().locator('[data-pane=output] .cm-line', { hasText: 'ip address 192.0.2.1 255.255.255.252' }).click()
    await expect.poll(() => tab().locator('[data-pane=source] .cm-mark-link').allInnerTexts(), UI_WAIT).toEqual(['                address 192.0.2.1/30;'])
    // Back by the keyboard: the source pane has just scrolled to the address (on its next frame), so a click by position
    // could land on another line. Line 3 is `host-name edge-1;`.
    await tab().locator('[data-pane=source] .cm-content').focus()
    await page.keyboard.press('Control+Home')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown')
    await expect.poll(() => tab().locator('[data-pane=source] .cm-activeLine').innerText(), UI_WAIT).toBe('    host-name edge-1;')
    await expect.poll(() => tab().locator('[data-pane=output] .cm-mark-link').allInnerTexts(), UI_WAIT).toEqual(['hostname edge-1'])
  })

  it('refuses a loaded JSON map that names an interface twice, applying none of it', async () => {
    await openPhase1()
    writeFileSync(join(dir, 'twice.json'), '{"lo0":"Loopback1","lo0":"Loopback2","ge-0/0/0":"GigabitEthernet1"}')
    const chooser = page.waitForEvent('filechooser', UI_WAIT)
    await tab().getByRole('button', { name: /^Load map/ }).click()
    await (await chooser).setFiles(join(dir, 'twice.json'))
    await expect.poll(() => page.getByRole('status').innerText(), UI_WAIT).toBe('twice.json: the JSON names an interface twice')
    expect(await text('interface-count')).toBe('4 of 4 need a name')
    expect(await interfaceInput('ge-0/0/0').inputValue()).toBe('')
  })

  it('refuses a name another interface keeps, in the problems panel, by line', async () => {
    await openPhase1()
    await interfaceInput('ge-0/0/0').fill('ge-0/0/1')
    await expect
      .poll(() => tab().locator('.problem.error').allInnerTexts(), UI_WAIT)
      .toEqual(['2 interfaces would have one name on Cisco IOS / IOS-XE (lines 21, 29): give each its own.\nline 21, column 5'])
    // Both interfaces are still in the output, under their own names.
    expect(await outputLines()).toEqual(expect.arrayContaining(['interface ge-0/0/0', 'interface ge-0/0/1.10']))
  })

  it('keeps the interface table usable in a narrow window (the desktop app\'s smallest)', async () => {
    await openPhase1()
    await page.setViewportSize({ width: 720, height: 480 })
    const table = tab().locator('.interfaces')
    await expect.poll(() => table.isVisible(), UI_WAIT).toBe(true)
    const input = interfaceInput('xe-0/1/0')
    await input.scrollIntoViewIfNeeded()
    expect(await input.isVisible()).toBe(true)
    // Inside the window, not cut off.
    const box = (await input.boundingBox())!
    expect(box.x + box.width).toBeLessThanOrEqual(720)
    expect(box.y + box.height).toBeLessThanOrEqual(480)
    await input.fill('TenGigabitEthernet1/1/1')
    await expect.poll(outputLines, UI_WAIT).toContain('interface TenGigabitEthernet1/1/1')
    for (const name of ['Use suggestions', 'Load map…', 'Save map']) expect(await tab().getByRole('button', { name }).isVisible()).toBe(true)
    await tab().getByRole('button', { name: 'Use suggestions' }).click()
    await expect.poll(() => text('interface-count'), UI_WAIT).toBe('all 4 named')
  })

  it('asks for the keys, passwords and policy a target needs, masking secrets and storing none (#105)', async () => {
    await openPage()
    await newTab(CONVERT_JOB)
    await tab().getByRole('combobox', { name: 'Target platform' }).selectOption('iosxr')
    await openWithPicker(join(CONVERT, 'secrets.conf'))
    await tab().getByRole('textbox', { name: 'ge-0/0/0 on Cisco IOS-XR' }).fill('GigabitEthernet0/0/0/0')
    await expect.poll(() => text('input-count'), UI_WAIT).toBe('3 of 3 need an answer')
    await expect.poll(() => text('output-summary'), UI_WAIT).toMatch(/, incomplete: 3 items need an answer$/)
    const panel = tab().getByRole('region', { name: 'Needs input' })
    const key = panel.getByLabel(/^OSPF MD5 authentication on an interface/)
    const password = panel.getByLabel(/^A BGP session with a password/)
    const policy = panel.getByLabel(/^An eBGP neighbor has no route policy/)
    // Secrets are masked; the policy's name isn't a secret.
    expect([await key.getAttribute('type'), await password.getAttribute('type'), await policy.getAttribute('type')]).toEqual(['password', 'password', 'text'])
    await key.fill('7 SYNTHETIC_KEY')
    await password.fill('SYNTHETIC_PASSWORD')
    await policy.fill('PASS-ALL')
    await expect.poll(() => text('input-count'), UI_WAIT).toBe('all 3 answered')
    await expect.poll(outputLines, UI_WAIT).toContain('  password clear SYNTHETIC_PASSWORD')
    expect(await outputLines()).toContain('   message-digest-key 7 md5 clear SYNTHETIC_KEY')
    expect(await outputLines()).toContain('   route-policy PASS-ALL in')
    expect(await text('output-summary')).not.toContain('incomplete')
    // Shown on request, masked again after.
    await panel.getByRole('button', { name: 'Show secrets' }).click()
    await expect.poll(() => key.getAttribute('type'), UI_WAIT).toBe('text')
    await panel.getByRole('button', { name: 'Hide secrets' }).click()
    await expect.poll(() => key.getAttribute('type'), UI_WAIT).toBe('password')
    // An answer the target doesn't take is asked again, without repeating it.
    await key.fill('SYNTHETIC_NO_ID')
    await expect.poll(() => panel.getByText("Not in the form asked for, so it isn't used.").count(), UI_WAIT).toBe(1)
    expect(await text('input-count')).toBe('1 of 3 need an answer')
    expect(await tab().getByRole('region', { name: 'Problems' }).innerText()).not.toContain('SYNTHETIC')
    // No answer reaches the page's storage.
    const stored = await page.evaluate(async () => JSON.stringify({ local: Object.entries(localStorage), session: Object.entries(sessionStorage), databases: (await indexedDB.databases()).map((d) => d.name) }))
    expect(stored).not.toContain('SYNTHETIC')
    expect(stored).not.toContain('PASS-ALL')
    // In the desktop app's smallest window, the panel stacks under the interfaces and its fields stay reachable.
    await page.setViewportSize({ width: 720, height: 480 })
    await policy.scrollIntoViewIfNeeded()
    const box = (await policy.boundingBox())!
    expect(box.x + box.width).toBeLessThanOrEqual(720)
    expect(box.y + box.height).toBeLessThanOrEqual(480)
    expect(await panel.getByRole('button', { name: 'Show secrets' }).isVisible()).toBe(true)
  })

  it('keeps the display set tab as it was beside the convert tab', async () => {
    await openPhase1()
    await page.getByRole('tab', { name: 'Untitled → Display set' }).click()
    await expect.poll(() => tab().locator('[data-pane=output] .cm-placeholder').innerText(), UI_WAIT).toBe('The display set appears here.')
    expect(await tab().locator('.interfaces').count()).toBe(0)
    await page.getByRole('tab', { name: /^phase1\.conf → IOS-XE/ }).click()
    await expect.poll(() => text('interface-count'), UI_WAIT).toBe('4 of 4 need a name')
  })
})

describe('tabs and the menu bar in the web build', () => {
  const PHASE1 = join(__dirname, '../../../packages/cli/tests/fixtures/convert/phase1.conf')
  const firstOutputLine = (): Promise<string> => tab().locator('[data-pane=output] .cm-line').first().innerText()
  /** The Window menu's ticked entry, read with the menu open and closed again. */
  async function ticked(): Promise<string[]> {
    await page.getByRole('menubar').getByRole('menuitem', { name: 'Window', exact: true }).click()
    const labels = await menuOf('Window').locator('[role=menuitemradio][aria-checked=true] .menu-label').allInnerTexts()
    await page.keyboard.press('Escape')
    await expect.poll(() => menuOf('Window').count(), UI_WAIT).toBe(0)
    return labels
  }
  /** The focused element's label: a menu item's, or a menu bar button's. */
  const focused = (): Promise<string> => page.evaluate(() => (document.activeElement?.querySelector('.menu-label') ?? document.activeElement)?.textContent?.trim() ?? '')

  it('keeps each tab its own output, switching with the Window menu (the tick moves) and the keyboard', async () => {
    await openPage()
    await typeSource('system { host-name r1; }')
    await expect.poll(firstOutputLine, UI_WAIT).toBe('set system host-name r1')
    await newTab(CONVERT_JOB)
    await typeSource('system { host-name r2; }')
    await expect.poll(firstOutputLine, UI_WAIT).toBe('hostname r2')
    expect(await tabs()).toEqual({ titles: ['Untitled → Display set', 'Untitled → IOS-XE'], current: 'Untitled → IOS-XE' })
    // Both have unsaved output: the strip and the Window menu show a dot.
    expect(await page.locator('.tab .tab-dot').count()).toBe(2)
    expect(await ticked()).toEqual(['Untitled → IOS-XE •'])
    await menu('Window', 'Untitled → Display set •')
    await expect.poll(() => tabs().then((t) => t.current), UI_WAIT).toBe('Untitled → Display set')
    await expect.poll(firstOutputLine, UI_WAIT).toBe('set system host-name r1')
    expect(await ticked()).toEqual(['Untitled → Display set •'])
    // The shortcuts: next and previous (Ctrl+Tab, Ctrl+Shift+Tab, Ctrl+PageDown), a tab by its place (Ctrl+2, and
    // the browser-safe Alt+1).
    const current = async (): Promise<{ tab: string; line: string }> => ({ tab: (await tabs()).current, line: await firstOutputLine() })
    await page.keyboard.press('Control+Tab')
    await expect.poll(current, UI_WAIT).toEqual({ tab: 'Untitled → IOS-XE', line: 'hostname r2' })
    await page.keyboard.press('Control+Shift+Tab')
    await expect.poll(current, UI_WAIT).toEqual({ tab: 'Untitled → Display set', line: 'set system host-name r1' })
    await page.keyboard.press('Control+2')
    await expect.poll(current, UI_WAIT).toEqual({ tab: 'Untitled → IOS-XE', line: 'hostname r2' })
    await page.keyboard.press('Alt+1')
    await expect.poll(current, UI_WAIT).toEqual({ tab: 'Untitled → Display set', line: 'set system host-name r1' })
    await page.keyboard.press('Control+PageDown')
    await expect.poll(current, UI_WAIT).toEqual({ tab: 'Untitled → IOS-XE', line: 'hostname r2' })
    expect(await ticked()).toEqual(['Untitled → IOS-XE •'])
    // The tab strip by the keyboard: the arrow keys move along it.
    await page.getByRole('tab', { selected: true }).focus()
    await page.keyboard.press('ArrowLeft')
    await expect.poll(current, UI_WAIT).toEqual({ tab: 'Untitled → Display set', line: 'set system host-name r1' })
  })

  it("keeps Tab inside the new tab picker, through every control in order, both ways, wrapping at its ends", async () => {
    await openPage()
    await menu('File', 'New Tab…')
    const picker = page.getByRole('dialog', { name: 'New tab' })
    await picker.waitFor(UI_WAIT)
    /** The focused control, by its label or text. */
    const at = (): Promise<string> => page.evaluate(() => { const el = document.activeElement as HTMLElement; return (el.getAttribute('aria-label') ?? el.querySelector('.picker-label')?.textContent ?? el.textContent ?? '').trim() })
    const order = ['Display set (Junos)', 'Convert from', 'Convert to', 'Convert: Junos → Cisco IOS / IOS-XE', 'Cancel']
    await expect.poll(at, UI_WAIT).toBe(order[0])
    for (const next of [...order.slice(1), order[0]]) {
      await page.keyboard.press('Tab')
      await expect.poll(at, UI_WAIT).toBe(next)
    }
    for (const previous of [order[4], order[3], order[2], order[1], order[0]]) {
      await page.keyboard.press('Shift+Tab')
      await expect.poll(at, UI_WAIT).toBe(previous)
    }
    // The case the trap missed: back from a list goes to the list before it, not to Cancel.
    await picker.getByRole('combobox', { name: 'Convert to' }).focus()
    await page.keyboard.press('Shift+Tab')
    await expect.poll(at, UI_WAIT).toBe('Convert from')
  })

  it('converts between any two platforms, chosen in the new tab picker and then in the tab', async () => {
    await openPage()
    await menu('File', 'New Tab…')
    const picker = page.getByRole('dialog', { name: 'New tab' })
    await picker.getByRole('combobox', { name: 'Convert from' }).selectOption('nxos')
    await picker.getByRole('combobox', { name: 'Convert to' }).selectOption('iosxr')
    await picker.getByRole('button', { name: 'Convert: Cisco NX-OS → Cisco IOS-XR' }).click()
    await expect.poll(() => tabs().then((t) => t.current), UI_WAIT).toBe('Untitled → IOS-XR')
    expect(await tab().locator('[data-pane=source] .cm-placeholder').innerText()).toBe('Paste a Cisco NX-OS config here, open a file, or drop one anywhere in this window.')
    await typeSource('hostname n1\n')
    await expect.poll(firstOutputLine, UI_WAIT).toBe('hostname n1')
    expect(await text('status-result')).toMatch(/^\d+ lines?$/)
    // The tab's source changes on its own; the target stays.
    await tab().getByRole('combobox', { name: 'Source platform' }).selectOption('iosxe')
    expect(await tab().getByRole('combobox', { name: 'Target platform' }).inputValue()).toBe('iosxr')
    await expect.poll(firstOutputLine, UI_WAIT).toBe('hostname n1')
    expect(await page.locator('.statusbar .status-item').first().innerText()).toBe('Cisco IOS / IOS-XE → Cisco IOS-XR')
  })

  it('asks before closing a tab with unsaved output, by Ctrl+W, middle-click or ×, and saves first when asked', async () => {
    await openPage()
    await typeSource('system { host-name r1; }')
    await expect.poll(() => text('output-summary'), UI_WAIT).toBe(commands(1))
    const dialog = page.getByRole('dialog', { name: 'Close Untitled → Display set?' })
    await page.keyboard.press('Control+W')
    await expect.poll(() => dialog.isVisible(), UI_WAIT).toBe(true)
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect.poll(() => dialog.count(), UI_WAIT).toBe(0)
    expect((await tabs()).titles).toEqual(['Untitled → Display set'])
    // Middle-click, then close without saving: no tab is left, and the page offers a new one.
    await page.getByRole('tab', { name: /^Untitled → Display set/ }).click({ button: 'middle' })
    await dialog.getByRole('button', { name: 'Close without saving' }).click()
    await expect.poll(() => tabs(), UI_WAIT).toEqual({ titles: [], current: '' })
    expect(await page.locator('.no-tabs h1').innerText()).toBe('No tabs open')
    await page.locator('.no-tabs').getByRole('button', { name: DISPLAY_SET_JOB }).click()
    await typeSource('system { host-name r2; }')
    // ×, then save and close: the output downloads and the tab goes.
    await page.getByRole('button', { name: /^Close Untitled → Display set/ }).click()
    const download = page.waitForEvent('download', UI_WAIT)
    await dialog.getByRole('button', { name: 'Save and close' }).click()
    expect((await download).suggestedFilename()).toBe('display-set.set')
    await expect.poll(() => tabs().then((t) => t.titles), UI_WAIT).toEqual([])
    // A tab with nothing unsaved closes at once.
    await newTab(CONVERT_JOB)
    await page.keyboard.press('Control+W')
    await expect.poll(() => tabs().then((t) => t.titles), UI_WAIT).toEqual([])
    expect(await page.getByRole('dialog').count()).toBe(0)
    // Saved output is saved: closing asks nothing.
    await newTab(DISPLAY_SET_JOB)
    await typeSource('system { host-name r3; }')
    await expect.poll(() => page.locator('.tab .tab-dot').count(), UI_WAIT).toBe(1)
    await saveOutput()
    await expect.poll(() => page.locator('.tab .tab-dot').count(), UI_WAIT).toBe(0)
    await menu('File', 'Close Tab')
    await expect.poll(() => tabs().then((t) => t.titles), UI_WAIT).toEqual([])
  })

  it('has the browser ask before the page closes or reloads, only while a tab has unsaved output', async () => {
    await openPage()
    // Whether the page cancels an unload now (the browser then asks, in its own words).
    const asks = (): Promise<boolean> =>
      page.evaluate(() => {
        const e = new Event('beforeunload', { cancelable: true })
        window.dispatchEvent(e)
        return e.defaultPrevented
      })
    expect(await asks()).toBe(false)
    await typeSource('system { host-name r1; }')
    await expect.poll(asks, UI_WAIT).toBe(true)
    await saveOutput()
    await expect.poll(asks, UI_WAIT).toBe(false)
    // Another tab's unsaved output counts too, until that tab is closed without saving.
    await newTab(DISPLAY_SET_JOB)
    await typeSource('system { host-name r2; }')
    await expect.poll(asks, UI_WAIT).toBe(true)
    // A real close: the browser's question, which the test dismisses; the page stays, and no in-page dialog shows.
    const asked = new Promise<string>((resolve) =>
      page.once('dialog', (d) => {
        resolve(d.type())
        void d.dismiss()
      })
    )
    await page.close({ runBeforeUnload: true })
    expect(await asked).toBe('beforeunload')
    expect(page.isClosed()).toBe(false)
    expect(await page.getByRole('dialog').count()).toBe(0)
    await page.keyboard.press('Control+W')
    await page.getByRole('dialog', { name: /^Close / }).getByRole('button', { name: 'Close without saving' }).click()
    await expect.poll(asks, UI_WAIT).toBe(false)
  })

  it('brings the tabs back after a reload, with their file names and jobs but never their contents', async () => {
    await openPage()
    await openWithPicker(fixture('config_15.conf'))
    await expect.poll(() => text('output-summary'), UI_WAIT).toBe(commands(12))
    await newTab(CONVERT_JOB)
    await openWithPicker(PHASE1)
    await tab().getByRole('button', { name: 'Use suggestions' }).click()
    await expect.poll(() => text('interface-count'), UI_WAIT).toBe('all 4 named')
    await menu('Help', 'License')
    // The page's storage holds the tabs' jobs and file names, and nothing else: no config, output or interface name.
    const stored = await page.evaluate(async () => ({
      local: Object.fromEntries(Object.keys(localStorage).map((k) => [k, localStorage.getItem(k)])),
      session: sessionStorage.length,
      databases: (await indexedDB.databases()).map((d) => d.name)
    }))
    expect(stored.session).toBe(0)
    expect(stored.databases).toEqual([])
    expect(Object.keys(stored.local)).toEqual(['dialect.session'])
    expect(JSON.parse(stored.local['dialect.session']!)).toEqual({
      tabs: [
        { kind: 'conversion', job: { kind: 'tool', tool: 'junos.display-set' }, name: 'config_15.conf' },
        { kind: 'conversion', job: { kind: 'convert', source: 'junos', target: 'iosxe' }, name: 'phase1.conf' },
        { kind: 'docs', page: 'license' }
      ],
      active: 2
    })
    const lines = [readFileSync(fixture('config_15.conf'), 'utf8'), readFileSync(PHASE1, 'utf8'), expectedOutput(15)].flatMap((c) => c.split('\n').map((l) => l.trim()).filter((l) => l.length > 3))
    expect(lines.filter((l) => stored.local['dialect.session']!.includes(l))).toEqual([])

    await page.reload()
    await page.getByRole('tablist').waitFor(UI_WAIT)
    await expect.poll(() => tabs(), UI_WAIT).toEqual({ titles: ['config_15.conf → Display set', 'phase1.conf → IOS-XE', 'License'], current: 'License' })
    await expect.poll(() => tab().locator('.docs-page h1').first().innerText(), UI_WAIT).toBe('License')
    // The convert tab is there without its config, offering to open it again.
    await page.getByRole('tab', { name: /^phase1\.conf → IOS-XE/ }).click()
    // An empty source: the editor shows its placeholder.
    await expect.poll(() => tab().locator('[data-pane=source] .cm-placeholder').count(), UI_WAIT).toBe(1)
    expect(await text('interface-count')).toBe('none')
    const reopen = tab().getByRole('button', { name: 'Reopen phase1.conf…' })
    const chooser = page.waitForEvent('filechooser', UI_WAIT)
    await reopen.click()
    await (await chooser).setFiles(PHASE1)
    await expect.poll(() => text('interface-count'), UI_WAIT).toBe('4 of 4 need a name')
    expect(await reopen.count()).toBe(0)
  })

  it('works the menu bar with the keyboard: Alt or F10, the arrow keys, Home and End, Enter and Esc', async () => {
    await openPage('dark')
    await page.keyboard.press('Alt')
    await expect.poll(focused, UI_WAIT).toBe('File')
    await page.keyboard.press('ArrowRight')
    await expect.poll(focused, UI_WAIT).toBe('Edit')
    // Down opens the menu at its first item; disabled items are passed over (Copy Output, with no output).
    await page.keyboard.press('ArrowDown')
    await expect.poll(focused, UI_WAIT).toBe('Undo')
    expect(await page.getByRole('menubar').getByRole('menuitem', { name: 'Edit', exact: true }).getAttribute('aria-expanded')).toBe('true')
    expect(await itemOf('Edit', 'Copy Output').getAttribute('aria-disabled')).toBe('true')
    await page.keyboard.press('End')
    await expect.poll(focused, UI_WAIT).toBe('Paste')
    await page.keyboard.press('ArrowDown')
    await expect.poll(focused, UI_WAIT).toBe('Undo')
    // Right goes to the next menu, open; Enter runs the item and closes the menu.
    await page.keyboard.press('ArrowRight')
    await expect.poll(focused, UI_WAIT).toBe('System Theme')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme), UI_WAIT).toBe('light')
    expect(await page.getByRole('menu').count()).toBe(0)
    // Esc closes the menu, then leaves the bar.
    await page.keyboard.press('F10')
    await expect.poll(focused, UI_WAIT).toBe('File')
    await page.keyboard.press('Enter')
    await expect.poll(focused, UI_WAIT).toBe('New Tab…')
    await page.keyboard.press('Escape')
    await expect.poll(() => page.getByRole('menu').count(), UI_WAIT).toBe(0)
    await expect.poll(focused, UI_WAIT).toBe('File')
    await page.keyboard.press('Escape')
    await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('[role=menubar]')), UI_WAIT).toBe(false)
    // Home and End along the bar, Up opens a menu at its last item.
    await page.keyboard.press('Alt')
    await page.keyboard.press('End')
    await expect.poll(focused, UI_WAIT).toBe('Help')
    await page.keyboard.press('ArrowUp')
    await expect.poll(focused, UI_WAIT).toBe('About Dialect')
    await page.keyboard.press('Home')
    await expect.poll(focused, UI_WAIT).toBe('User Guide')
    await page.keyboard.press('Enter')
    await expect.poll(() => tabs().then((t) => t.current), UI_WAIT).toBe('User Guide')
    // The web build has no Exit: a page can't close its browser tab.
    await page.getByRole('menubar').getByRole('menuitem', { name: 'File', exact: true }).click()
    expect(await menuOf('File').locator('.menu-label').allInnerTexts()).toEqual(['New Tab…', 'Open…', 'Save Output', 'Save Output As…', 'Close Tab'])
  })

  it('puts what the clipboard and the file picker give in the tab that asked, though another is shown by then', async () => {
    await openPage()
    await typeSource('system { host-name r1; }')
    await newTab(DISPLAY_SET_JOB)
    await typeSource('system { host-name r2; }')
    await expect.poll(firstOutputLine, UI_WAIT).toBe('set system host-name r2')
    // A clipboard that answers only when the test says.
    await page.evaluate(() => {
      const probe = window as unknown as { __answer?: (text: string) => void }
      navigator.clipboard.readText = () => new Promise<string>((resolve) => (probe.__answer = resolve))
    })
    await page.keyboard.press('Control+1')
    await expect.poll(firstOutputLine, UI_WAIT).toBe('set system host-name r1')
    await tab().getByRole('button', { name: 'Paste' }).click()
    await page.keyboard.press('Control+2')
    await expect.poll(firstOutputLine, UI_WAIT).toBe('set system host-name r2')
    await page.evaluate(() => (window as unknown as { __answer: (text: string) => void }).__answer('system { host-name pasted; }'))
    // The second tab, shown, keeps its config; the first got the paste.
    await expect.poll(() => page.locator('[role=tabpanel] [data-pane=output]').count(), UI_WAIT).toBe(2)
    expect(await firstOutputLine()).toBe('set system host-name r2')
    await page.keyboard.press('Control+1')
    await expect.poll(firstOutputLine, UI_WAIT).toBe('set system host-name pasted')
    // A file picked after moving to another tab opens in the tab it was asked for from.
    const chooser = page.waitForEvent('filechooser', UI_WAIT)
    await tab().getByRole('button', { name: /^Open/ }).click()
    const picker = await chooser
    await page.keyboard.press('Control+2')
    await picker.setFiles(fixture('config_1.conf'))
    await page.keyboard.press('Control+1')
    await expect.poll(() => text('source-name'), UI_WAIT).toBe('config_1.conf')
    await page.keyboard.press('Control+2')
    await expect.poll(firstOutputLine, UI_WAIT).toBe('set system host-name r2')
    expect(await text('source-name')).toBe('Pasted text')
  })

  it('keeps the Window menu inside the smallest window with 20 tabs, scrolling, every entry reachable', async () => {
    await openPage()
    await page.setViewportSize({ width: 720, height: 480 })
    for (let i = 1; i < 20; i++) {
      await page.keyboard.press('Alt+T')
      await page.getByRole('dialog', { name: 'New tab' }).waitFor(UI_WAIT)
      await page.keyboard.press('Enter')
      await expect.poll(() => tabs().then((t) => t.titles.length), UI_WAIT).toBe(i + 1)
    }
    await page.getByRole('menubar').getByRole('menuitem', { name: 'Window', exact: true }).focus()
    // Up opens it at its last item, Previous Tab: scrolled into view, inside the window.
    await page.keyboard.press('ArrowUp')
    await expect.poll(focused, UI_WAIT).toBe('Previous Tab')
    const menuBox = (await menuOf('Window').boundingBox())!
    expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(480)
    expect(await menuOf('Window').evaluate((m) => m.scrollHeight > m.clientHeight)).toBe(true)
    const last = (await itemOf('Window', 'Previous Tab').boundingBox())!
    expect(last.y).toBeGreaterThanOrEqual(menuBox.y)
    expect(last.y + last.height).toBeLessThanOrEqual(Math.min(480, menuBox.y + menuBox.height))
    // And by the pointer: the last entry, after scrolling.
    await itemOf('Window', 'Previous Tab').click()
    await expect.poll(() => page.getByRole('tab', { selected: true }).evaluate((t) => [...t.parentElement!.children].indexOf(t)), UI_WAIT).toBe(18)
  })

  it('gives the focus back to the editor it came from: Esc from the bar, F10 again, or after running an item', async () => {
    await openPage()
    const sourceText = (): Promise<string> => tab().locator('[data-pane=source] .cm-content').innerText()
    await typeSource('system {')
    await page.keyboard.press('Alt')
    await page.keyboard.press('ArrowDown')
    await expect.poll(focused, UI_WAIT).toBe('New Tab…')
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    await page.keyboard.insertText(' host-name r1;')
    await expect.poll(sourceText, UI_WAIT).toBe('system { host-name r1;')
    await page.keyboard.press('F10')
    await expect.poll(focused, UI_WAIT).toBe('File')
    await page.keyboard.press('F10')
    await page.keyboard.insertText(' }')
    await expect.poll(sourceText, UI_WAIT).toBe('system { host-name r1; }')
    // View → Light Theme by the keyboard, then on typing.
    await page.keyboard.press('Alt')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown')
    await expect.poll(focused, UI_WAIT).toBe('Light Theme')
    await page.keyboard.press('Enter')
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme), UI_WAIT).toBe('light')
    await page.keyboard.insertText('#')
    await expect.poll(sourceText, UI_WAIT).toBe('system { host-name r1; }#')
  })

  it('keeps the menu bar and the tab strip usable in a narrow window, the strip scrolling', async () => {
    await openPage()
    await page.setViewportSize({ width: 720, height: 480 })
    for (let i = 0; i < 6; i++) await newTab(i % 2 ? CONVERT_JOB : DISPLAY_SET_JOB)
    const strip = await page.getByRole('tablist').evaluate((list) => ({ scroll: list.scrollWidth, width: list.clientWidth }))
    expect(strip.scroll).toBeGreaterThan(strip.width)
    // The current tab (the last) is scrolled into view, inside the window.
    const current = (await page.getByRole('tab', { selected: true }).boundingBox())!
    expect(current.x).toBeGreaterThanOrEqual(0)
    expect(current.x + current.width).toBeLessThanOrEqual(720)
    for (const name of ['File', 'Edit', 'View', 'Window', 'Help']) {
      const box = (await page.getByRole('menubar').getByRole('menuitem', { name, exact: true }).boundingBox())!
      expect(box.x + box.width).toBeLessThanOrEqual(720)
    }
    expect(await page.getByRole('button', { name: 'New tab' }).isVisible()).toBe(true)
    await page.getByRole('menubar').getByRole('menuitem', { name: 'Window', exact: true }).click()
    const menuBox = (await menuOf('Window').boundingBox())!
    expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(720)
    await itemOf('Window', 'Untitled → Display set').first().click()
    await expect.poll(() => tabs().then((t) => t.current), UI_WAIT).toBe('Untitled → Display set')
    const first = (await page.getByRole('tab', { selected: true }).boundingBox())!
    expect(first.x).toBeGreaterThanOrEqual(0)
  })
})

// Writes light and dark screenshots of a fixture for the card's report, when asked: DIALECT_SCREENSHOTS=<folder>.
const shots = process.env.DIALECT_SCREENSHOTS
describe.runIf(Boolean(shots))('screenshots', () => {
  it.each(['dark', 'light'] as const)('%s', async (scheme) => {
    await openPage(scheme)
    await openWithPicker(fixture('config_15.conf'))
    await expect.poll(() => text('output-summary'), UI_WAIT).toBe(commands(12))
    await tab().locator('[data-pane=output] .cm-line').nth(6).click()
    await expect.poll(() => tab().locator('[data-pane=source] .cm-mark-link').count(), UI_WAIT).toBe(1)
    await page.screenshot({ path: join(shots!, `dialect-${scheme}.png`) })
    await typeSource('system {\n    /* lab */\n    host-name r1\n}\n')
    await expect.poll(() => text('problem-count'), UI_WAIT).toBe('1 error')
    await page.screenshot({ path: join(shots!, `dialect-${scheme}-error.png`) })
    await newTab(CONVERT_JOB)
    await openWithPicker(join(__dirname, '../../../packages/cli/tests/fixtures/convert/phase1.conf'))
    await expect.poll(() => text('interface-count'), UI_WAIT).toBe('4 of 4 need a name')
    await tab().getByRole('button', { name: 'Use GigabitEthernet0/0/0 for ge-0/0/0' }).click()
    await tab().locator('.problem.warning').first().click()
    await expect.poll(() => text('interface-count'), UI_WAIT).toBe('3 of 4 need a name')
    await page.screenshot({ path: join(shots!, `dialect-${scheme}-convert.png`) })
    await page.setViewportSize({ width: 720, height: 480 })
    await page.screenshot({ path: join(shots!, `dialect-${scheme}-convert-narrow.png`) })
    await page.setViewportSize({ width: 1280, height: 760 })
    await menu('Help', 'User Guide')
    await page.getByRole('menubar').getByRole('menuitem', { name: 'Window', exact: true }).click()
    await page.screenshot({ path: join(shots!, `dialect-${scheme}-tabs.png`) })
    await page.keyboard.press('Escape')
    await menu('File', 'New Tab…')
    await page.screenshot({ path: join(shots!, `dialect-${scheme}-new-tab.png`) })
    await page.keyboard.press('Escape')
    await menu('Help', 'About Dialect')
    await expect.poll(() => page.getByTestId('about-info').innerText(), UI_WAIT).toContain('OS')
    await page.screenshot({ path: join(shots!, `dialect-${scheme}-about.png`) })
    writeFileSync(join(shots!, 'size.txt'), `${readFileSync(join(dir, 'dist', 'dialect.html')).length}\n`)
  })
})
