// The built dialect command (vite.config.ts → dialect.mjs), run by Node on the display set fixtures, invalid input and
// usage errors: its stdout, stderr and exit code. The build goes to a temp folder, so the tests run the code as it is.
import { spawnSync } from 'child_process'
import { readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { build } from 'vite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { childEnv } from '../../../tests/childEnv'
import { tempDir } from '../../../tests/tempDir'

const cliRoot = join(__dirname, '..')
const FIXTURES = join(__dirname, '../../platform-junos/tests/fixtures/display-set')
const NUMBERS = Array.from({ length: 22 }, (_, i) => i + 1)

let dir: string
let bin: string

beforeAll(async () => {
  dir = tempDir('dialect-cli-')
  await build({ root: cliRoot, configFile: join(cliRoot, 'vite.config.ts'), logLevel: 'silent', build: { outDir: join(dir, 'dist') } })
  bin = join(dir, 'dist', 'dialect.mjs')
}, 60_000)

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})

interface Run {
  status: number | null
  stdout: string
  stderr: string
}

function dialect(args: string[], input?: string, cwd?: string): Run {
  const result = spawnSync(process.execPath, [bin, ...args], { input, cwd: cwd ?? dir, env: childEnv(), encoding: 'utf8', timeout: 30_000 })
  if (result.error) throw result.error
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

/** A fixture's expected set lines as the command prints them: one per line, each ended by a newline. */
function expectedOutput(n: number): string {
  const lines = readFileSync(join(FIXTURES, `config_${n}.set`), 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line !== '')
  return lines.join('\n') + '\n'
}

describe('dialect display-set', () => {
  it('builds into one ES module that Node runs directly', () => {
    const text = readFileSync(bin, 'utf8')
    expect(text.startsWith('#!/usr/bin/env node\n')).toBe(true)
    // Bundled: no imports left but Node's own modules.
    const imports = [...text.matchAll(/^import .* from "([^"]+)";?$/gm)].map((m) => m[1])
    expect(imports.every((name) => /^(node:)?[a-z_/]+$/.test(name) && !name.startsWith('@'))).toBe(true)
  })

  it.each(NUMBERS)('prints config_%i as its expected set lines, from a file', (n) => {
    expect(dialect(['display-set', join(FIXTURES, `config_${n}.conf`)])).toEqual({ status: 0, stdout: expectedOutput(n), stderr: '' })
  })

  it('reads stdin for -', () => {
    for (const n of [1, 15, 22]) {
      expect(dialect(['display-set', '-'], readFileSync(join(FIXTURES, `config_${n}.conf`), 'utf8'))).toEqual({ status: 0, stdout: expectedOutput(n), stderr: '' })
    }
  })

  it('reads a relative path, CRLF and a UTF-8 byte order mark', () => {
    writeFileSync(join(dir, 'crlf.conf'), '﻿system {\r\n    host-name r1;\r\n}\r\n')
    expect(dialect(['display-set', 'crlf.conf'])).toEqual({ status: 0, stdout: 'set system host-name r1\n', stderr: '' })
  })

  it('prints a syntax error to stderr with the line and column, and exits 1', () => {
    writeFileSync(join(dir, 'invalid.conf'), 'system {\n    host-name r1\n}\n')
    expect(dialect(['display-set', 'invalid.conf'])).toEqual({ status: 1, stdout: '', stderr: "invalid.conf:3:1: error: missing ';' after the statement at line 2, column 5\n" })
    expect(dialect(['display-set', '-'], 'system {\n    login {\n        message "hi;\n    }\n}\n')).toEqual({ status: 1, stdout: '', stderr: '<stdin>:3:17: error: unterminated quoted string\n' })
  })

  it('prints warnings to stderr with their positions, the set lines to stdout, and exits 0', () => {
    const src = 'system {\n    /* lab box */\n    host-name r1;\n    deleted: services;\n}\n'
    expect(dialect(['display-set', '-'], src)).toEqual({
      status: 0,
      stdout: 'set system host-name r1\nset system deleted: services\n',
      stderr: "<stdin>:3:5: warning: annotation on this statement isn't shown in display set\n<stdin>:4:5: warning: unknown tag 'deleted:' kept as a word\n"
    })
  })

  it('never writes a secret from the config to stderr, keeping the kind of error and its position', () => {
    const secret = 'SYNTHETIC_SECRET'
    const missingSemi = dialect(['display-set', '-'], `system {\n    root-authentication {\n        encrypted-password "$6$${secret}"\n    }\n}\n`)
    expect(missingSemi).toEqual({ status: 1, stdout: '', stderr: "<stdin>:4:5: error: missing ';' after the statement at line 3, column 9\n" })
    const badList = dialect(['display-set', '-'], `snmp {\n    community ${secret} {\n        clients [ 192.0.2.1 ] ${secret};\n    }\n}\n`)
    expect(badList).toEqual({ status: 1, stdout: '', stderr: "<stdin>:3:31: error: expected ';' after ']', got a word\n" })
    const warnings = dialect(['display-set', '-'], `snmp {\n    /* ${secret} */\n    community ${secret} {\n        clients [ ];\n    }\n    /* ${secret} */\n}\n`)
    expect(warnings.status).toBe(0)
    expect(warnings.stderr).toBe(
      "<stdin>:3:5: warning: annotation on this statement isn't shown in display set\n<stdin>:4:17: warning: empty list '[ ]' gives no set line\n<stdin>:6:5: warning: annotation isn't followed by a statement, so it isn't shown\n"
    )
  })

  it('prints nothing for an empty config', () => {
    expect(dialect(['display-set', '-'], '')).toEqual({ status: 0, stdout: '', stderr: '' })
  })

  it("exits 2 for a file it can't read", () => {
    expect(dialect(['display-set', 'missing.conf'])).toEqual({ status: 2, stdout: '', stderr: "dialect: can't read missing.conf: no such file\n" })
    expect(dialect(['display-set', '.'])).toEqual({ status: 2, stdout: '', stderr: "dialect: can't read .: is a folder, not a file\n" })
  })
})

describe('dialect usage', () => {
  const hint = "\nRun 'dialect --help' for usage.\n"

  it('exits 2 with a message for a usage error', () => {
    expect(dialect([])).toMatchObject({ status: 2, stdout: '' })
    expect(dialect([]).stderr).toContain('Usage: dialect <command>')
    expect(dialect(['convert'])).toEqual({ status: 2, stdout: '', stderr: `dialect: unknown command 'convert'${hint}` })
    expect(dialect(['display-set'])).toEqual({ status: 2, stdout: '', stderr: `dialect: display-set: give a file, or - for stdin${hint}` })
    expect(dialect(['display-set', 'a.conf', 'b.conf'])).toEqual({ status: 2, stdout: '', stderr: `dialect: display-set: give one file${hint}` })
    expect(dialect(['display-set', '--strip', 'a.conf'])).toEqual({ status: 2, stdout: '', stderr: `dialect: display-set: unknown option '--strip'${hint}` })
  })

  it('prints help and the version to stdout, and exits 0', () => {
    for (const args of [['--help'], ['-h'], ['help'], ['display-set', '--help']]) {
      const run = dialect(args)
      expect(run.status).toBe(0)
      expect(run.stdout).toContain('display-set <file|->')
      expect(run.stderr).toBe('')
    }
    const { version } = JSON.parse(readFileSync(join(cliRoot, 'package.json'), 'utf8')) as { version: string }
    expect(dialect(['--version'])).toEqual({ status: 0, stdout: `dialect ${version}\n`, stderr: '' })
  })
})
