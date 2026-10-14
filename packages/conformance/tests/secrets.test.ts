// The secrets check's own tests (src/secrets.ts): which values it takes as secrets, a stub that leaks one in each kind
// of message failing it, the careful stub passing it, config tools and reports, and the temporary allowances
// (src/allowances.ts).
import { describe, expect, it } from 'vitest'
import type { PlatformPlugin } from '@dialect/core'
import { checkFixture, checkSecrets, findSecrets, SECRET_ALLOWANCES, type Fixture, type LeakSite, type SecretAllowance } from '../src'
import { STUB_CONFIG_TOOLS, stubPlugin } from './stubPlatform'

const SITES: readonly LeakSite[] = ['parse diagnostic', 'parse needs-input', 'statement reason', 'render diagnostic', 'render needs-input', 'field reason', 'tool diagnostic', 'tool text', 'thrown error']

const secretsCheck = (results: ReturnType<typeof checkFixture>) => results.find((r) => r.check === 'secrets')!
/** The stub's echo tool gives config, as a plugin's own suite would say of its config tools. */
const stubOptions = { configTools: STUB_CONFIG_TOOLS }

// Documentation values only (AGENTS.md: no real secrets in the repo).
const source = 'system {\n    host-name r1;\n    root-authentication {\n        encrypted-password "$9$PLACEHOLDER";\n    }\n    snmp {\n        community PLACEHOLDER-RO {\n            authorization read-only;\n        }\n    }\n}\n'
const fixture: Fixture = { name: 'system/secrets', source, expectedModel: { system: { hostname: 'r1' } } }

describe('findSecrets', () => {
  it('finds Junos hashes, keys and SNMP communities, hierarchical and set', () => {
    expect(findSecrets(source)).toEqual(['$9$PLACEHOLDER', 'PLACEHOLDER-RO'])
    const set = [
      'set system root-authentication encrypted-password "$6$PLACEHOLDER$hash"',
      'set system login user ops authentication encrypted-password "$1$PLACEHOLDER$hash"',
      'set snmp community PLACEHOLDER-SET authorization read-only',
      'set protocols bgp authentication-key PLACEHOLDER-BGP',
      'set security authentication-key-chains key-chain kc key 0 secret PLACEHOLDER-CHAIN',
      'set security ike policy p pre-shared-key ascii-text "PLACEHOLDER PSK"',
      'set system ntp authentication-key 2 type sha1 value PLACEHOLDER-NTP',
      'set system tacplus-server 192.0.2.1 secret "$9$PLACEHOLDER-TAC"'
    ].join('\n')
    expect(findSecrets(set)).toEqual(['$6$PLACEHOLDER$hash', '$1$PLACEHOLDER$hash', '$9$PLACEHOLDER-TAC', 'PLACEHOLDER-SET', 'PLACEHOLDER-NTP', 'PLACEHOLDER-BGP', 'PLACEHOLDER-CHAIN', 'PLACEHOLDER PSK'])
  })

  it('finds IOS passwords, secrets, keys and communities', () => {
    const ios = [
      'enable secret 9 $9$PLACEHOLDER$hash',
      'enable password PLACEHOLDER-EN',
      'username ops privilege 15 secret PLACEHOLDER-USER',
      'username ro password 7 0822PLACEHOLDER',
      'snmp-server community PLACEHOLDER-RO RO',
      'tacacs-server host 192.0.2.1 key 7 PLACEHOLDER-TAC',
      'radius-server key PLACEHOLDER-RAD',
      'ntp authentication-key 1 md5 PLACEHOLDER-NTP 7',
      'key chain kc',
      ' key 1',
      '  key-string 7 PLACEHOLDER-KEY',
      'line vty 0 4',
      ' password PLACEHOLDER-VTY'
    ].join('\n')
    expect(findSecrets(ios)).toEqual(['$9$PLACEHOLDER$hash', '0822PLACEHOLDER', 'PLACEHOLDER-TAC', 'PLACEHOLDER-KEY', 'PLACEHOLDER-EN', 'PLACEHOLDER-USER', 'PLACEHOLDER-VTY', 'PLACEHOLDER-RO', 'PLACEHOLDER-RAD', 'PLACEHOLDER-NTP'])
  })

  it('takes no policy community, key chain name, key number or type keyword for a secret', () => {
    const notSecrets = [
      'policy-options {',
      '    community fabric members target:1:1;',
      '    community vni-100 {',
      '        members target:1:100;',
      '    }',
      '    policy-statement p { term t { from community vni-100; then community add fabric; } }',
      '}',
      'set protocols bgp group ext authentication-key-chain bgp-auth',
      'set system ntp authentication-key 2 type sha1 value "$9$PLACEHOLDER"',
      'ntp authentication-key 1 cmac-aes-128 PLACEHOLDER-CMAC',
      'key chain kc',
      ' key 1',
      'service password-encryption'
    ].join('\n')
    expect(findSecrets(notSecrets)).toEqual(['$9$PLACEHOLDER', 'PLACEHOLDER-CMAC'])
  })

  it('keeps a secret whose value the source also has elsewhere (a comment, a VRF of the same name)', () => {
    expect(findSecrets('snmp-server community PLACEHOLDER-REVIEW RO\n! fixture comment mentions PLACEHOLDER-REVIEW\n')).toEqual(['PLACEHOLDER-REVIEW'])
    expect(findSecrets('snmp-server community __proto__ RW\nip route vrf __proto__ 0.0.0.0 0.0.0.0 192.0.2.1')).toEqual(['__proto__'])
  })
})

/** A plugin that warns about every line, quoting it: a leak wherever the secret is on a line. */
const quoting: PlatformPlugin = {
  id: 'quoting',
  name: 'Quoting (tests only)',
  modelApi: '>=0.1.0 <1.0.0',
  capabilities: {},
  parse: (text) => ({ tree: [], model: {}, dispositions: {}, diagnostics: text.split('\n').filter(Boolean).map((line) => ({ severity: 'warning' as const, message: `bad line: ${line}` })) }),
  render: () => ({ text: '', dispositions: {}, diagnostics: [] })
}

describe('the secrets check', () => {
  it('passes the careful stub, whose messages name statements and positions, not values', () => {
    const r = secretsCheck(checkFixture(stubPlugin(), fixture, stubOptions))
    expect(r).toEqual({ check: 'secrets', status: 'passed', problems: [] })
  })

  it('is skipped for a fixture with no secrets', () => {
    const r = secretsCheck(checkFixture(stubPlugin(), { name: 'system/plain', source: 'system { host-name r1; }', expectedModel: { system: { hostname: 'r1' } } }, stubOptions))
    expect(r.status).toBe('skipped')
  })

  it("doesn't count the rendered config or a config tool's text, which are the config itself", () => {
    const secret = 'PLACEHOLDER-HOST'
    const plugin = stubPlugin()
    const host = `system { host-name ${secret}; }`
    expect(plugin.render!(plugin.parse!(host, { modelVersion: '0.1.0' }).model, { modelVersion: '0.1.0' }).text).toContain(secret)
    expect(plugin.tools!().find((t) => t.id === 'echo')!.run(host).text).toContain(secret)
    expect(checkSecrets(plugin, host, [secret], { allowances: [], configTools: ['echo'] })).toEqual({ leaks: [], allowed: [] })
  })

  it("counts the text of a tool not named as giving config: a report, or a config tool the suite didn't name", () => {
    const report = checkSecrets(stubPlugin({ leaks: ['tool text'] }), source, ['$9$PLACEHOLDER'], { allowances: [], configTools: ['echo'] })
    expect(report.leaks.map((l) => [l.site, l.tool, l.input, l.text])).toEqual([['tool text', 'report', 'fixture', 'a quote in: encrypted-password "$9$PLACEHOLDER";\n']])
    const unnamed = checkSecrets(stubPlugin(), source, ['PLACEHOLDER-RO'], { allowances: [] })
    expect(unnamed.leaks.map((l) => [l.site, l.tool])).toEqual([['tool text', 'echo']])
  })

  it('finds a leak of a secret whose value the source also has elsewhere', () => {
    const text = 'snmp-server community PLACEHOLDER-REVIEW RO\n! fixture comment mentions PLACEHOLDER-REVIEW\n'
    const r = secretsCheck(checkFixture(quoting, { name: 'snmp/repeated', source: text, expectedModel: {} }, { allowances: [] }))
    expect(r.status).toBe('failed')
    expect(r.problems[0]).toBe('parse diagnostic on the fixture contains the secret "PLACEHOLDER-REVIEW": "bad line: snmp-server community PLACEHOLDER-REVIEW RO"')
  })

  // The model side's leaks need a secret in the model: the host name, listed as the fixture's secret.
  const hostFixture: Fixture = { name: 'system/host', source: 'system { host-name PLACEHOLDER-HOST; services { ftp "x"; } }', expectedModel: { system: { hostname: 'PLACEHOLDER-HOST' } }, secrets: ['PLACEHOLDER-HOST'] }
  const leakFixture = (site: LeakSite) => (['render diagnostic', 'render needs-input', 'field reason'].includes(site) ? hostFixture : fixture)

  it.each(SITES)('fails a stub that quotes a secret in a %s', (site) => {
    const r = secretsCheck(checkFixture(stubPlugin({ leaks: [site] }), leakFixture(site), { ...stubOptions, allowances: [] }))
    expect(r.status).toBe('failed')
    expect(r.problems.length).toBeGreaterThan(0)
    const name = site === 'tool diagnostic' ? 'tool echo diagnostic' : site === 'tool text' ? 'tool report text' : site
    expect(r.problems.every((p) => p.startsWith(name)), r.problems.join('\n')).toBe(true)
  })

  it('finds a syntax error that quotes the line only on a broken copy of the fixture', () => {
    const { leaks } = checkSecrets(stubPlugin({ leaks: ['thrown error'] }), source, findSecrets(source), { ...stubOptions, allowances: [] })
    expect(leaks.map((l) => [l.site, l.input, l.secret, l.text])).toEqual([
      ['thrown error', 'cut after a secret', '$9$PLACEHOLDER', 'stub: unexpected end of text after "encrypted-password $9$PLACEHOLDER"'],
      ['thrown error', 'cut after a secret', 'PLACEHOLDER-RO', 'stub: unexpected end of text after "community PLACEHOLDER-RO"']
    ])
  })

  it('reports where the leak is, its code and the secret, once per kind of message, on the first input it is on', () => {
    const r = secretsCheck(checkFixture(stubPlugin({ leaks: ['tool diagnostic'] }), fixture, { ...stubOptions, allowances: [] }))
    expect(r.problems).toEqual([
      'tool echo diagnostic (stub.quote) on the fixture contains the secret "$9$PLACEHOLDER": "a quote in: encrypted-password \\"$9$PLACEHOLDER\\";"',
      'tool echo diagnostic (stub.quote) on the fixture with a quote opened after a secret contains the secret "PLACEHOLDER-RO": "a quote in: community PLACEHOLDER-RO \\" {"'
    ])
  })

  it('fails a listed secret that the source doesn\'t have', () => {
    const r = secretsCheck(checkFixture(stubPlugin(), { ...fixture, secrets: ['PLACEHOLDER-RO', 'PLACEHOLDER-TYPO'] }, stubOptions))
    expect(r.problems).toEqual(['the secret "PLACEHOLDER-TYPO" isn\'t in the fixture\'s source'])
  })

  it('runs for a plugin with tools only, no parse or render', () => {
    const { parse: _p, render: _r, ...toolsOnly } = stubPlugin({ id: 'stub-tools', leaks: ['tool diagnostic'] })
    const r = secretsCheck(checkFixture(toolsOnly, fixture, { ...stubOptions, allowances: [] }))
    expect(r.status).toBe('failed')
    expect(r.problems[0]).toMatch(/^tool echo diagnostic/)
  })
})

describe('temporary allowances', () => {
  const allowance: SecretAllowance = { plugin: 'stub-leaky', site: 'statement reason', leak: 'unsupported reasons quote the statement', card: 1 }
  const leaky = stubPlugin({ id: 'stub-leaky', leaks: ['statement reason'] })

  it('let a named leak through, and say so', () => {
    const r = secretsCheck(checkFixture(leaky, fixture, { ...stubOptions, allowances: [allowance] }))
    expect(r.status).toBe('passed')
    expect(r.allowed?.map((a) => a.allowance)).toEqual([allowance, allowance])
    expect(r.allowed?.map((a) => a.leak)).toEqual([expect.stringContaining('$9$PLACEHOLDER'), expect.stringContaining('PLACEHOLDER-RO')])
  })

  it('are only for their plugin, site, code, tool and fixture', () => {
    for (const other of [{ ...allowance, plugin: 'stub' }, { ...allowance, site: 'parse diagnostic' as const }, { ...allowance, code: 'stub.other' }, { ...allowance, tool: 'echo' }, { ...allowance, fixtures: ['system/other'] }])
      expect(secretsCheck(checkFixture(leaky, fixture, { ...stubOptions, allowances: [other] })).status).toBe('failed')
    expect(secretsCheck(checkFixture(leaky, fixture, { ...stubOptions, allowances: [{ ...allowance, fixtures: ['system/other', 'system/secrets'] }] })).status).toBe('passed')
    const tool = stubPlugin({ id: 'stub-leaky', leaks: ['tool diagnostic'] })
    expect(secretsCheck(checkFixture(tool, fixture, { ...stubOptions, allowances: [{ ...allowance, site: 'tool diagnostic', tool: 'echo', code: 'stub.quote' }] })).status).toBe('passed')
  })

  it('each name the card that fixes the leak', () => {
    for (const a of SECRET_ALLOWANCES) {
      expect(Number.isInteger(a.card) && a.card > 0, `${a.plugin}: ${a.leak}`).toBe(true)
      expect(SITES).toContain(a.site)
      expect(a.leak.length).toBeGreaterThan(0)
    }
  })
})
