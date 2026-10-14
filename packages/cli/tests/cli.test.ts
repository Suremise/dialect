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
const CONVERT = join(__dirname, 'fixtures/convert')

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

describe('dialect convert', () => {
  const phase1 = join(CONVERT, 'phase1.conf')
  const mapCsv = join(CONVERT, 'phase1.map.csv')
  const expected = () => readFileSync(join(CONVERT, 'phase1.iosxe'), 'utf8')
  // What didn't carry over, by line and with the plugin's reason: the same with or without a map.
  const issues = [
    'phase1.conf:66:9: warning: not written for Cisco IOS / IOS-XE: IOS has no reject route: Null0 discards',
    'phase1.conf:74:1: warning: not converted: routing protocols come later',
    'phase1.conf:75:5: warning: not converted: routing protocols come later',
    'phase1.conf:76:9: warning: not converted: routing protocols come later'
  ]
  // The unnamed interfaces by place (ge-0/0/0, ge-0/0/1, xe-0/1/0, lo0), never by name.
  const unnamed = (severity: string) => [21, 29, 39, 43].map((line) => `phase1.conf:${line}:5: ${severity}: this interface has no name on Cisco IOS / IOS-XE`)
  const lines = (...parts: string[]) => parts.map((p) => `${p}\n`).join('')
  const convert = (args: string[], input?: string) => dialect(['convert', '--from', 'junos', '--to', 'iosxe', ...args], input, CONVERT)

  it('converts the phase 1 fixture to IOS-XE with a from,to map, and exits 0', () => {
    expect(convert(['--map', mapCsv, 'phase1.conf'])).toEqual({ status: 0, stdout: expected(), stderr: lines(...issues) })
  })

  it('reads a JSON map, stdin and --option=value', () => {
    const map = Object.fromEntries(
      readFileSync(mapCsv, 'utf8')
        .split(/\r?\n/)
        .filter((l) => l && !l.startsWith('#'))
        .map((l) => l.split(','))
    )
    writeFileSync(join(dir, 'map.json'), JSON.stringify(map, null, 2))
    const run = dialect(['convert', '--from=junos', '--to=iosxe', `--map=${join(dir, 'map.json')}`, '-'], readFileSync(phase1, 'utf8'), CONVERT)
    expect(run).toEqual({ status: 0, stdout: expected(), stderr: lines(...issues.map((i) => i.replace('phase1.conf', '<stdin>'))) })
  })

  it('renames by the map: another map gives other names, in references too', () => {
    writeFileSync(join(dir, 'other.csv'), 'ge-0/0/0,GigabitEthernet1\nge-0/0/1 , GigabitEthernet2\nxe-0/1/0,TenGigabitEthernet0/0/0\nlo0,Loopback7\n')
    const run = convert(['--map', join(dir, 'other.csv'), 'phase1.conf'])
    expect(run.status).toBe(0)
    expect(run.stdout).toContain('interface GigabitEthernet1\n description uplink to core\n')
    expect(run.stdout).toContain('interface GigabitEthernet2.10\n')
    expect(run.stdout).toContain('interface Loopback7\n')
    // The Junos ge-0/0/0.0 is unit 0: the main interface on IOS.
    expect(run.stdout).toContain('ip route 198.51.100.64 255.255.255.192 GigabitEthernet1 192.0.2.2\n')
    expect(run.stdout).not.toMatch(/ge-0|xe-0|lo0/)
  })

  it('exits 3 and writes no config while interfaces have no name, giving each one\'s place, not its name', () => {
    expect(convert(['phase1.conf'])).toEqual({
      status: 3,
      stdout: '',
      stderr: lines(
        ...issues,
        ...unnamed('error'),
        'dialect: 4 interfaces have no name on Cisco IOS / IOS-XE: give them with --map (--write-map <file> writes every interface, with suggestions, to fill in), or write the config anyway with --allow-incomplete.'
      )
    })
    writeFileSync(join(dir, 'partial.csv'), 'ge-0/0/0,GigabitEthernet0/0/0\nge-0/0/1,GigabitEthernet0/0/1\nxe-0/1/0,TenGigabitEthernet0/1/0\n')
    expect(convert(['--map', join(dir, 'partial.csv'), 'phase1.conf'])).toEqual({
      status: 3,
      stdout: '',
      stderr: lines(
        ...issues,
        unnamed('error')[3],
        'dialect: 1 interface has no name on Cisco IOS / IOS-XE: give it with --map (--write-map <file> writes every interface, with suggestions, to fill in), or write the config anyway with --allow-incomplete.'
      )
    })
  })

  it('with --allow-incomplete, writes the config after a warning header giving the unnamed interfaces\' places, and exits 0', () => {
    const run = convert(['--allow-incomplete', 'phase1.conf'])
    expect(run.status).toBe(0)
    expect(run.stderr).toBe(lines(...issues, ...unnamed('warning'), 'dialect: warning: incomplete: 4 interfaces have no name on Cisco IOS / IOS-XE, and keep their Junos names.'))
    expect(run.stdout).toContain('interface ge-0/0/0\n')
    // A suggestion is never used unasked.
    expect(run.stdout).not.toContain('GigabitEthernet0/0/0')
  })

  it('writes every interface to a map to fill in, with suggestions marked, which --map then reads', () => {
    const template = join(dir, 'template.csv')
    writeFileSync(join(dir, 'one.csv'), 'lo0,Loopback9\n')
    const run = convert(['--map', join(dir, 'one.csv'), '--write-map', template, 'phase1.conf'])
    expect(run.status).toBe(3)
    expect(run.stderr).toContain(`no name on Cisco IOS / IOS-XE: fill in ${template} and give it with --map, or write the config anyway with --allow-incomplete.\n`)
    expect(readFileSync(template, 'utf8')).toBe(
      'ge-0/0/0,GigabitEthernet0/0/0 # suggested\nge-0/0/1,GigabitEthernet0/0/1 # suggested\nxe-0/1/0,TenGigabitEthernet0/1/0 # suggested\nlo0,Loopback9\n'
    )
    const filled = convert(['--map', template, 'phase1.conf'])
    expect(filled.status).toBe(0)
    expect(filled.stdout).toBe(expected().replace('Loopback0', 'Loopback9'))
    expect(convert(['--write-map', join(dir, 'no-folder', 'x.csv'), 'phase1.conf'])).toMatchObject({ status: 2, stderr: expect.stringContaining(`dialect: can't write ${join(dir, 'no-folder', 'x.csv')}: no such file\n`) })
  })

  it('names IRB units one by one (#80): --write-map lists each unit with its Vlan suggested, and --map converts each to its SVI', () => {
    const irb = join(dir, 'irb.conf')
    writeFileSync(irb, [100, 200, 300].flatMap((n) => [`set interfaces irb unit ${n} family inet address 10.${n / 100}.0.1/24`, `set vlans v${n} vlan-id ${n}`, `set vlans v${n} l3-interface irb.${n}`]).join('\n') + '\n')
    const template = join(dir, 'irb.csv')
    expect(convert(['--write-map', template, irb]).status).toBe(3)
    expect(readFileSync(template, 'utf8')).toBe('irb.100,Vlan100 # suggested\nirb.200,Vlan200 # suggested\nirb.300,Vlan300 # suggested\n')
    const run = convert(['--map', template, irb])
    expect(run).toMatchObject({ status: 0, stderr: '' })
    for (const n of [100, 200, 300]) expect(run.stdout).toContain(`interface Vlan${n}\n ip address 10.${n / 100}.0.1 255.255.255.0\n`)
    // A unit the map leaves out stays unnamed: its place is given, and no config is written.
    writeFileSync(join(dir, 'irb-partial.csv'), 'irb.100,Vlan100\nirb.300,Vlan300\n')
    const partial = convert(['--map', join(dir, 'irb-partial.csv'), irb])
    expect(partial.status).toBe(3)
    expect(partial.stderr).toContain('dialect: 1 interface has no name on Cisco IOS / IOS-XE')
    // The whole irb, named as one interface, is a name the config doesn't have: its units are named one by one.
    writeFileSync(join(dir, 'irb-whole.csv'), 'irb,Vlan100\n')
    expect(convert(['--map', join(dir, 'irb-whole.csv'), irb]).stderr).toContain('1 interface it names is not in the config')
  })

  it('refuses one name for two interfaces, and an answer that is a name another keeps, losing no interface', () => {
    writeFileSync(join(dir, 'twice.csv'), 'ge-0/0/0,Gi1\nge-0/0/1,Gi1\nxe-0/1/0,Te1\nlo0,Loopback0\nge-9/9/9,Gi9\n')
    const run = convert(['--map', join(dir, 'twice.csv'), 'phase1.conf'])
    expect(run.status).toBe(3)
    expect(run.stdout).toBe('')
    expect(run.stderr).toContain('phase1.conf:21:5: error: 2 interfaces would have one name on Cisco IOS / IOS-XE (lines 21, 29): give each its own.\n')
    expect(run.stderr).toContain(`dialect: warning: ${join(dir, 'twice.csv')}: 1 interface it names is not in the config\n`)
    expect(run.stderr).toContain(lines(...unnamed('error').slice(0, 2)))
    // Only ge-0/0/0 named, as ge-0/0/1, which ge-0/0/1 keeps: with --allow-incomplete both are still written.
    writeFileSync(join(dir, 'kept.csv'), 'ge-0/0/0,ge-0/0/1\n')
    const kept = convert(['--map', join(dir, 'kept.csv'), '--allow-incomplete', 'phase1.conf'])
    expect(kept.status).toBe(0)
    expect(kept.stderr).toContain('phase1.conf:21:5: error: 2 interfaces would have one name on Cisco IOS / IOS-XE (lines 21, 29): give each its own.\n')
    expect(kept.stdout).toContain('interface ge-0/0/0\n description uplink to core\n')
    expect(kept.stdout).toContain('interface ge-0/0/1.10\n description customer A\n')
  })

  it('refuses a JSON map that names an interface twice', () => {
    writeFileSync(join(dir, 'twice.json'), '{"ge-0/0/0":"Gi1","ge-0/0/0":"Gi2"}')
    expect(convert(['--map', join(dir, 'twice.json'), 'phase1.conf'])).toEqual({ status: 2, stdout: '', stderr: `dialect: ${join(dir, 'twice.json')}: the JSON names an interface twice\n` })
  })

  it('exits 2 for a bad or missing map and 1 for a syntax error, and never writes a secret to stderr', () => {
    writeFileSync(join(dir, 'bad.csv'), 'ge-0/0/0\n')
    expect(convert(['--map', join(dir, 'bad.csv'), 'phase1.conf'])).toEqual({ status: 2, stdout: '', stderr: `dialect: ${join(dir, 'bad.csv')}: line 1: expected from,to\n` })
    expect(convert(['--map', join(dir, 'none.csv'), 'phase1.conf'])).toEqual({ status: 2, stdout: '', stderr: `dialect: can't read ${join(dir, 'none.csv')}: no such file\n` })
    expect(convert(['-'], 'system {\n    host-name r1\n}\n')).toMatchObject({ status: 1, stdout: '' })
    const secret = 'SYNTHETIC_SECRET'
    const src = `snmp {\n    community ${secret} {\n        authorization read-only;\n        clients { 192.0.2.0/24; }\n        view ${secret};\n    }\n}\nsystem {\n    root-authentication {\n        encrypted-password "$6$${secret}";\n    }\n}\n`
    const run = convert(['--allow-incomplete', '-'], src)
    expect(run.status).toBe(0)
    expect(run.stderr).not.toBe('')
    expect(run.stderr).not.toContain(secret)
  })

  it('never names an interface on stderr: a secret reused as an interface name stays out', () => {
    // A community's value reused as an interface name, unnamed, then given a name another interface has.
    const secret = 'SYNTHETIC_SECRET'
    const src = `snmp {\n    community ${secret} {\n        authorization read-only;\n    }\n}\ninterfaces {\n    ${secret} {\n        description a;\n    }\n    ge-0/0/0 {\n        description b;\n    }\n}\n`
    const unnamedRun = convert(['--allow-incomplete', '-'], src)
    expect(unnamedRun.status).toBe(0)
    expect(unnamedRun.stderr).toContain('<stdin>:7:5: warning: this interface has no name on Cisco IOS / IOS-XE\n')
    expect(unnamedRun.stderr).not.toContain(secret)
    for (const map of [`${secret},Gi1\nge-0/0/0,Gi1\n`, `${secret},a\n${secret},b\n`, `{"${secret}":"a","${secret}":"b"}`, `ge-9/9/9,x\n${secret}-other,y\n`]) {
      writeFileSync(join(dir, 'secret.map'), map)
      const run = convert(['--map', join(dir, 'secret.map'), '--allow-incomplete', '-'], src)
      expect(run.stderr).not.toBe('')
      expect(run.stderr).not.toContain(secret)
    }
  })

  it.each([
    ['nxos', 'iosxr', 'hostname n1\n', 'hostname n1'],
    ['iosxr', 'nxos', 'hostname x1\n', 'hostname x1'],
    ['nxos', 'junos', 'hostname n1\n', 'host-name n1;'],
    ['junos', 'iosxr', 'system {\n    host-name j1;\n}\n', 'hostname j1'],
    ['iosxr', 'iosxe', 'hostname x1\n', 'hostname x1']
  ])('converts from %s to %s, now both Cisco platforms are registered', (from, to, src, line) => {
    const run = dialect(['convert', '--from', from, '--to', to, '-'], src)
    expect(run.status, run.stderr).toBe(0)
    expect(run.stdout.split('\n').map((l) => l.trim())).toContain(line)
  })

  it('exits 2 for usage errors', () => {
    const hint = "\nRun 'dialect --help' for usage.\n"
    expect(dialect(['convert', 'a.conf'])).toEqual({ status: 2, stdout: '', stderr: `dialect: convert: give --from (junos, iosxe, nxos, iosxr)${hint}` })
    expect(dialect(['convert', '--from', 'junos', 'a.conf'])).toEqual({ status: 2, stdout: '', stderr: `dialect: convert: give --to (junos, iosxe, nxos, iosxr)${hint}` })
    expect(dialect(['convert', '--from', 'eos', '--to', 'iosxe', 'a.conf'])).toEqual({ status: 2, stdout: '', stderr: `dialect: convert: --from eos: not one of junos, iosxe, nxos, iosxr${hint}` })
    expect(dialect(['convert', '--from', 'junos', '--to', 'iosxe'])).toEqual({ status: 2, stdout: '', stderr: `dialect: convert: give a file, or - for stdin${hint}` })
    expect(dialect(['convert', '--from', 'junos', '--to', 'iosxe', '--map'])).toEqual({ status: 2, stdout: '', stderr: `dialect: convert: --map needs a value${hint}` })
    expect(dialect(['convert', '--from', 'junos', '--from', 'junos', 'a.conf'])).toEqual({ status: 2, stdout: '', stderr: `dialect: convert: --from is given twice${hint}` })
    expect(dialect(['convert', '--force', 'a.conf'])).toEqual({ status: 2, stdout: '', stderr: `dialect: convert: unknown option '--force'${hint}` })
  })
})

describe('dialect convert: answers to keys, passwords and policies (#105)', () => {
  // A Junos config whose OSPF interface and eBGP neighbor authenticate (keys a conversion never carries), the neighbor
  // with no policy (which IOS-XR needs, RFC 8212): tests/fixtures/convert/secrets.conf. Its interface is named by the map.
  const lines = (...parts: string[]) => parts.map((p) => `${p}\n`).join('')
  const convert = (to: string, args: string[], input?: string) => dialect(['convert', '--from', 'junos', '--to', to, ...args, 'secrets.conf'], input, CONVERT)
  const mapFor = (name: string) => {
    const path = join(dir, `secrets-${name.replace(/\W/g, '-')}.csv`)
    writeFileSync(path, `ge-0/0/0,${name}\n`)
    return path
  }
  const xrMap = () => mapFor('GigabitEthernet0/0/0/0')
  const asked = {
    ospf: 'OSPF MD5 authentication on an interface needs its key ID (1 to 255) and key, as "ID KEY": the key isn\'t carried.',
    bgp: 'A BGP session with a password needs the password, which isn\'t carried.',
    policy: 'An eBGP neighbor has no route policy one way or both: IOS-XR, following RFC 8212, exchanges no routes that way without one. Name an existing route policy to attach.'
  }
  const IDS = {
    ospf: 'iosxr.ospf-key:networkInstances.default.ospf.areas["0.0.0.0"].interfaces["GigabitEthernet0/0/0/0.0"]',
    bgp: 'iosxr.bgp-password:networkInstances.default.bgp.neighbors["192.0.2.1"]',
    policy: 'iosxr.ebgp-policy:networkInstances.default.bgp.neighbors["192.0.2.1"]'
  }
  // Answers no message may repeat: a # and an = in the key, a comma in the password.
  const ANSWERS = { ospf: '7 K3y#Syn=th', bgp: 'Pa55,SYNTHETIC', policy: 'PASS-ALL' }
  /** An answers file's `"id" = ` lines filled in by each id's start (`iosxr.bgp-password:` → its answer). */
  const fill = (template: string, byPrefix: Record<string, string>) =>
    template.replace(/^("(?:[^"\\]|\\.)*") =$/gm, (line, quoted: string) => {
      const id = JSON.parse(quoted) as string
      const prefix = Object.keys(byPrefix).find((p) => id.startsWith(p))
      return prefix ? `${quoted} = ${byPrefix[prefix]}` : line
    })
  const noSecrets = (stderr: string) => {
    for (const value of ['$9$placeholder', ...Object.values(ANSWERS), 'K3y', 'Pa55', ...Object.values(IDS), '192.0.2.1']) expect(stderr).not.toContain(value)
  }

  it('exits 3 while keys, passwords or a policy are unanswered, saying where and what, never which or a value', () => {
    const run = convert('iosxr', ['--map', xrMap()])
    expect(run.status).toBe(3)
    expect(run.stdout).toBe('')
    expect(run.stderr).toContain(
      lines(
        `secrets.conf:21:21: error: secret needed: ${asked.ospf}`,
        `secrets.conf:34:17: error: secret needed: ${asked.bgp}`,
        `secrets.conf:34:17: error: needs input: ${asked.policy}`,
        'dialect: 3 items need an answer: give their answers with --answers (--write-answers <file> writes everything asked, to fill in), or write the config anyway with --allow-incomplete.'
      )
    )
    // A render's warning about a field has its statement's line now (#105).
    expect(run.stderr).toContain('secrets.conf:34:17: warning: The source accepts an eBGP neighbor\'s routes with no policy')
    noSecrets(run.stderr)
    // Interfaces and other items, counted apart.
    const both = convert('iosxr', [])
    expect(both.stderr).toContain(
      'dialect: 1 interface has no name on Cisco IOS-XR, and 3 items need an answer: give it with --map (--write-map <file> writes every interface, with suggestions, to fill in); give their answers with --answers (--write-answers <file> writes everything asked, to fill in); or write the config anyway with --allow-incomplete.\n'
    )
    const incomplete = convert('iosxr', ['--allow-incomplete'])
    expect(incomplete.status).toBe(0)
    expect(incomplete.stderr).toContain('dialect: warning: incomplete: 1 interface has no name on Cisco IOS-XR, and keeps its Junos name; 3 items need an answer, and what they need is left out.\n')
    expect(incomplete.stdout).toContain('router bgp 65000\n')
    expect(incomplete.stdout).not.toMatch(/password|message-digest-key|route-policy/)
  })

  it('writes everything asked to an answers file which, filled in, completes the config: from a file or stdin', () => {
    const template = join(dir, 'answers.txt')
    expect(convert('iosxr', ['--map', xrMap(), '--write-answers', template]).stderr).toContain(`dialect: 3 items need an answer: fill in ${template} and give it with --answers, or write the config anyway with --allow-incomplete.\n`)
    const written = readFileSync(template, 'utf8')
    expect(written).toBe(
      [
        '# Answers for dialect convert --answers: one "id" = answer line per item. Leave an answer empty to leave it',
        '# unanswered. The answer is the rest of the line, as typed (spaces at either end are dropped). Keys and',
        '# passwords are secrets: keep this file safe, and delete it when the config is done.',
        '',
        `# Line 21: secret. ${asked.ospf}`,
        `${JSON.stringify(IDS.ospf)} =`,
        '',
        `# Line 34: secret. ${asked.bgp}`,
        `${JSON.stringify(IDS.bgp)} =`,
        '',
        `# Line 34: ${asked.policy}`,
        `${JSON.stringify(IDS.policy)} =`,
        ''
      ].join('\n')
    )
    const filled = fill(written, { 'iosxr.ospf-key:': ANSWERS.ospf, 'iosxr.bgp-password:': ANSWERS.bgp, 'iosxr.ebgp-policy:': ANSWERS.policy })
    writeFileSync(template, filled)
    for (const run of [convert('iosxr', ['--map', xrMap(), '--answers', template]), convert('iosxr', ['--map', xrMap(), '--answers', '-'], filled)]) {
      expect(run.status, run.stderr).toBe(0)
      expect(run.stdout).toContain('   message-digest-key 7 md5 clear K3y#Syn=th\n')
      expect(run.stdout).toContain('  password clear Pa55,SYNTHETIC\n')
      expect(run.stdout).toContain('   route-policy PASS-ALL in\n   route-policy PASS-ALL out\n')
      expect(run.stderr).not.toMatch(/error|needs input|secret needed/)
      noSecrets(run.stderr)
    }
    // Written again, the answers given are kept; JSON answers the same.
    const again = join(dir, 'answers-again.txt')
    expect(convert('iosxr', ['--map', xrMap(), '--answers', template, '--write-answers', again]).status).toBe(0)
    expect(readFileSync(again, 'utf8')).toBe(filled)
    writeFileSync(join(dir, 'answers.json'), JSON.stringify({ [IDS.ospf]: ANSWERS.ospf, [IDS.bgp]: ANSWERS.bgp, [IDS.policy]: ANSWERS.policy }))
    expect(convert('iosxr', ['--map', xrMap(), '--answers', join(dir, 'answers.json')]).stdout).toContain('  password clear Pa55,SYNTHETIC\n')
  })

  it.each([
    ['iosxe', 'GigabitEthernet0/0/0', { 'ospf-key:': 'K3y#Syn=th', 'bgp-password:': ANSWERS.bgp }, [' ip ospf message-digest-key 1 md5 K3y#Syn=th\n', ' neighbor 192.0.2.1 password Pa55,SYNTHETIC\n']],
    ['nxos', 'Ethernet1/1', { 'nxos.ospf-key:': ANSWERS.ospf, 'nxos.bgp-password:': ANSWERS.bgp }, ['  ip ospf message-digest-key 7 md5 0 K3y#Syn=th\n', '    password 0 Pa55,SYNTHETIC\n']]
  ])('completes the OSPF key and BGP password on %s', (to, name, answers, expected) => {
    const template = join(dir, `answers-${to}.txt`)
    const first = convert(to, ['--map', mapFor(name), '--write-answers', template])
    expect(first.status).toBe(3)
    expect(first.stderr).toContain('dialect: 2 items need an answer')
    writeFileSync(template, fill(readFileSync(template, 'utf8'), answers))
    const run = convert(to, ['--map', mapFor(name), '--answers', template])
    expect(run.status, run.stderr).toBe(0)
    for (const line of expected) expect(run.stdout).toContain(line)
    noSecrets(run.stderr)
  })

  it('says an answer is not in the form asked for, without repeating it, and warns of answers to nothing asked', () => {
    writeFileSync(join(dir, 'wrong.txt'), `${JSON.stringify(IDS.ospf)} = K3y-without-an-id\n"nothing:asked" = SYNTHETIC\n`)
    const run = convert('iosxr', ['--map', xrMap(), '--answers', join(dir, 'wrong.txt')])
    expect(run.status).toBe(3)
    expect(run.stderr).toContain(`secrets.conf:21:21: error: secret needed: ${asked.ospf} (the answer given isn't in the form asked for)\n`)
    expect(run.stderr).toContain(`dialect: warning: ${join(dir, 'wrong.txt')}: 1 answer is for nothing this conversion asks\n`)
    expect(run.stderr).not.toContain('K3y-without-an-id')
    expect(run.stderr).not.toContain('SYNTHETIC')
  })

  it('asks once for a password a BGP group shared by VRFs needs at each place, and one answer serves them all', () => {
    // IOS-XR's global neighbor group G, with a password, used by neighbors in VRFs A and B: NX-OS asks for G's password
    // in the global table and in each VRF, by one id.
    const src = ['vrf A', '!', 'vrf B', '!', 'router bgp 65000', ' neighbor-group G', '  remote-as 65000', '  password encrypted SYNTHETIC_HASH', ' !', ' vrf A', '  neighbor 192.0.2.2', '   use neighbor-group G', '  !', ' !', ' vrf B', '  neighbor 192.0.2.3', '   use neighbor-group G', '  !', ' !', '!', ''].join('\n')
    const template = join(dir, 'answers-group.txt')
    const xr = (args: string[]) => dialect(['convert', '--from', 'iosxr', '--to', 'nxos', ...args, '-'], src)
    const first = xr(['--write-answers', template])
    expect(first.status).toBe(3)
    expect(first.stderr).toContain('dialect: 1 item needs an answer: fill in')
    const written = readFileSync(template, 'utf8')
    expect(written.match(/^"nxos\.bgp-password:[^\n]*=$/gm)).toHaveLength(1)
    // All three places come from the group's one password statement.
    expect(written).toContain('\n# Line 8: secret. A BGP session with a password needs the password')
    expect(first.stderr.match(/secret needed/g)).toHaveLength(1)
    writeFileSync(template, fill(written, { 'nxos.bgp-password:': ANSWERS.bgp }))
    const run = xr(['--answers', template])
    expect(run.status, run.stderr).toBe(0)
    expect(run.stdout).toContain('password 0 Pa55,SYNTHETIC\n')
    noSecrets(run.stderr)
    expect(run.stderr).not.toContain('SYNTHETIC_HASH')
  })

  it('exits 2 for an answers file it can\'t read, by line and never quoting it', () => {
    const answers = (name: string, text: string) => {
      writeFileSync(join(dir, name), text)
      return convert('iosxr', ['--map', xrMap(), '--answers', join(dir, name)])
    }
    const expectRefused = (name: string, text: string, problems: string[]) => expect(answers(name, text)).toEqual({ status: 2, stdout: '', stderr: lines(...problems.map((p) => `dialect: ${join(dir, name)}: ${p}`)) })
    expectRefused('bare.txt', '# a comment\nSYNTHETIC = x\n', ['line 2: expected "id" = answer, the id a JSON string'])
    expectRefused('no-equals.txt', '"a" SYNTHETIC\n', ['line 1: expected "id" = answer, the id a JSON string'])
    // An id JSON doesn't read (a \q escape, a tab inside it) is refused by line, the parser's message not repeated.
    expectRefused('escape.txt', '"SYNTHETIC\\q" = x\n', ['line 1: expected "id" = answer, the id a JSON string'])
    expectRefused('control.txt', '"SYNTHETIC\tID" = x\n', ['line 1: expected "id" = answer, the id a JSON string'])
    expectRefused('unicode.txt', '"SYNTHETIC\\u12" = x\n', ['line 1: expected "id" = answer, the id a JSON string'])
    expectRefused('twice.txt', '"a" = SYNTHETIC\n\n"a" = other\n', ['line 3: answered twice (first on line 1)'])
    expectRefused('interface.txt', '"interface:ge-0/0/0" = Gi1\n', ["line 1: an interface's name: give it with --map"])
    expectRefused('bad.json', '{"a": SYNTHETIC}', ['not valid JSON'])
    expectRefused('list.json', '["SYNTHETIC"]', ['the JSON is not an object of answers'])
    expectRefused('values.json', '{"a": 1, "b": "SYN\\nTHETIC", "interface:x": "y"}', ['an answer is not a string', 'an answer has a line break', "an id is an interface's: give interface names with --map"])
    expect(convert('iosxr', ['--answers', join(dir, 'none.txt')])).toEqual({ status: 2, stdout: '', stderr: `dialect: can't read ${join(dir, 'none.txt')}: no such file\n` })
    const hint = "\nRun 'dialect --help' for usage.\n"
    expect(dialect(['convert', '--from', 'junos', '--to', 'iosxr', '--answers', '-', '-'], '')).toEqual({ status: 2, stdout: '', stderr: `dialect: convert: the config and --answers can't both be read from stdin${hint}` })
    expect(dialect(['convert', '--from', 'junos', '--to', 'iosxr', '--answers'])).toEqual({ status: 2, stdout: '', stderr: `dialect: convert: --answers needs a value${hint}` })
  })
})

describe('dialect usage', () => {
  const hint = "\nRun 'dialect --help' for usage.\n"

  it('exits 2 with a message for a usage error', () => {
    expect(dialect([])).toMatchObject({ status: 2, stdout: '' })
    expect(dialect([]).stderr).toContain('Usage: dialect <command>')
    expect(dialect(['translate'])).toEqual({ status: 2, stdout: '', stderr: `dialect: unknown command 'translate'${hint}` })
    expect(dialect(['display-set'])).toEqual({ status: 2, stdout: '', stderr: `dialect: display-set: give a file, or - for stdin${hint}` })
    expect(dialect(['display-set', 'a.conf', 'b.conf'])).toEqual({ status: 2, stdout: '', stderr: `dialect: display-set: give one file${hint}` })
    expect(dialect(['display-set', '--strip', 'a.conf'])).toEqual({ status: 2, stdout: '', stderr: `dialect: display-set: unknown option '--strip'${hint}` })
  })

  it('prints help and the version to stdout, and exits 0', () => {
    for (const args of [['--help'], ['-h'], ['help'], ['display-set', '--help'], ['convert', '--help']]) {
      const run = dialect(args)
      expect(run.status).toBe(0)
      expect(run.stdout).toContain('display-set <file|->')
      expect(run.stderr).toBe('')
    }
    const { version } = JSON.parse(readFileSync(join(cliRoot, 'package.json'), 'utf8')) as { version: string }
    expect(dialect(['--version'])).toEqual({ status: 0, stdout: `dialect ${version}\n`, stderr: '' })
  })
})
