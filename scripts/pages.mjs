// Makes the hosted web page (GitHub Pages, .github/workflows/pages.yml) from a release's dialect.html: the same page,
// byte for byte, with a notice at its top that it runs entirely in the browser, the version, and a link to the
// release's downloads. The notice is plain HTML with one stylesheet, whose hash is added to the page's style-src: the
// policy is otherwise unchanged, so the page still runs only its own code and reaches no network. No script is added.
//
// The deploy runs this from the workflow's own commit on the page of the release it deploys, so a release made before
// this script (0.1.0) gets the notice too, with the released app itself untouched.
//
//   node scripts/pages.mjs <dialect.html> <out/index.html> <version>
import { createHash } from 'crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

export const REPO = 'Suremise/dialect'

/** The site's address once Pages serves it. */
export const PAGES_URL = 'https://suremise.github.io/dialect/'

/** The notice, word for word (card #117). */
export const NOTICE = 'Runs entirely in your browser. Your configuration is never uploaded.'

/** The release's page on GitHub, with its downloads. */
export const releaseUrl = (version) => `https://github.com/${REPO}/releases/tag/v${version}`

const escapeHtml = (text) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

const hash = (text) => `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`

// The app fills the window (html, body and #root at 100%, overflow hidden): the notice takes a row above it, and the
// app the rest. The colours are the app's theme tokens, so the notice follows its light and dark themes.
const STYLE = `
body { display: grid; grid-template-rows: auto minmax(0, 1fr); }
#root { height: auto; min-height: 0; }
.hosted-notice { padding: 6px 12px; background: var(--bg-elevated); color: var(--fg); border-bottom: 1px solid var(--border-subtle); font-size: 12px; }
.hosted-notice a { color: var(--accent-ink); }
.hosted-notice summary { cursor: pointer; display: flex; flex-wrap: wrap; gap: 4px 12px; align-items: baseline; }
.hosted-notice strong { color: var(--fg-strong); }
.hosted-notice .hosted-how { color: var(--accent-ink); text-decoration: underline; }
.hosted-notice .hosted-version { color: var(--fg-muted); margin-left: auto; }
.hosted-notice p { margin: 6px 0 2px; max-width: 80ch; }
`.trim()

/** The notice's markup: the notice, the version and the downloads, and in its details why it's true. */
export function noticeHtml(version) {
  const v = escapeHtml(version)
  return [
    '<details class="hosted-notice" aria-label="About this page">',
    `  <summary><strong>${escapeHtml(NOTICE)}</strong> <span class="hosted-how">How?</span> <span class="hosted-version">Dialect ${v} · <a href="${releaseUrl(v)}">Downloads (desktop app, command line)</a></span></summary>`,
    "  <p>This page's content security policy blocks every network connection: it runs only its own built-in code and can't fetch, send or load anything, so the configs you open, paste or convert stay on your computer. It's the release's <code>dialect.html</code>, with this notice added.</p>",
    `  <p>To use it offline, download <code>dialect.html</code> from <a href="${releaseUrl(v)}">the release</a> (this page, without the notice) and open it from any folder, or install the desktop app.</p>`,
    '</details>'
  ].join('\n')
}

/** The hosted page for release `version`'s dialect.html: the notice added, and its stylesheet's hash in style-src. */
export function hostedPage(html, version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`pages: "${version}" isn't a version (like 0.1.0)`)
  const once = (pattern, what) => {
    const found = html.match(new RegExp(pattern.source, 'g')) ?? []
    if (found.length !== 1) throw new Error(`pages: the page has ${found.length} ${what}, not one`)
  }
  const policy = /(<meta http-equiv="Content-Security-Policy" content="[^"]*?\bstyle-src )/
  once(/<meta http-equiv="Content-Security-Policy"/, 'Content-Security-Policy meta tags')
  once(/\bstyle-src /, 'style-src directives')
  once(/<\/title>/, 'titles')
  once(/<div id="root"><\/div>/, 'root elements')
  if (!policy.test(html)) throw new Error("pages: the page's policy has no style-src")
  return html
    .replace(policy, (m) => `${m}${hash(STYLE)} `)
    .replace('</title>', () => `</title>\n    <style>${STYLE}</style>`)
    .replace('<div id="root"></div>', () => `${noticeHtml(version)}\n    <div id="root"></div>`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [input, output, version] = process.argv.slice(2)
  if (!input || !output || !version) {
    console.error('Usage: node scripts/pages.mjs <dialect.html> <out/index.html> <version>')
    process.exit(2)
  }
  mkdirSync(dirname(resolve(output)), { recursive: true })
  writeFileSync(output, hostedPage(readFileSync(input, 'utf8'), version))
  console.log(`Wrote ${output}: Dialect ${version}'s page with the hosted notice`)
}
