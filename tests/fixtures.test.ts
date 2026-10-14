// The fixture corpus (fixtures/): its licenses (scripts/fixtureLicenses.mjs) and the manifest against the files
// (fixtures/verify.mjs, run as it is, with the coverage table in fixtures/README.md), on the repo itself and on small
// corpora made in a temp folder.
import { spawnSync } from 'child_process'
import { createHash } from 'crypto'
import { copyFileSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error: a plain .mjs module without types
import { fixtureLicenseProblems } from '../scripts/fixtureLicenses.mjs'
import { childEnv } from './childEnv'
import { tempDir } from './tempDir'

const repo = join(__dirname, '..')
const fixtures = join(repo, 'fixtures')

/** Runs a copy of fixtures/verify.mjs (it checks the folder it is in) with node: its exit code and stderr. */
function verify(dir: string, ...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [join(dir, 'verify.mjs'), ...args], { env: childEnv(), encoding: 'utf8' })
  return { status: r.status, stdout: r.stdout, stderr: r.stderr }
}

const made: string[] = []
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const CONFIG = 'set system host-name lab1\n'
const SOURCE = 'https://github.com/owner/configs'

/** A corpus of one Junos config from SOURCE under `license`, with its license text and the real verify.mjs beside it. */
function corpus(license = 'MIT'): string {
  const dir = join(tempDir('dialect-fixtures-'), 'fixtures')
  made.push(dirname(dir))
  const write = (file: string, text: string) => {
    mkdirSync(dirname(join(dir, file)), { recursive: true })
    writeFileSync(join(dir, file), text)
  }
  const path = 'public/junos/system/configs__lab1.set'
  write(path, CONFIG)
  write(`LICENSES/configs.${license}.txt`, `${license} license of owner/configs\n`)
  const entry = {
    path, platform: 'junos', areas: ['system'], source: SOURCE, sourcePath: 'lab1.set', commit: 'a'.repeat(40), license, junosForm: 'set',
    bytes: Buffer.byteLength(CONFIG), sha256: createHash('sha256').update(CONFIG).digest('hex'), flags: { secretLike: [], publicIPv4: [], publicIPv6: [] }, notes: ''
  }
  write('manifest.json', JSON.stringify({ schema: 1, files: [entry] }, null, 2))
  copyFileSync(join(fixtures, 'verify.mjs'), join(dir, 'verify.mjs'))
  return dir
}
const none = { notices: new Set() }

describe('the repository\'s fixtures', () => {
  it('keep the license rule: every source permissive, with its license text and NOTICE in fixtures/LICENSES/', () => {
    expect(fixtureLicenseProblems(fixtures)).toEqual([])
  })

  // `npm run fixtures`: the manifest against the files, and every platform with a file in every phase 1 area.
  const coverage = verify(fixtures, '--coverage')

  it('match their manifest and cover phase 1 (fixtures/verify.mjs --coverage)', () => {
    expect(coverage.stderr).toMatch(/^ok: /)
    expect(coverage.status).toBe(0)
  })

  it('README.md\'s coverage table is the one verify.mjs prints', () => {
    const readme = readFileSync(join(fixtures, 'README.md'), 'utf8').replace(/\r\n/g, '\n')
    const table = readme.match(/^\| Area \| junos .*?^\| \*\*files\*\* .*?$/ms)?.[0]
    expect(table, 'README.md has no coverage table').toBeDefined()
    expect(table, 'fixtures/README.md is stale: paste the table `npm run fixtures` prints').toBe(coverage.stdout.replace(/\r\n/g, '\n').trim())
  })
})

describe('the fixture checks fail on a broken corpus', () => {
  it('pass a sound corpus', () => {
    const dir = corpus()
    expect(fixtureLicenseProblems(dir, none)).toEqual([])
    expect(verify(dir).status).toBe(0)
  })

  it('a source whose license isn\'t on the shipped allowlist', () => {
    const dir = corpus('GPL-3.0-only')
    expect(fixtureLicenseProblems(dir, none)).toEqual([`fixtures: ${SOURCE} (1 file) is GPL-3.0-only, which isn't allowed in copied material (MIT or equally permissive)`])
    const r = verify(dir)
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('license GPL-3.0-only not allowed')
  })

  it('a source without its license text, and a license text without its source', () => {
    const dir = corpus()
    unlinkSync(join(dir, 'LICENSES', 'configs.MIT.txt'))
    writeFileSync(join(dir, 'LICENSES', 'gone.MIT.txt'), 'MIT\n')
    expect(fixtureLicenseProblems(dir, none)).toEqual([
      `fixtures: ${SOURCE} has no license text: add LICENSES/configs.MIT.txt`,
      'fixtures: LICENSES/gone.MIT.txt belongs to no source in the manifest'
    ])
    const r = verify(dir)
    expect(r.status).toBe(1)
    expect(r.stderr).toContain(`LICENSES/: no license file for ${SOURCE}`)
  })

  it('a NOTICE file recorded but missing, and one present but not recorded', () => {
    const dir = corpus()
    expect(fixtureLicenseProblems(dir, { notices: new Set(['configs']) })).toEqual([`fixtures: ${SOURCE} has a NOTICE file upstream: add LICENSES/configs.NOTICE.txt`])
    writeFileSync(join(dir, 'LICENSES', 'configs.NOTICE.txt'), 'configs\nCopyright 2026 Owner\n')
    expect(fixtureLicenseProblems(dir, { notices: new Set(['configs']) })).toEqual([])
    expect(fixtureLicenseProblems(dir, none)).toEqual(['fixtures: LICENSES/configs.NOTICE.txt isn\'t recorded in FIXTURE_NOTICES (scripts/fixtureLicenses.mjs), or its source isn\'t in the manifest'])
  })

  it('an empty license text or NOTICE file', () => {
    const dir = corpus()
    writeFileSync(join(dir, 'LICENSES', 'configs.MIT.txt'), ' \r\n')
    writeFileSync(join(dir, 'LICENSES', 'configs.NOTICE.txt'), '\n')
    expect(fixtureLicenseProblems(dir, { notices: new Set(['configs']) })).toEqual(['fixtures: LICENSES/configs.MIT.txt is empty', 'fixtures: LICENSES/configs.NOTICE.txt is empty'])
  })

  it('a file whose content no longer matches its manifest hash', () => {
    const dir = corpus()
    writeFileSync(join(dir, 'public', 'junos', 'system', 'configs__lab1.set'), CONFIG.replace('lab1', 'lab2'))
    const r = verify(dir)
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('manifest public/junos/system/configs__lab1.set: sha256 differs')
  })
})
