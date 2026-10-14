// Reads a plugin's fixtures from disk: `tests/fixtures/<area>/<case>.<ext>` with `<case>.model.json` beside it, and
// optionally `<case>.rendered.<ext>` and `<case>.secrets.json` (a JSON array of the secret values in the source, for
// the secrets check). A source with no model file, or a model or secrets file with no source, is an error rather than
// a fixture quietly skipped.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { deserializeModel, MODEL_VERSION } from '@dialect/core'
import type { Fixture } from './checks'

const MODEL = '.model.json'
const RENDERED = /\.rendered\.[^.]+$/
const SECRETS = '.secrets.json'

/** A secrets file's list, or why it isn't one. */
function readSecrets(path: string, name: string): string[] {
  let value: unknown
  try {
    value = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    throw new Error(`${name} isn't JSON`)
  }
  if (!Array.isArray(value) || !value.every((s) => typeof s === 'string' && s.length > 0)) throw new Error(`${name} isn't a list of secret values (strings)`)
  return value
}

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
    const secretFiles = new Set(files.filter((f) => f.endsWith(SECRETS)).map((f) => f.slice(0, -SECRETS.length)))
    const sources = files.filter((f) => !f.endsWith(MODEL) && !f.endsWith(SECRETS) && !RENDERED.test(f) && !f.startsWith('.') && statSync(join(areaDir, f)).isFile() && !/\.md$/i.test(f))
    for (const file of sources) {
      const dot = file.lastIndexOf('.')
      const base = dot > 0 ? file.slice(0, dot) : file
      const ext = dot > 0 ? file.slice(dot) : ''
      if (!models.delete(base)) {
        problems.push(`${area}/${file} has no ${base}${MODEL}`)
        continue
      }
      const rendered = join(areaDir, `${base}.rendered${ext}`)
      const secrets = secretFiles.delete(base) ? readSecrets(join(areaDir, `${base}${SECRETS}`), `${area}/${base}${SECRETS}`) : undefined
      fixtures.push({
        name: `${area}/${base}`,
        source: readFileSync(join(areaDir, file), 'utf8'),
        expectedModel: deserializeModel(readFileSync(join(areaDir, `${base}${MODEL}`), 'utf8'), modelVersion).device,
        ...(existsSync(rendered) ? { expectedRender: readFileSync(rendered, 'utf8') } : {}),
        ...(secrets ? { secrets } : {})
      })
    }
    for (const base of models) problems.push(`${area}/${base}${MODEL} has no source file`)
    for (const base of secretFiles) problems.push(`${area}/${base}${SECRETS} has no source file`)
  }
  if (problems.length) throw new Error(`Fixtures in ${dir}:\n${problems.join('\n')}`)
  return fixtures
}
