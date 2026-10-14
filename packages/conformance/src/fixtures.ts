// Reads a plugin's fixtures from disk: `tests/fixtures/<area>/<case>.<ext>` with `<case>.model.json` beside it, and
// optionally `<case>.rendered.<ext>`. A source with no model file, or a model file with no source, is an error rather
// than a fixture quietly skipped.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { deserializeModel, MODEL_VERSION } from '@dialect/core'
import type { Fixture } from './checks'

const MODEL = '.model.json'
const RENDERED = /\.rendered\.[^.]+$/

/**
 * The fixtures under `dir`, one folder per feature area, sorted by name. Throws on a source without its model file or
 * the reverse, and on a model file a core at `modelVersion` can't read.
 */
export function loadFixtures(dir: string, { modelVersion = MODEL_VERSION }: { modelVersion?: string } = {}): Fixture[] {
  const fixtures: Fixture[] = []
  const problems: string[] = []
  for (const area of readdirSync(dir).sort()) {
    const areaDir = join(dir, area)
    if (!statSync(areaDir).isDirectory()) continue
    const files = readdirSync(areaDir).sort()
    const models = new Set(files.filter((f) => f.endsWith(MODEL)).map((f) => f.slice(0, -MODEL.length)))
    const sources = files.filter((f) => !f.endsWith(MODEL) && !RENDERED.test(f) && !f.startsWith('.') && statSync(join(areaDir, f)).isFile() && !/\.md$/i.test(f))
    for (const file of sources) {
      const dot = file.lastIndexOf('.')
      const base = dot > 0 ? file.slice(0, dot) : file
      const ext = dot > 0 ? file.slice(dot) : ''
      if (!models.delete(base)) {
        problems.push(`${area}/${file} has no ${base}${MODEL}`)
        continue
      }
      const rendered = join(areaDir, `${base}.rendered${ext}`)
      fixtures.push({
        name: `${area}/${base}`,
        source: readFileSync(join(areaDir, file), 'utf8'),
        expectedModel: deserializeModel(readFileSync(join(areaDir, `${base}${MODEL}`), 'utf8'), modelVersion).device,
        ...(existsSync(rendered) ? { expectedRender: readFileSync(rendered, 'utf8') } : {})
      })
    }
    for (const base of models) problems.push(`${area}/${base}${MODEL} has no source file`)
  }
  if (problems.length) throw new Error(`Fixtures in ${dir}:\n${problems.join('\n')}`)
  return fixtures
}
