// The offline web build: the UI as one self-contained file, dist/dialect.html, opened from disk with no server.
// `inlineAssets` below puts the script and the styles into the page; then `csp` fills in the Content Security Policy from
// their hashes, so the page runs only its own inlined code and can reach no network at all.
import react from '@vitejs/plugin-react'
import { createHash } from 'crypto'
import { readFileSync } from 'fs'
import { join } from 'path'
import { defineConfig, type Plugin } from 'vite'

const OUTPUT = 'dialect.html'

const hash = (text: string): string => `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`

/** The policy for a page whose inline scripts and styles are `scripts` and `styles`. */
export function contentSecurityPolicy(scripts: string[], styles: string[]): string {
  return [
    "default-src 'none'",
    `script-src ${scripts.map(hash).join(' ')}`,
    `style-src ${styles.map(hash).join(' ')}`,
    // The icon, as a data: URL. Nothing is fetched: no connect-src, no fonts, no frames.
    'img-src data:',
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'"
  ].join('; ')
}

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Moves the one script chunk and the one stylesheet into index.html, and fails on any other file the build emits. */
function inlineAssets(): Plugin {
  return {
    name: 'dialect-inline',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const page = bundle['index.html']
      if (!page || page.type !== 'asset') throw new Error('dialect-inline: no index.html in the bundle')
      let html = String(page.source)
      for (const [fileName, file] of Object.entries(bundle)) {
        if (fileName === 'index.html') continue
        if (file.type === 'chunk' && fileName.endsWith('.js')) {
          const tag = new RegExp(`<script\\b[^>]*\\bsrc="(?:\\./)?${escape(fileName)}"[^>]*></script>`)
          if (!tag.test(html)) throw new Error(`dialect-inline: index.html doesn't load ${fileName}`)
          // `</script` or `<!--` in a string would end or change the script element: \x3C reads the same in JS.
          const code = file.code.replace(/<(\/script|!--)/gi, '\\x3C$1').trim()
          html = html.replace(tag, () => `<script type="module">${code}</script>`)
        } else if (file.type === 'asset' && fileName.endsWith('.css')) {
          const tag = new RegExp(`<link\\b[^>]*\\bhref="(?:\\./)?${escape(fileName)}"[^>]*>`)
          if (!tag.test(html)) throw new Error(`dialect-inline: index.html doesn't load ${fileName}`)
          const css = String(file.source).replace('@charset "UTF-8";', '').trim()
          if (/<\/style/i.test(css)) throw new Error(`dialect-inline: ${fileName} contains </style`)
          html = html.replace(tag, () => `<style>${css}</style>`)
        } else {
          throw new Error(`dialect-inline: ${fileName} can't be inlined into the page`)
        }
        delete bundle[fileName]
      }
      page.source = html
    }
  }
}

function csp(): Plugin {
  return {
    name: 'dialect-csp',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const page = bundle['index.html']
      if (!page || page.type !== 'asset') throw new Error('dialect-csp: no index.html in the bundle')
      let html = String(page.source)
      const inline = (tag: string): string[] => [...html.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'g'))].map((m) => m[1])
      // The tags themselves, without the inlined code (which may contain such text in strings).
      const tags = html.replace(/(<(script|style)\b[^>]*>)[\s\S]*?(<\/\2>)/g, '$1$3')
      const loads = /<script\b[^>]*\bsrc=[^>]*>|<link\b[^>]*rel="(stylesheet|modulepreload)"[^>]*>/.exec(tags)
      if (loads) throw new Error(`dialect-csp: the page still loads a file: ${loads[0]}`)
      const icon = readFileSync(join(__dirname, '../../branding/icon-small.svg')).toString('base64')
      html = html
        .replace('%DIALECT_CSP%', contentSecurityPolicy(inline('script'), inline('style')))
        .replace('</title>', `</title>\n    <link rel="icon" href="data:image/svg+xml;base64,${icon}" />`)
      if (html.includes('%DIALECT_CSP%')) throw new Error('dialect-csp: the CSP placeholder is still there')
      delete bundle['index.html']
      this.emitFile({ type: 'asset', fileName: OUTPUT, source: html })
    }
  }
}

export default defineConfig({
  base: './',
  plugins: [react(), inlineAssets(), csp()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    reportCompressedSize: false,
    // One script and one stylesheet, for `inlineAssets`: no code splitting, no preload helper, assets as data: URLs.
    assetsDir: '',
    assetsInlineLimit: () => true,
    cssCodeSplit: false,
    modulePreload: { polyfill: false },
    chunkSizeWarningLimit: 100_000,
    rolldownOptions: { output: { codeSplitting: false } }
  }
})
