// Reading a plugin's fixture folder (src/fixtures.ts): what makes a fixture, and what is an error rather than skipped.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { serializeModel } from '@dialect/core'
import { loadFixtures } from '../src'
import { tempDir } from '../../../tests/tempDir'

const made: string[] = []
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function folder(files: Record<string, string>): string {
  const dir = tempDir('dialect-fixtures-')
  made.push(dir)
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true })
    writeFileSync(join(dir, name), text)
  }
  return dir
}

describe('loadFixtures', () => {
  it('reads each area\'s sources with their models and expected renders, sorted, skipping READMEs', () => {
    const model = serializeModel({ system: { hostname: 'r1' } })
    const dir = folder({
      'system/b.cfg': 'b',
      'system/b.model.json': model,
      'system/a.conf': 'a',
      'system/a.model.json': model,
      'system/a.rendered.conf': 'rendered a',
      'system/README.md': 'notes',
      'interfaces/x.cfg': 'x',
      'interfaces/x.model.json': model,
      'notes.txt': 'not an area'
    })
    expect(loadFixtures(dir).map((f) => [f.name, f.source, f.expectedRender ?? null])).toEqual([
      ['interfaces/x', 'x', null],
      ['system/a', 'a', 'rendered a'],
      ['system/b', 'b', null]
    ])
    expect(loadFixtures(dir)[0].expectedModel).toEqual({ system: { hostname: 'r1' } })
  })

  it('fails on a source without its model file and a model file without its source', () => {
    const dir = folder({ 'system/a.cfg': 'a', 'system/b.model.json': serializeModel({}) })
    expect(() => loadFixtures(dir)).toThrow(/system\/a\.cfg has no a\.model\.json\nsystem\/b\.model\.json has no source file/)
  })

  it('reads a fixture\'s secrets file, and fails on one with no source or that isn\'t a list of strings', () => {
    const model = serializeModel({})
    expect(loadFixtures(folder({ 'system/a.cfg': 'a', 'system/a.model.json': model, 'system/a.secrets.json': '["PLACEHOLDER"]', 'system/b.cfg': 'b', 'system/b.model.json': model })).map((f) => [f.name, f.secrets ?? null])).toEqual([
      ['system/a', ['PLACEHOLDER']],
      ['system/b', null]
    ])
    expect(() => loadFixtures(folder({ 'system/b.secrets.json': '[]' }))).toThrow(/system\/b\.secrets\.json has no source file/)
    for (const bad of ['{"a": 1}', '[1]', '[""]']) expect(() => loadFixtures(folder({ 'system/a.cfg': 'a', 'system/a.model.json': model, 'system/a.secrets.json': bad }))).toThrow(/system\/a\.secrets\.json isn't a list of secret values/)
    expect(() => loadFixtures(folder({ 'system/a.cfg': 'a', 'system/a.model.json': model, 'system/a.secrets.json': 'nope' }))).toThrow(/system\/a\.secrets\.json isn't JSON/)
  })

  it('fails on a model file made with a newer model than the core reads', () => {
    const dir = folder({ 'system/a.cfg': 'a', 'system/a.model.json': serializeModel({}, '0.9.0') })
    expect(() => loadFixtures(dir, { modelVersion: '0.1.0' })).toThrow(/made with model 0\.9\.0, newer than this core's 0\.1\.0/)
  })
})
