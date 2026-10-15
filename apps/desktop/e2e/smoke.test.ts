// The desktop app's smoke test: the built app (run from the build output, not installed) driven through Microsoft Edge
// WebDriver (e2e/webdriver.ts). It drops a fixture on the window, which the desktop Platform reads, and checks the display
// set output; then About and the Docs tabs, convert in a tab of its own and a switch back through the Window menu, that
// the CSP blocks inline scripts and the network, that the fs plugin reads no file the user hasn't picked and the opener
// no link but an https one, and last that File → Exit quits. The logic itself is the web build's, tested there.
//
// msedgedriver attaches to the app (`debuggerAddress`) rather than starting it: on GitHub's runners WebView2 never opened
// the debugging port a driver passes through WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS, as tauri-driver does ("DevToolsActivePort
// file doesn't exist": a WebView2 regression from runtime 133, actions/runner-images#14738, WebView2Feedback#5415). So
// the app is built with its own `--remote-debugging-port=0` in its window's browser arguments, beside wry's defaults,
// and the test reads the port WebView2 picked from DevToolsActivePort. That build goes to src-tauri/target/e2e, apart
// from the release build the installers are made from, which never opens a port. It has an identifier of its own, so
// its WebView2 profile is its own app data folder (Tauri always passes WebView2 `%LOCALAPPDATA%\<identifier>`, which
// wins over WEBVIEW2_USER_DATA_FOLDER), removed before and after: an installed Dialect's tabs and settings stay untouched.
//
// Needs Rust (the build) and the msedgedriver that matches the installed WebView2, found through MSEDGEDRIVER (its path)
// or on PATH. `npm run test:smoke -w @dialect/desktop` builds the app first (incremental after the first build), as the
// web tests build the page.
import { execFileSync, spawn, type ChildProcess } from 'child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { createServer } from 'net'
import { createRequire } from 'module'
import { dirname, join } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { childEnv } from '../../../tests/childEnv'
import { newSession, type Session } from './webdriver'

const desktop = join(__dirname, '..')
// The Tauri CLI's own entry (its bin), wherever npm installed it.
const tauriCli = join(dirname(createRequire(import.meta.url).resolve('@tauri-apps/cli/package.json')), 'tauri.js')
/** The smoke test's own build of the app, apart from the release build (src-tauri/target/release). */
const targetDir = join(desktop, 'src-tauri', 'target', 'e2e')
const app = join(targetDir, 'release', 'dialect.exe')
const tauriConf = JSON.parse(readFileSync(join(desktop, 'src-tauri', 'tauri.conf.json'), 'utf8')) as { app: { windows: Record<string, unknown>[] } }
/** wry's own browser arguments, which a window's `additionalBrowserArgs` replaces (tauri-utils' config.rs). */
const WRY_ARGS = '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection'
/** The test build's identifier, never an installed Dialect's (io.github.suremise.dialect). */
const E2E_IDENTIFIER = 'io.github.suremise.dialect.smoketest'
/** The test build's app data folder, its WebView2 profile in EBWebView: the test's own, removed before and after. */
const appData = join(process.env.LOCALAPPDATA ?? '', E2E_IDENTIFIER)
const activePort = join(appData, 'EBWebView', 'DevToolsActivePort')
const FIXTURES = join(__dirname, '../../../packages/platform-junos/tests/fixtures/display-set')
/** How long the app may take to show what an action leads to: a bound for a hung app, not a wait. */
const UI_WAIT = { timeout: 15_000, interval: 100 }
/** How long WebView2 may take to start and open its debugging port, the first time on a fresh machine too. */
const START_WAIT = { timeout: 60_000, interval: 250 }
/** About's notice, word for word (card #42). */
const NOTICE =
  "© 2026 Darren Marshall. Dialect is independently developed and isn't affiliated with, endorsed or sponsored by Juniper Networks or Cisco Systems. Juniper and Junos are trademarks of Juniper Networks, Inc.; Cisco, IOS, IOS-XE, NX-OS and IOS-XR are trademarks of Cisco Systems, Inc."

/** A program on PATH, or null. */
function onPath(name: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(';')) {
    const path = join(dir, name)
    if (dir && existsSync(path)) return path
  }
  return null
}

/** A free TCP port on localhost. */
const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => (typeof address === 'object' && address ? resolve(address.port) : reject(new Error('no port'))))
    })
  })

/** Collects a child's output, for the error when something fails. */
function logOf(child: ChildProcess): () => string {
  let log = ''
  child.stdout?.on('data', (d) => (log += d))
  child.stderr?.on('data', (d) => (log += d))
  return () => log.trim() || 'nothing'
}

let driver: ChildProcess | undefined
let driverLog = (): string => 'nothing'
let dialect: ChildProcess | undefined
let dialectLog = (): string => 'nothing'
let session: Session | undefined

/** Removes the test build's app data folder, once WebView2's processes, which outlive the app a moment, let go of it. */
async function removeAppData(): Promise<void> {
  if (!process.env.LOCALAPPDATA) return
  await vi.waitFor(() => {
    rmSync(appData, { recursive: true, force: true })
    if (existsSync(appData)) throw new Error(`${appData} is still there`)
  }, START_WAIT)
}

beforeAll(async () => {
  const native = process.env.MSEDGEDRIVER ?? onPath('msedgedriver.exe')
  if (!native || !existsSync(native)) throw new Error('msedgedriver.exe (matching the installed WebView2) is needed: set MSEDGEDRIVER to its path, or put it on PATH')

  // The app as `npm run build` makes it, without the installer, with its debugging port, and apart from an installed
  // Dialect: an identifier of its own (so its app data folder too) and a window title that says what it is. Incremental
  // once built. The --config file is merged over tauri.conf.json, whose window list it replaces whole.
  const [main, ...others] = tauriConf.app.windows
  const conf = join(targetDir, 'e2e.conf.json')
  mkdirSync(targetDir, { recursive: true })
  writeFileSync(conf, JSON.stringify({ identifier: E2E_IDENTIFIER, app: { windows: [{ ...main, title: 'Dialect (smoke test)', additionalBrowserArgs: `${WRY_ARGS} --remote-debugging-port=0` }, ...others] } }))
  execFileSync(process.execPath, [tauriCli, 'build', '--no-bundle', '--config', conf], { cwd: desktop, env: { ...childEnv(), CARGO_TARGET_DIR: targetDir }, stdio: 'pipe' })
  expect(existsSync(app), app).toBe(true)

  // The app with a fresh profile, then the port its WebView2 picked: DevToolsActivePort's first line, written into the
  // profile once it listens.
  if (!process.env.LOCALAPPDATA) throw new Error('LOCALAPPDATA is needed: the test build keeps its WebView2 profile there')
  await removeAppData()
  const started = spawn(app, [], { env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
  dialect = started
  dialectLog = logOf(started)
  const debugPort = await vi.waitFor(() => {
    if (started.exitCode !== null) throw new Error(`dialect.exe exited with ${started.exitCode}: ${dialectLog()}`)
    const port = existsSync(activePort) ? Number(readFileSync(activePort, 'utf8').split(/\r?\n/)[0]) : NaN
    if (!(port > 0)) throw new Error(`no ${activePort} yet: WebView2 didn't open its debugging port in the test's profile`)
    return port
  }, START_WAIT)

  const port = await freePort()
  driver = spawn(native, [`--port=${port}`], { env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
  driverLog = logOf(driver)
  // Ready once it answers.
  await vi.waitFor(async () => {
    if (!(await fetch(`http://127.0.0.1:${port}/status`)).ok) throw new Error('msedgedriver is not ready')
  }, UI_WAIT)
  try {
    session = await newSession(`http://127.0.0.1:${port}`, { browserName: 'webview2', 'ms:edgeOptions': { debuggerAddress: `127.0.0.1:${debugPort}` } })
  } catch (error) {
    throw new Error(`${(error as Error).message}\nmsedgedriver said: ${driverLog()}\ndialect.exe said: ${dialectLog()}`, { cause: error })
  }
}, 600_000)

// Also after a failed setup: whatever it started stops, and the profile goes.
afterAll(async () => {
  // Attached, ending the session leaves the app running: the last test quits it, or this stops it.
  await session?.close().catch(() => {})
  for (const child of [dialect, driver]) {
    if (!child || child.exitCode !== null) continue
    const exited = new Promise((resolve) => child.once('exit', resolve))
    child.kill()
    await exited
  }
  await removeAppData()
}, 120_000)

const page = (): Session => {
  if (!session) throw new Error(`no WebDriver session (msedgedriver said: ${driverLog()})`)
  return session
}

/** Clicks the element `selector` finds with this text, trimmed; false if there is none. */
const click = (selector: string, label: string): Promise<boolean> =>
  page().execute(
    (sel: string, text: string) => {
      const target = [...document.querySelectorAll<HTMLElement>(sel)].find((el) => el.textContent?.trim() === text)
      target?.click()
      return !!target
    },
    selector,
    label
  )

/** Runs a menu bar item: the menu, then the item by its label. */
async function menu(name: string, item: string): Promise<void> {
  expect(await click('[role=menubar] [data-menubar-item]', name)).toBe(true)
  await expect.poll(() => click('[role=menu] .menu-label', item), UI_WAIT).toBe(true)
}

/** Drops a file on the source editor of the tab shown: the UI's drop handler (capture phase) gives it to platform.openDropped. */
const drop = (name: string, content: string): Promise<unknown> =>
  page().execute(
    (file: string, text: string) => {
      const target = document.querySelector('[role=tabpanel]:not([hidden]) [data-pane="source"]')!
      const transfer = new DataTransfer()
      transfer.items.add(new File([text], file, { type: 'text/plain' }))
      for (const type of ['dragenter', 'dragover', 'drop']) target.dispatchEvent(new DragEvent(type, { dataTransfer: transfer, bubbles: true, cancelable: true }))
    },
    name,
    content
  )

/** A test id's text in the tab shown, or outside the tabs (About), or null while it isn't shown. */
const testIdText = (id: string): Promise<string | null> =>
  page().execute((testId: string) => {
    const all = [...document.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`)]
    return (all.find((el) => el.closest('[role=tabpanel]:not([hidden])')) ?? all.find((el) => !el.closest('[role=tabpanel]')))?.innerText ?? null
  }, id)

/** The text an editor pane of the tab shown has (CodeMirror draws the lines in view, which a short fixture fits in). */
const paneText = (pane: string): Promise<string | null> =>
  page().execute((name: string) => {
    const host = document.querySelector(`[role=tabpanel]:not([hidden]) [data-pane="${name}"]`)
    const content = host?.shadowRoot?.querySelector<HTMLElement>('.cm-content')
    return content ? [...content.querySelectorAll<HTMLElement>('.cm-line')].map((line) => line.textContent ?? '').join('\n') : null
  }, pane)

describe('the desktop app', () => {
  it('opens a dropped fixture through the Platform and shows its display set', async () => {
    await expect.poll(() => paneText('source'), UI_WAIT).not.toBeNull()
    await drop('smoke.conf', readFileSync(join(FIXTURES, 'config_1.conf'), 'utf8'))
    await expect.poll(() => testIdText('source-name'), UI_WAIT).toBe('smoke.conf')
    const expected = readFileSync(join(FIXTURES, 'config_1.set'), 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter(Boolean)
      .join('\n')
    await expect.poll(() => paneText('output'), UI_WAIT).toBe(expected)
    expect(await testIdText('output-summary')).toBe('3 commands')
  })

  it('runs under a CSP that blocks inline scripts and the network', async () => {
    // WebDriver's own scripts run outside the page's CSP, so they only start what the page then does: an inline script,
    // a remote image and a fetch of the page itself, each of which the CSP must refuse with a violation event.
    const fetched = await page().execute(() => {
      const probe = window as unknown as { __violations: string[]; __inlineRan?: boolean }
      probe.__violations = []
      document.addEventListener('securitypolicyviolation', (e) => probe.__violations.push(`${e.violatedDirective} ${e.blockedURI}`))
      const script = document.createElement('script')
      script.textContent = 'window.__inlineRan = true'
      document.body.append(script)
      const img = document.createElement('img')
      img.src = 'https://example.com/probe.png'
      document.body.append(img)
      return fetch(location.href).then(
        () => 'fetched',
        (error: Error) => error.name
      )
    })
    expect(fetched).toBe('TypeError')
    const violations = (): Promise<string[]> => page().execute(() => [...(window as unknown as { __violations: string[] }).__violations].sort())
    await expect.poll(violations, UI_WAIT).toEqual(['connect-src http://tauri.localhost/', 'img-src https://example.com/probe.png', 'script-src-elem inline'])
    expect(await page().execute(() => (window as unknown as { __inlineRan?: boolean }).__inlineRan ?? false)).toBe(false)
  })

  it('shows About with the version, WebView2, the OS and the notice, and renders each Docs page in a tab', async () => {
    const version = JSON.parse(readFileSync(join(desktop, '..', '..', 'package.json'), 'utf8')).version as string
    await menu('Help', 'About Dialect')
    await expect.poll(() => testIdText('about-info'), UI_WAIT).toMatch(new RegExp(`^Version\\s+${version.replaceAll('.', '\\.')}\\s+Build\\s+Desktop app\\s+WebView\\s+WebView2 \\d+\\.\\d+\\.\\d+\\.\\d+\\s+OS\\s+Windows 1[01]$`))
    expect(await testIdText('about-notice')).toBe(NOTICE)
    const heading = (): Promise<string | null> => page().execute(() => document.querySelector<HTMLElement>('[role=tabpanel]:not([hidden]) .docs-page h1')?.innerText ?? null)
    // From About's license link, then the Docs list.
    expect(await click('[role=dialog] button', 'MIT License')).toBe(true)
    await expect.poll(heading, UI_WAIT).toBe('License')
    for (const [label, title] of [['User Guide', 'Dialect user guide'], ['Release Notes', 'Release Notes'], ['Third-Party Notices', 'Third-party notices']]) {
      expect(await click('[role=tabpanel]:not([hidden]) .docs-nav-item', label)).toBe(true)
      await expect.poll(heading, UI_WAIT).toBe(title)
    }
    // The notices list the app's Rust crates too.
    expect(await page().execute(() => [...document.querySelectorAll('[role=tabpanel]:not([hidden]) .docs-page h2')].some((h) => /^tauri [\d.]+ \(crate\)$/.test(h.textContent ?? '')))).toBe(true)
    // Each page in its own tab, beside the display set's.
    const titles = (): Promise<string[]> => page().execute(() => [...document.querySelectorAll('[role=tab] .tab-title')].map((t) => t.textContent ?? ''))
    expect(await titles()).toEqual(['smoke.conf → Display set', 'License', 'User Guide', 'Release Notes', 'Third-Party Notices'])
    expect(await click('[role=tab] .tab-title', 'smoke.conf → Display set')).toBe(true)
    await expect.poll(() => paneText('source'), UI_WAIT).not.toBeNull()
  })

  it('converts the phase 1 fixture to IOS-XE, with the interfaces named in the table and the warnings shown', async () => {
    const convertFixtures = join(__dirname, '../../../packages/cli/tests/fixtures/convert')
    const clickButton = (label: string): Promise<boolean> =>
      page().execute((text: string) => {
        const target = [...document.querySelectorAll<HTMLElement>('button')].find((el) => el.textContent?.trim() === text || el.getAttribute('aria-label') === text)
        target?.click()
        return !!target
      }, label)
    // A convert tab of its own, from File → New Tab.
    await menu('File', 'New Tab…')
    await expect.poll(() => click('[role=dialog] .picker-convert button', 'Convert: Junos → Cisco IOS / IOS-XE'), UI_WAIT).toBe(true)
    await expect.poll(() => paneText('source'), UI_WAIT).not.toBeNull()
    await drop('phase1.conf', readFileSync(join(convertFixtures, 'phase1.conf'), 'utf8'))
    await expect.poll(() => testIdText('interface-count'), UI_WAIT).toBe('4 of 4 need a name')
    // One name taken by hand, the rest as suggested.
    expect(await clickButton('Use Loopback0 for lo0')).toBe(true)
    await expect.poll(() => testIdText('interface-count'), UI_WAIT).toBe('3 of 4 need a name')
    expect(await clickButton('Use suggestions')).toBe(true)
    await expect.poll(() => testIdText('interface-count'), UI_WAIT).toBe('all 4 named')
    const expected = readFileSync(join(convertFixtures, 'phase1.iosxe'), 'utf8').trimEnd()
    await expect.poll(() => paneText('output'), UI_WAIT).toBe(expected)
    expect(await testIdText('problem-count')).toBe('4 warnings')
    const firstProblem = (): Promise<string | null> => page().execute(() => document.querySelector<HTMLElement>('[role=tabpanel]:not([hidden]) .problem.warning .problem-message')?.innerText ?? null)
    expect(await firstProblem()).toBe('Not written for Cisco IOS / IOS-XE: IOS has no reject route: Null0 discards')
    // The source gutter marks it once the line is in view.
    await page().execute(() => document.querySelector<HTMLElement>('[role=tabpanel]:not([hidden]) .problem.warning')?.click())
    const gutterTitles = (): Promise<string[]> =>
      page().execute(() => [...(document.querySelector('[role=tabpanel]:not([hidden]) [data-pane="source"]')?.shadowRoot?.querySelectorAll<HTMLElement>('.cm-issue-warning') ?? [])].map((m) => m.title))
    await expect.poll(gutterTitles, UI_WAIT).toContain('Not written for Cisco IOS / IOS-XE: IOS has no reject route: Null0 discards')
    // Back to the display set tab through the Window menu: it is as it was.
    await menu('Window', 'smoke.conf → Display set •')
    await expect.poll(() => testIdText('interface-count'), UI_WAIT).toBeNull()
    expect(await testIdText('output-summary')).toBe('3 commands')
  })

  it('opens no link but an https one in the browser', async () => {
    // Only refusals are probed: an allowed https link would start the browser on this machine.
    const results = await page().execute(() => {
      const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__
      return Promise.all(
        ['http://example.com/', 'file:///C:/Windows/win.ini', 'C:\\dialect-probe\\missing.exe'].map((url) =>
          internals.invoke('plugin:opener|open_url', { url }).then(
            () => 'opened',
            (error: unknown) => `refused: ${String(error)}`
          )
        )
      )
    })
    for (const result of results) expect(result).toMatch(/^refused: .*(not allowed|scope|forbidden)/i)
  })

  it('reads no file the user has not picked', async () => {
    const result = await page().execute(() => {
      const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__
      return internals.invoke('plugin:fs|read_text_file', { path: 'C:\\Windows\\win.ini' }).then(
        () => 'read',
        (error: unknown) => `refused: ${String(error)}`
      )
    })
    expect(result).toMatch(/^refused: .*(forbidden|scope|not allowed)/i)
  })

  /** How many copies of the built app are running: this test's, until it quits. */
  const running = (): number => Number(execFileSync('powershell', ['-NoProfile', '-Command', `@(Get-Process dialect -ErrorAction SilentlyContinue | Where-Object Path -eq '${app}').Count`], { encoding: 'utf8' }).trim())

  it("asks before the window's own close loses unsaved output, and stays open when told to", async () => {
    // A close request to the window, as its ✕ or Alt+F4 makes: the page's close guard answers it.
    await page().execute(() => {
      const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__
      void internals.invoke('plugin:window|close', { label: 'main' })
    })
    const dialogTitle = (): Promise<string | null> => page().execute(() => document.querySelector<HTMLElement>('[role=dialog] .modal-title')?.innerText ?? null)
    await expect.poll(dialogTitle, UI_WAIT).toBe('Exit Dialect?')
    expect(await click('[role=dialog] button', 'Cancel')).toBe(true)
    await expect.poll(dialogTitle, UI_WAIT).toBeNull()
    expect(running()).toBe(1)
    expect(await testIdText('output-summary')).not.toBeNull()
  })

  // Last: it quits the app.
  it('quits on File → Exit, once told the unsaved output would go', async () => {
    expect(running()).toBe(1)
    await menu('File', 'Exit')
    await expect.poll(() => click('[role=dialog] button', 'Exit without saving'), UI_WAIT).toBe(true)
    await expect.poll(running, UI_WAIT).toBe(0)
  })
})
