// npm 12 runs no dependency's install script unless package.json's `allowScripts` approves it (npm 12.0.0's default
// deny; docs/SPEC.md, Install scripts). The repo pins npm 12 (`packageManager`, `engines.npm`) and CI installs it; this
// checks the npm that runs the tests really blocks an unlisted postinstall, with an approved one as the control.
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

const made: string[] = []
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('install scripts', () => {
  it('runs on npm 12 or later, as package.json pins', () => {
    const dir = tempDir('dialect-npm-')
    made.push(dir)
    const major = Number(npm(['--version'], dir, join(dir, 'cache')).trim().split('.')[0])
    expect(major, 'npm 12 is needed (npm install -g npm@12.2.0)').toBeGreaterThanOrEqual(12)
  })

  it('an unlisted dependency\'s postinstall does not run; one approved in allowScripts does', () => {
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
