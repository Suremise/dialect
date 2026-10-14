// Checks the accent tokens in theme-tokens.css against WCAG 2.x: 4.5:1 for text, 3:1 for icons and focus rings.
// Run with `npm run contrast`; it prints each pair and exits 1 if any falls short.
import { readFile } from 'node:fs/promises'

const css = (await readFile(new URL('theme-tokens.css', import.meta.url), 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '')
// Hive's surfaces (bg, sidebar, activity bar, title, elevated, input, hover, active), standing in for Dialect's own.
const surfaces = {
  dark: ['#1e1e1e', '#252526', '#2c2c2c', '#1f1f1f', '#2d2d30', '#313131', '#2a2d2e', '#37373d'],
  light: ['#ffffff', '#f3f3f3', '#e8e8e8', '#e4e6f1']
}
const activity = { dark: '#2c2c2c', light: '#e8e8e8' }

const block = (selector) => {
  const body = css.slice(css.indexOf(selector)).match(/\{([^}]*)\}/)[1]
  return Object.fromEntries([...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]))
}
const theme = (name) => {
  const tokens = { ...block(':root {'), ...block(name === 'dark' ? "[data-theme='dark']" : "[data-theme='light']") }
  const get = (key) => {
    const v = tokens[key]
    const ref = v.match(/^var\((--[\w-]+)\)$/)
    return ref ? get(ref[1]) : v
  }
  return get
}

const rgb = (c) => {
  const rgba = c.match(/rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/)
  if (rgba) return { c: rgba.slice(1, 4).map(Number), a: Number(rgba[4]) }
  const h = c.replace('#', '')
  return { c: [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)), a: 1 }
}
const over = (fg, bg) => {
  const f = rgb(fg)
  const b = rgb(bg).c
  return f.c.map((v, i) => Math.round(v * f.a + b[i] * (1 - f.a)))
}
const lum = (c) =>
  c
    .map((v) => v / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
    .reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0)
const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p)
  return (x + 0.05) / (y + 0.05)
}

let failed = 0
const check = (label, fg, bgs, need) => {
  const worst = Math.min(...bgs.map((bg) => ratio(over(fg, '#000000'), over(bg, '#000000'))))
  const ok = worst >= need
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(44)} ${worst.toFixed(2)}:1 (needs ${need}:1)`)
}

for (const name of ['dark', 'light']) {
  const t = theme(name)
  const soft = surfaces[name].map((s) => '#' + over(t('--accent-soft'), s).map((v) => v.toString(16).padStart(2, '0')).join(''))
  console.log(`-- ${name}`)
  check('--accent-ink text on every surface', t('--accent-ink'), surfaces[name], 4.5)
  check('--accent-ink text on --accent-soft', t('--accent-ink'), soft, 4.5)
  check('--accent-fg label on --accent-fill', t('--accent-fg'), [t('--accent-fill')], 4.5)
  check('--accent-fg label on --accent-fill-hover', t('--accent-fg'), [t('--accent-fill-hover')], 4.5)
  check('--status-fg on --status-bg', t('--status-fg'), [t('--status-bg')], 4.5)
  check('--focus-ring on every surface', t('--focus-ring'), surfaces[name], 3)
  check('--accent-on-activity on the activity bar', t('--accent-on-activity'), [activity[name]], 3)
}
console.log('-- icon')
check('small icon fill on light and dark taskbars', '#8b5cf6', ['#f3f3f3', '#202020'], 3)
check('small icon glyph on its fill', '#140f1e', ['#8b5cf6'], 3)
process.exit(failed ? 1 : 0)
