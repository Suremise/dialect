// npm 12 runs no dependency's install script unless package.json's `allowScripts` approves it (npm 12.0.0's default
// deny; docs/SPEC.md, Install scripts). The repo pins npm 12 (`packageManager`, `engines.npm`) and CI installs it; this
// checks the npm that runs the tests really blocks an unlisted postinstall, with an approved one as the control.
// The global npm on a dev PC may stay 11 (Hive uses it): there these tests skip with a warning, and
// `npx npm@12.2.0 test` runs them. In CI (CI set) they always run, and fail under npm 11.
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { childEnv } from './childEnv'
import { tempDir } from './tempDir'

// `npm test` runs us with npm_execpath set to its own npm-cli.js: use that npm. Run some other way, the npm on PATH.
const npmCli = process.env.npm_execpath && /npm-cli\.c?js$/.test(process.env.npm_execpath) ? process.env.npm_execpath : null
const npm = (args: string[], cwd: string, cache: string) =>
  execFileSync(npmCli ? process.execPath : 'npm', npmCli ? [npmCli, ...args] : args, {
    cwd,
    env: childEnv({ npm_config_cache: cache, npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false' }),
    encoding: 'utf8',
    // npm's warnings (the blocked script) stay out of the test output.
    stdio: 'pipe',
    // npm is a .cmd on Windows, which only a shell runs (fixed arguments, nothing from outside the test).
    shell: !npmCli && process.platform === 'win32'
  })

// The npm that runs the tests, asked once in a folder of its own.
const npmMajor = (() => {
  const dir = tempDir('dialect-npm-')
  try {
    return Number(npm(['--version'], dir, join(dir, 'cache')).trim().split('.')[0])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})()
const ci = Boolean(process.env.CI)
const skipNote = `npm ${npmMajor} is running the tests: the npm 12 install-script checks are skipped. Run \`npx npm@12.2.0 test\` to include them.`
const needs12 = 'npm 12 is needed (CI must use npm 12: npm install -g npm@12.2.0; locally, npx npm@12.2.0 test)'
// Straight to stderr: Vitest's reporter leaves out console output from passing files when it runs several.
if (npmMajor < 12 && !ci) process.stderr.write(`\nWARNING: ${skipNote}\n\n`)

// Skips (with the note) under npm 11 outside CI; in CI, or on npm 12, the test goes on.
const onNpm12 = (skip: (note: string) => void) => {
  if (npmMajor < 12 && !ci) skip(skipNote)
  expect(npmMajor, needs12).toBeGreaterThanOrEqual(12)
}

const made: string[] = []
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('install scripts', () => {
  it('runs on npm 12 or later, as package.json pins', ({ skip }) => {
    onNpm12(skip)
  })

  it('an unlisted dependency\'s postinstall does not run; one approved in allowScripts does', ({ skip }) => {
    onNpm12(skip)
    const dir = tempDir('dialect-scripts-')
    made.push(dir)
    const cache = join(dir, 'cache')
    // A dependency whose postinstall leaves a file in the installing project.
    const dep = join(dir, 'dep')
    mkdirSync(dep)
    writeFileSync(
      join(dep, 'package.json'),
      JSON.stringify({ name: 'scripted-dep', version: '1.0.0', license: 'MIT', scripts: { postinstall: "node -e \"require('fs').writeFileSync(require('path').join(process.env.INIT_CWD, 'postinstall-ran'), '')\"" } })
    )
    npm(['pack', '--silent'], dep, cache)
    const spec = 'file:../dep/scripted-dep-1.0.0.tgz'

    const install = (name: string, allowScripts?: Record<string, boolean>) => {
      const app = join(dir, name)
      mkdirSync(app)
      writeFileSync(join(app, 'package.json'), JSON.stringify({ name, private: true, dependencies: { 'scripted-dep': spec }, ...(allowScripts ? { allowScripts } : {}) }))
      npm(['install', '--no-audit', '--no-fund'], app, cache)
      expect(existsSync(join(app, 'node_modules', 'scripted-dep', 'package.json')), `${name}: installed`).toBe(true)
      return existsSync(join(app, 'postinstall-ran'))
    }
    expect(install('unlisted')).toBe(false)
    expect(install('another-listed', { 'some-other-package': true })).toBe(false)
    expect(install('denied', { [spec]: false })).toBe(false)
    // The control: approved (a file: dependency is approved by its spec), the same script runs.
    expect(install('approved', { [spec]: true })).toBe(true)
  })
})
