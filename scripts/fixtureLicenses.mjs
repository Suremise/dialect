// The license rule (docs/SPEC.md, License) for the fixture corpus: third-party configs copied into fixtures/ for the
// tests, which don't ship. Copied material must still be MIT or equally permissive, and fixtures/LICENSES/ is its
// attribution, not THIRD_PARTY_NOTICES.md. scripts/licenses.mjs runs it with the package check, and tests/fixtures.test.ts
// checks it in `npm test` and CI. The rest of the corpus (files vs manifest, hashes, areas) is fixtures/verify.mjs's job.
import { existsSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { SHIPPED_ALLOWED, satisfies } from './licensePolicy.mjs'

/**
 * Sources whose repository has a NOTICE file at the commit taken from, kept as `LICENSES/<repository>.NOTICE.txt`. Only
 * the upstream repository can say whether one has a NOTICE, so it is recorded here when the source is added (checked at
 * that commit), and the check holds LICENSES/ to it both ways.
 */
export const FIXTURE_NOTICES = new Set(['cml-community'])

/**
 * What is wrong with the licenses of the fixture corpus in `dir` (fixtures/), or [] when nothing is. Each source in
 * `manifest.json` (its repository URL) needs one SPDX license on the shipped allowlist, the same for all its files, and
 * its text in `LICENSES/<repository>.<SPDX>.txt`; a source in `notices` needs its NOTICE file too. A file in LICENSES/
 * that no source accounts for fails, so a removed source can't leave its license behind. No manifest: nothing to check.
 */
export function fixtureLicenseProblems(dir, { notices = FIXTURE_NOTICES } = {}) {
  const manifestFile = join(dir, 'manifest.json')
  if (!existsSync(manifestFile)) return []
  const problems = []
  const licensesDir = join(dir, 'LICENSES')
  const present = new Set(existsSync(licensesDir) ? readdirSync(licensesDir) : [])
  const expected = new Set()
  const bySource = new Map()
  for (const f of JSON.parse(readFileSync(manifestFile, 'utf8')).files) bySource.set(f.source, [...(bySource.get(f.source) ?? []), f])
  for (const [source, files] of bySource) {
    const repo = String(source).split('/').pop()
    const licenses = [...new Set(files.map((f) => f.license ?? 'none'))]
    if (licenses.length > 1) problems.push(`fixtures: ${source} has files under different licenses (${licenses.join(', ')})`)
    for (const license of licenses) {
      if (!satisfies(license, (l) => SHIPPED_ALLOWED.has(l)))
        problems.push(`fixtures: ${source} (${files.length} file${files.length === 1 ? '' : 's'}) is ${license}, which isn't allowed in copied material (MIT or equally permissive)`)
      const text = `${repo}.${license}.txt`
      expected.add(text)
      if (!present.has(text)) problems.push(`fixtures: ${source} has no license text: add LICENSES/${text}`)
      else if (!readFileSync(join(licensesDir, text), 'utf8').trim()) problems.push(`fixtures: LICENSES/${text} is empty`)
    }
    if (notices.has(repo)) {
      expected.add(`${repo}.NOTICE.txt`)
      if (!present.has(`${repo}.NOTICE.txt`)) problems.push(`fixtures: ${source} has a NOTICE file upstream: add LICENSES/${repo}.NOTICE.txt`)
      else if (!readFileSync(join(licensesDir, `${repo}.NOTICE.txt`), 'utf8').trim()) problems.push(`fixtures: LICENSES/${repo}.NOTICE.txt is empty`)
    }
  }
  for (const file of present)
    if (!expected.has(file))
      problems.push(
        file.endsWith('.NOTICE.txt')
          ? `fixtures: LICENSES/${file} isn't recorded in FIXTURE_NOTICES (scripts/fixtureLicenses.mjs), or its source isn't in the manifest`
          : `fixtures: LICENSES/${file} belongs to no source in the manifest`
      )
  for (const repo of notices) if (![...bySource.keys()].some((s) => String(s).split('/').pop() === repo)) problems.push(`fixtures: FIXTURE_NOTICES lists ${repo}, which isn't a source in the manifest`)
  return problems
}
