// scripts/pages.mjs: the hosted page is the release's page with the notice added, and its policy only gains the
// notice stylesheet's hash. The page in a browser, built and served from disk, is in apps/web/tests/web.test.ts.
import { createHash } from 'crypto'
import { describe, expect, it } from 'vitest'
// @ts-expect-error: a plain .mjs module without types
import { hostedPage, NOTICE, releaseUrl } from '../scripts/pages.mjs'

const POLICY = "default-src 'none'; script-src 'sha256-AAAA'; style-src 'sha256-BBBB'; img-src data:; base-uri 'none'; form-action 'none'; object-src 'none'"
const PAGE = [
  '<!doctype html>',
  '<html lang="en" data-theme="dark">',
  '  <head>',
  `    <meta http-equiv="Content-Security-Policy" content="${POLICY}" />`,
  '    <title>Dialect</title>',
  '    <style>app</style>',
  '  </head>',
  '  <body>',
  '    <div id="root"></div>',
  '    <script type="module">app()</script>',
  '  </body>',
  '</html>'
].join('\n')

const policyOf = (html: string): string => /content="([^"]+)"/.exec(html)![1]

describe('the hosted page', () => {
  it('adds the notice before the app, with the version and the release, and its stylesheet after the title', () => {
    const html = hostedPage(PAGE, '0.1.0')
    expect(html).toContain(`<strong>${NOTICE}</strong>`)
    expect(html).toContain(`Dialect 0.1.0 · <a href="${releaseUrl('0.1.0')}">`)
    expect(releaseUrl('0.1.0')).toBe('https://github.com/Suremise/dialect/releases/tag/v0.1.0')
    expect(html.indexOf('class="hosted-notice"')).toBeLessThan(html.indexOf('<div id="root"></div>'))
    expect(html).toMatch(/<\/title>\n {4}<style>body \{/)
    // No script added, and the app's page is otherwise as it was.
    expect(html.match(/<script\b/g)).toHaveLength(1)
    const added = /<\/title>\n {4}(<style>[\s\S]*?<\/style>)/.exec(html)![1]
    const notice = /(<details class="hosted-notice"[\s\S]*?<\/details>\n {4})/.exec(html)![1]
    expect(html.replace(`\n    ${added}`, '').replace(notice, '').replace(policyOf(html), POLICY)).toBe(PAGE)
  })

  it("adds exactly the notice stylesheet's hash to style-src, and nothing else to the policy", () => {
    const html = hostedPage(PAGE, '0.1.0')
    const css = /<style>(body \{[\s\S]*?)<\/style>/.exec(html)![1]
    const hash = `'sha256-${createHash('sha256').update(css, 'utf8').digest('base64')}'`
    expect(policyOf(html)).toBe(POLICY.replace("style-src 'sha256-BBBB'", `style-src ${hash} 'sha256-BBBB'`))
  })

  it('refuses a version that is not one, so nothing but a version reaches the page', () => {
    for (const version of ['v0.1.0', '0.1', '0.1.0"><script>x()</script>', '']) expect(() => hostedPage(PAGE, version)).toThrow(/isn't a version/)
  })

  it("refuses a page it can't place the notice in, rather than guessing", () => {
    expect(() => hostedPage(PAGE.replace('<div id="root"></div>', ''), '0.1.0')).toThrow(/0 root elements/)
    expect(() => hostedPage(PAGE.replace(/ {4}<meta[^\n]*\n/, ''), '0.1.0')).toThrow(/0 Content-Security-Policy/)
    expect(() => hostedPage(PAGE.replace("style-src 'sha256-BBBB'; ", ''), '0.1.0')).toThrow(/0 style-src/)
    expect(() => hostedPage(PAGE.replace('</body>', '<div id="root"></div></body>'), '0.1.0')).toThrow(/2 root elements/)
  })
})
