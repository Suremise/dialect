// The README's screenshots: a Convert tab with docs/screenshots/sample.conf open (documentation addresses and
// placeholder names only, no secrets), in the light and the dark theme. Builds the web page, opens it in Microsoft Edge
// through playwright-core with the network blocked, as the web tests do, and writes docs/screenshots/convert-light.png
// and convert-dark.png. Run it before each release (RELEASING.md), so the pictures show that release.
//
//   npm run screenshots
import { spawnSync } from 'child_process'
import { join } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { chromium } from 'playwright-core'

const root = fileURLToPath(new URL('..', import.meta.url))
const out = join(root, 'docs', 'screenshots')
const sample = join(out, 'sample.conf')
/** How long the page may take to show what an action leads to: a bound for a hung page, not a wait. */
const WAIT = { timeout: 15_000 }

const built = spawnSync('npm run build -w @dialect/web', { cwd: root, stdio: 'inherit', shell: true })
if (built.status !== 0) process.exit(built.status ?? 1)
const pageUrl = pathToFileURL(join(root, 'apps', 'web', 'dist', 'dialect.html')).href

/** Waits until `read` gives `want`, polling: the page updates through React effects. */
async function until(read, want, what) {
  const end = Date.now() + WAIT.timeout
  let last
  while (Date.now() < end) {
    last = await read()
    if (last === want) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`${what}: expected ${JSON.stringify(want)}, last saw ${JSON.stringify(last)}`)
}

const browser = await chromium.launch({ channel: 'msedge' }).catch((error) => {
  console.error(`The screenshots are taken in Microsoft Edge, which comes with Windows: ${error.message}`)
  process.exit(1)
})
try {
  for (const colorScheme of ['light', 'dark']) {
    const context = await browser.newContext({ offline: true, colorScheme, viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 })
    await context.route('**/*', (route) => (route.request().url() === pageUrl ? route.continue() : route.abort()))
    const page = await context.newPage()
    await page.goto(pageUrl)
    const shown = () => page.locator('[role=tabpanel]:not([hidden])')
    const menu = async (name, item) => {
      await page.getByRole('menubar').getByRole('menuitem', { name, exact: true }).click()
      await page.getByRole('menu', { name }).locator('[role^=menuitem]').filter({ has: page.locator('.menu-label').getByText(item, { exact: true }) }).click()
    }
    await shown().locator('[data-pane=source] .cm-content').waitFor(WAIT)
    // The first tab is a display set: close it, then open a Convert tab, so the strip shows one conversion.
    await menu('File', 'Close Tab')
    await menu('File', 'New Tab…')
    await page.getByRole('dialog', { name: 'New tab' }).getByRole('button', { name: 'Convert: Junos → Cisco IOS / IOS-XE' }).click()
    await until(() => page.getByRole('dialog').count(), 0, 'the New tab dialog closes')
    const chooser = page.waitForEvent('filechooser', WAIT)
    await shown().getByRole('button', { name: /^Open/ }).click()
    await (await chooser).setFiles(sample)
    await until(() => shown().getByTestId('interface-count').innerText(), '3 of 3 need a name', 'the interfaces are listed')
    await shown().getByRole('button', { name: 'Use suggestions' }).click()
    await until(() => shown().getByTestId('interface-count').innerText(), 'all 3 named', 'the suggestions are used')
    // No hover in the picture.
    await page.mouse.move(0, 0)
    const file = join(out, `convert-${colorScheme}.png`)
    await page.screenshot({ path: file })
    console.log(`Wrote ${file}`)
    await context.close()
  }
} finally {
  await browser.close()
}
