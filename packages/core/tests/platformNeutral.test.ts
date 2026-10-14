// packages/core uses no Node or DOM API, so it runs unchanged in the CLI, the desktop app's webview and a browser
// (docs/SPEC.md §4). Two guards: its tsconfig gives it neither Node's nor the DOM's types, so `process`, `Buffer`,
// `window` or `document` fail the typecheck; and this test fails on an import of a Node built-in (bare or `node:`) or of
// any package not on the allowlist below.
import { readdirSync, readFileSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const pkg = join(__dirname, '..')
/** Packages core may import: each must be platform-neutral itself. */
const ALLOWED = ['semver']

const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sources(join(dir, e.name)) : /\.(m|c)?[jt]sx?$/.test(e.name) ? [join(dir, e.name)] : []))

/** Every module specifier a source imports or re-exports, statically or with import(). */
function specifiers(text: string): string[] {
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:"'`])\/\/.*$/gm, '$1')
  return [...code.matchAll(/\b(?:import|export)\s[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]|\bimport\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1] ?? m[2] ?? m[3] ?? m[4])
}

const problem = (spec: string): string | null => {
  if (spec.startsWith('.')) return null
  const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]
  if (spec.startsWith('node:') || builtinModules.includes(name)) return 'a Node built-in'
  return ALLOWED.includes(name) ? null : 'not on the allowlist'
}

describe('packages/core is platform-neutral', () => {
  it('imports no Node built-in and no package outside the allowlist', () => {
    const found = sources(join(pkg, 'src')).flatMap((file) =>
      specifiers(readFileSync(file, 'utf8')).flatMap((spec) => {
        const why = problem(spec)
        return why ? [`${relative(pkg, file)}: ${spec} (${why})`] : []
      })
    )
    expect(found).toEqual([])
  })

  it('has neither Node\'s nor the DOM\'s types in its tsconfig', () => {
    const config = JSON.parse(readFileSync(join(pkg, 'tsconfig.json'), 'utf8').replace(/^\s*\/\/.*$/gm, '')) as { compilerOptions: { lib?: string[]; types?: string[] } }
    expect(config.compilerOptions.types).toEqual([])
    expect(config.compilerOptions.lib?.filter((l) => /dom|webworker/i.test(l))).toEqual([])
  })

  it('the import check finds what it should', () => {
    const text = [
      "import { readFileSync } from 'fs'",
      "import type { X } from 'node:path'",
      "export * from './model'",
      "import 'path'",
      "const m = await import('os')",
      "import satisfies from 'semver/functions/satisfies'",
      "import x from 'left-pad'",
      "// import y from 'child_process'"
    ].join('\n')
    expect(specifiers(text)).toEqual(['fs', 'node:path', './model', 'path', 'os', 'semver/functions/satisfies', 'left-pad'])
    expect(specifiers(text).map(problem)).toEqual(['a Node built-in', 'a Node built-in', null, 'a Node built-in', 'a Node built-in', null, 'not on the allowlist'])
  })
})
