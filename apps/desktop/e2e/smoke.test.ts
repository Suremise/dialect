// The desktop app's smoke test: the built app (src-tauri/target/release/dialect.exe, run from the build output, not
// installed) driven through tauri-driver and Microsoft Edge WebDriver (e2e/webdriver.ts). It drops a fixture on the window,
// which the desktop Platform reads, and checks the display set output; then About and the Docs pages, that the CSP blocks
// inline scripts and the network, and that the fs plugin reads no file the user hasn't picked and the opener no link but
// an https one. The logic itself is the web build's, tested there.
//
// Needs Rust (the build), tauri-driver (`cargo install tauri-driver --locked --version ^2`) and the msedgedriver that
// matches the installed WebView2, found through MSEDGEDRIVER (its path) or on PATH. `npm run test:smoke -w
// @dialect/desktop` builds the app first (incremental after the first build), as the web tests build the page.
import { execFileSync, spawn, type ChildProcess } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { createServer } from 'net'
import { createRequire } from 'module'
import { dirname, join } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { childEnv } from '../../../tests/childEnv'
import { newSession, type Session } from './webdriver'

const desktop = join(__dirname, '..')
// The Tauri CLI's own entry (its bin), wherever npm installed it.
const tauriCli = join(dirname(createRequire(import.meta.url).resolve('@tauri-apps/cli/package.json')), 'tauri.js')
const app = join(desktop, 'src-tauri', 'target', 'release', 'dialect.exe')
const FIXTURES = join(__dirname, '../../../packages/platform-junos/tests/fixtures/display-set')
/** How long the app may take to show what an action leads to: a bound for a hung app, not a wait. */
const UI_WAIT = { timeout: 15_000, interval: 100 }
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

let driver: ChildProcess | undefined
let driverLog = ''
let session: Session | undefined

beforeAll(async () => {
  const native = process.env.MSEDGEDRIVER ?? onPath('msedgedriver.exe')
  if (!native || !existsSync(native)) throw new Error('msedgedriver.exe (matching the installed WebView2) is needed: set MSEDGEDRIVER to its path, or put it on PATH')
  const tauriDriver = onPath('tauri-driver.exe') ?? join(process.env.USERPROFILE ?? '', '.cargo', 'bin', 'tauri-driver.exe')
  if (!existsSync(tauriDriver)) throw new Error('tauri-driver is needed: cargo install tauri-driver --locked --version ^2')

  // The app as `npm run build` makes it, without the installer: incremental once built.
  execFileSync(process.execPath, [tauriCli, 'build', '--no-bundle'], { cwd: desktop, env: childEnv(), stdio: 'pipe' })
  expect(existsSync(app), app).toBe(true)

  const port = await freePort()
  const nativePort = await freePort()
  driver = spawn(tauriDriver, ['--port', String(port), '--native-port', String(nativePort), '--native-driver', native], { env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
  driver.stdout?.on('data', (d) => (driverLog += d))
  driver.stderr?.on('data', (d) => (driverLog += d))
  // Ready once it answers.
  await vi.waitFor(async () => {
    if (!(await fetch(`http://127.0.0.1:${port}/status`)).ok) throw new Error('tauri-driver is not ready')
  }, UI_WAIT)
  session = await newSession(`http://127.0.0.1:${port}`, { browserName: 'wry', 'tauri:options': { application: app } })
}, 600_000)

afterAll(async () => {
  await session?.close().catch(() => {})
  driver?.kill()
  if (driver && driver.exitCode === null) await new Promise((resolve) => driver!.once('exit', resolve))
})

const page = (): Session => {
  if (!session) throw new Error(`no WebDriver session (tauri-driver said: ${driverLog.trim() || 'nothing'})`)
  return session
}

/** A test id's text, or null while it isn't shown. */
const testIdText = (id: string): Promise<string | null> => page().execute((testId: string) => document.querySelector<HTMLElement>(`[data-testid="${testId}"]`)?.innerText ?? null, id)

/** The text an editor pane shows (CodeMirror draws the lines in view, which a short fixture fits in). */
const paneText = (pane: string): Promise<string | null> =>
  page().execute((name: string) => {
    const host = document.querySelector(`[data-pane="${name}"]`)
    const content = host?.shadowRoot?.querySelector<HTMLElement>('.cm-content')
    return content ? [...content.querySelectorAll<HTMLElement>('.cm-line')].map((line) => line.textContent ?? '').join('\n') : null
  }, pane)

describe('the desktop app', () => {
  it('opens a dropped fixture through the Platform and shows its display set', async () => {
    await expect.poll(() => paneText('source'), UI_WAIT).not.toBeNull()
    const conf = readFileSync(join(FIXTURES, 'config_1.conf'), 'utf8')
    // Dropped on the source editor: the UI's drop handler (capture phase) gives it to platform.openDropped.
    await page().execute((content: string) => {
      const target = document.querySelector('[data-pane="source"]')!
      const transfer = new DataTransfer()
      transfer.items.add(new File([content], 'smoke.conf', { type: 'text/plain' }))
      for (const type of ['dragenter', 'dragover', 'drop']) target.dispatchEvent(new DragEvent(type, { dataTransfer: transfer, bubbles: true, cancelable: true }))
    }, conf)
    await expect.poll(() => testIdText('source-name'), UI_WAIT).toBe('smoke.conf')
    const expected = readFileSync(join(FIXTURES, 'config_1.set'), 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter(Boolean)
      .join('\n')
    await expect.poll(() => paneText('output'), UI_WAIT).toBe(expected)
    expect(await testIdText('output-summary')).toBe('3 set lines')
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

  it('shows About with the version, WebView2, the OS and the notice, and renders each Docs page', async () => {
    const version = JSON.parse(readFileSync(join(desktop, '..', '..', 'package.json'), 'utf8')).version as string
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
    expect(await click('button', 'Help')).toBe(true)
    expect(await click('[role=menuitem]', 'About Dialect')).toBe(true)
    await expect.poll(() => testIdText('about-info'), UI_WAIT).toMatch(new RegExp(`^Version\\s+${version.replaceAll('.', '\\.')}\\s+Build\\s+Desktop app\\s+WebView\\s+WebView2 \\d+\\.\\d+\\.\\d+\\.\\d+\\s+OS\\s+Windows 1[01]$`))
    expect(await testIdText('about-notice')).toBe(NOTICE)
    const heading = (): Promise<string | null> => page().execute(() => document.querySelector<HTMLElement>('.docs-page h1')?.innerText ?? null)
    // From About's license link, then the Docs list.
    expect(await click('[role=dialog] button', 'MIT License')).toBe(true)
    await expect.poll(heading, UI_WAIT).toBe('License')
    for (const [label, title] of [['User Guide', 'Dialect user guide'], ['Release Notes', 'Release Notes'], ['Third-Party Notices', 'Third-party notices']]) {
      expect(await click('.docs-nav-item', label)).toBe(true)
      await expect.poll(heading, UI_WAIT).toBe(title)
    }
    // The notices list the app's Rust crates too.
    expect(await page().execute(() => [...document.querySelectorAll('.docs-page h2')].some((h) => /^tauri [\d.]+ \(crate\)$/.test(h.textContent ?? '')))).toBe(true)
    expect(await click('.docs-back', '← Display set')).toBe(true)
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
    expect(await clickButton('Convert')).toBe(true)
    await page().execute((content: string) => {
      const target = document.querySelector('[data-pane="source"]')!
      const transfer = new DataTransfer()
      transfer.items.add(new File([content], 'phase1.conf', { type: 'text/plain' }))
      for (const type of ['dragenter', 'dragover', 'drop']) target.dispatchEvent(new DragEvent(type, { dataTransfer: transfer, bubbles: true, cancelable: true }))
    }, readFileSync(join(convertFixtures, 'phase1.conf'), 'utf8'))
    await expect.poll(() => testIdText('interface-count'), UI_WAIT).toBe('4 of 4 need a name')
    // One name taken by hand, the rest as suggested.
    expect(await clickButton('Use Loopback0 for lo0')).toBe(true)
    await expect.poll(() => testIdText('interface-count'), UI_WAIT).toBe('3 of 4 need a name')
    expect(await clickButton('Use suggestions')).toBe(true)
    await expect.poll(() => testIdText('interface-count'), UI_WAIT).toBe('all 4 named')
    const expected = readFileSync(join(convertFixtures, 'phase1.iosxe'), 'utf8').trimEnd()
    await expect.poll(() => paneText('output'), UI_WAIT).toBe(expected)
    expect(await testIdText('problem-count')).toBe('4 warnings')
    const firstProblem = (): Promise<string | null> => page().execute(() => document.querySelector<HTMLElement>('.problem.warning .problem-message')?.innerText ?? null)
    expect(await firstProblem()).toBe('Not written for Cisco IOS / IOS-XE: IOS has no reject route: Null0 discards')
    // The source gutter marks it once the line is in view.
    await page().execute(() => document.querySelector<HTMLElement>('.problem.warning')?.click())
    const gutterTitles = (): Promise<string[]> =>
      page().execute(() => [...(document.querySelector('[data-pane="source"]')?.shadowRoot?.querySelectorAll<HTMLElement>('.cm-issue-warning') ?? [])].map((m) => m.title))
    await expect.poll(gutterTitles, UI_WAIT).toContain('Not written for Cisco IOS / IOS-XE: IOS has no reject route: Null0 discards')
    expect(await clickButton('Display set')).toBe(true)
    await expect.poll(() => testIdText('interface-count'), UI_WAIT).toBeNull()
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
})
