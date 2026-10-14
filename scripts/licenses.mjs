// Writes THIRD_PARTY_NOTICES.md (what ships, with full license texts) and docs/BUILD_ONLY_PACKAGES.md (what is only used
// to build), both made by thirdPartyNotices.mjs, and checks the license rule (licensePolicy.mjs). Run `npm run licenses`
// after changing dependencies and commit the results. A file is written only when its content changed (line endings
// aside), with the endings it already has. Exits 1 when a package breaks the license rule, or the copied fixtures in
// fixtures/ do (fixtureLicenses.mjs).
// `--check` writes nothing and exits 1 when either file is out of date or the rule is broken (tests/licenses.test.ts
// checks the same in `npm test` and CI).
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { fixtureLicenseProblems } from './fixtureLicenses.mjs'
import { noticesDrift, noticesToWrite, staleNoticesMessage } from './licenseText.mjs'
import { generateLicenses } from './thirdPartyNotices.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const { notices, buildOnly, problems: packageProblems } = generateLicenses(root)
const problems = [...packageProblems, ...fixtureLicenseProblems(join(root, 'fixtures'))]
const check = process.argv.includes('--check')
let failed = false
for (const [name, made, what] of [['THIRD_PARTY_NOTICES.md', notices, 'shipped'], ['docs/BUILD_ONLY_PACKAGES.md', buildOnly, 'build-only']]) {
  const file = join(root, name)
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : null
  if (check) {
    const drift = noticesDrift(made.text, existing)
    if (drift) {
      console.error(staleNoticesMessage(drift, name))
      failed = true
    } else console.log(`${name}: ${made.packages} ${what} packages, up to date`)
  } else {
    const write = noticesToWrite(made.text, existing)
    if (write !== null) writeFileSync(file, write)
    console.log(`${name}: ${made.packages} ${what} packages${write === null ? ', unchanged' : ''}`)
  }
}
if (problems.length) {
  console.error(`The license rule (docs/SPEC.md) is broken:\n${problems.map((p) => `- ${p}`).join('\n')}`)
  failed = true
}
if (failed) process.exit(1)
