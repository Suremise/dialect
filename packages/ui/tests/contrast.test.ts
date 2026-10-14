// The UI's own contrast: a control's edge (--border-control, on buttons, tabs, menus and inputs) against every surface
// it sits on, and the text of the menus and tabs, in light and dark, by WCAG 2.x (3:1 for a control's edge, 4.5:1 for
// text). `npm run contrast` checks the accent tokens the same way (branding/theme-tokens.css).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(join(__dirname, '../src/styles/app.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

function tokens(selector: string): Record<string, string> {
  const body = /\{([^}]*)\}/.exec(css.slice(css.indexOf(selector)))![1]
  return Object.fromEntries([...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]))
}

const luminance = (hex: string): number =>
  [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
    .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0)

const ratio = (a: string, b: string): number => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p)
  return (x + 0.05) / (y + 0.05)
}

describe.each([
  ['dark', ":root,\n[data-theme='dark']"],
  ['light', "[data-theme='light']"]
])('the %s theme', (_, selector) => {
  const t = tokens(selector)
  const surfaces = ['--bg', '--bg-title', '--bg-panel', '--bg-sidebar', '--bg-elevated', '--bg-input', '--bg-hover', '--bg-active'].map((k) => t[k])

  it("shows a control's edge at 3:1 at least on every surface", () => {
    for (const surface of surfaces) expect(ratio(t['--border-control'], surface), `on ${surface}`).toBeGreaterThanOrEqual(3)
  })

  it('shows menu and tab text at 4.5:1 at least on the surfaces they use', () => {
    for (const fg of ['--fg', '--fg-strong', '--fg-muted']) for (const surface of [t['--bg-title'], t['--bg-elevated'], t['--bg-active'], t['--bg-panel']]) expect(ratio(t[fg], surface), `${fg} on ${surface}`).toBeGreaterThanOrEqual(4.5)
  })
})
