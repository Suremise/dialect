// Every statement left out says why (#109), in fixed texts (src/unconverted.ts) that are never a word of the
// configuration: and so never one that a secret of it is, as a community named like a keyword would make them (#114).
import { describe, expect, it } from 'vitest'
import { MODEL_VERSION } from '@dialect/core'
import { checkFixture, checkSecrets } from '@dialect/conformance'
import plugin from '../src'
import { secretValues, unconvertedReason } from '../src/unconverted'

const parse = (text: string) => plugin.parse!(text, { modelVersion: MODEL_VERSION })
const lines = (...l: string[]) => l.join('\n')

describe('reasons for what isn\'t converted', () => {
  it('come from the keywords of the top-level statement', () => {
    expect(parse('multicast-routing').dispositions.L1).toEqual({ kind: 'unsupported', reason: 'multicast comes later' })
    expect(parse('frobnicate now').dispositions.L1).toEqual({ kind: 'unsupported', reason: 'a statement this converter doesn\'t read' })
  })

  it('never hold a secret that is also a keyword: the next reason that doesn\'t, or the last resort', () => {
    const cases: [secret: string, statement: string, reason: string][] = [
      ['multicast', 'multicast-routing', 'a statement this converter doesn\'t read'],
      // In the table's reason (a VRF's) and the generic one: the last resort.
      ['converter', lines('vrf BLUE', ' frobnicate'), '—'],
      // In the table's reason only.
      ['later', 'multicast-routing', 'a statement this converter doesn\'t read']
    ]
    // Each community bare and quoted; checkSecrets also tries the text cut after it and with an unterminated quote.
    for (const [secret, statement, reason, spelled] of cases.flatMap(([s, st, r]) => [[s, st, r, s], [s, st, r, `"${s}"`]] as const)) {
      const text = lines(`snmp-server community ${spelled} RO`, statement)
      const result = parse(text)
      const last = `L${text.split('\n').length}`
      expect(result.dispositions[last], secret).toEqual({ kind: 'unsupported', reason })
      expect(checkSecrets(plugin, text, [secret], { allowances: [] }).leaks, secret).toEqual([])
      // And as the kit finds the secret itself.
      const secrets = checkFixture(plugin, { name: secret, source: text, expectedModel: result.model }, { allowances: [] }).find((r) => r.check === 'secrets')
      expect(secrets?.status, secret).toBe('passed')
    }
  })

  it('find the configuration\'s secrets as the kit does, four characters or more', () => {
    const text = lines(
      'snmp-server community multicast RO',
      'snmp-server community RO RO',
      'username admin',
      ' secret 10 $6$abcd$efgh',
      ' password 7 0822455D0A16',
      'username oper password clearpass',
      'tacacs-server host 192.0.2.1 port 49',
      ' key 7 tacacskey',
      'radius-server key radiuskey',
      'ntp authentication-key 1 md5 encrypted ntpsecret',
      'key chain KC',
      ' key 1',
      '  key-string password keystring'
    )
    expect(secretValues(text).sort()).toEqual(['$6$abcd$efgh', '0822455D0A16', 'clearpass', 'keystring', 'multicast', 'ntpsecret', 'radiuskey', 'tacacskey'].sort())
    // Cut short, as the kit's broken copies are: an unterminated quote.
    expect(secretValues('snmp-server community "multicast')).toEqual(['multicast'])
    expect(secretValues('tacacs-server host 192.0.2.1\n key 7 tacacskey "')).toContain('tacacskey')
    expect(unconvertedReason(['multicast-routing'], ['multicast'])).toBe('a statement this converter doesn\'t read')
  })
})
