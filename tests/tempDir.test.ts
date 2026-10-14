// Tests make temp folders with tempDir() (tests/tempDir.ts), never under os.tmpdir() directly: CI's temp folder is an
// 8.3 short path.
import { readdirSync, readFileSync } from 'fs'
import { join, relative } from 'path'
import { describe, expect, it } from 'vitest'

const root = join(__dirname, '..')

/** Every test source under `dir`, skipping node_modules and fixtures. */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name)
    if (e.isDirectory()) return e.name === 'node_modules' || e.name === 'fixtures' ? [] : sources(p)
    return /\.(c|m)?ts$/.test(e.name) ? [p] : []
  })
}

describe('temp folders', () => {
  it('no test uses os.tmpdir() but tests/tempDir.ts', () => {
    const dirs = [join(root, 'tests'), ...['packages', 'apps'].flatMap((d) => readdirSync(join(root, d)).map((p) => join(root, d, p, 'tests')))]
    const offenders = dirs
      .flatMap((d) => {
        try {
          return sources(d)
        } catch {
          return []
        }
      })
      .filter((f) => !f.endsWith(join('tests', 'tempDir.ts')) && !f.endsWith(join('tests', 'tempDir.test.ts')) && /\btmpdir\s*\(/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(root, f))
    expect(offenders).toEqual([])
  })
})
