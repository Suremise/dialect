// Every statement left out says why (#111), in fixed texts (src/unconverted.ts) that are never a word of the
// configuration: and so never one that a secret of it is, as a community named like a keyword would make them.
import { describe, expect, it } from 'vitest'
import { MODEL_VERSION } from '@dialect/core'
import { checkFixture, checkSecrets } from '@dialect/conformance'
import plugin from '../src'
import { secretValues, unconvertedReason } from '../src/unconverted'

const parse = (text: string) => plugin.parse!(text, { modelVersion: MODEL_VERSION })
const lines = (...l: string[]) => l.join('\n')

describe('reasons for what isn\'t converted', () => {
  it('come from the keywords of the top-level statement', () => {
    expect(parse('ip pim rp-address 192.0.2.1').dispositions.L1).toEqual({ kind: 'unsupported', reason: 'multicast comes later' })
    expect(parse('vpc domain 1').dispositions.L1).toEqual({ kind: 'unsupported', reason: 'vPC comes later' })
    expect(parse('frobnicate now').dispositions.L1).toEqual({ kind: 'unsupported', reason: 'a statement this converter doesn\'t read' })
  })

  it('never hold a secret that is also a keyword: the next reason that doesn\'t, or the last resort', () => {
    const cases: [secret: string, statement: string, reason: string][] = [
      ['multicast', 'ip pim rp-address 192.0.2.1', 'a statement this converter doesn\'t read'],
      // In the table's reason (interface) and the generic one: the last resort.
      ['converter', lines('interface Ethernet1/1', '  frobnicate'), '—'],
      // In the table's reason only.
      ['come', 'vpc domain 1', 'a statement this converter doesn\'t read']
    ]
    // Each community bare and quoted; checkSecrets also tries the text cut after it and with an unterminated quote.
    for (const [secret, statement, reason, spelled] of cases.flatMap(([s, st, r]) => [[s, st, r, s], [s, st, r, `"${s}"`]] as const)) {
      const text = lines(`snmp-server community ${spelled} group network-operator`, statement)
      const result = parse(text)
      const last = `L${text.split('\n').length}`
      expect(result.dispositions[last], secret).toEqual({ kind: 'unsupported', reason })
      expect(checkSecrets(plugin, text, [secret], { allowances: [] }).leaks, secret).toEqual([])
      // And as the kit finds the secret itself.
      const secrets = checkFixture(plugin, { name: secret, source: text, expectedModel: result.model }, { allowances: [] }).find((r) => r.check === 'secrets')
      expect(secrets?.status, secret).toBe('passed')
    }
  })

  it('find the configuration\'s secrets, four characters or more', () => {
    const text = lines('snmp-server community multicast group network-operator', 'username admin password 5 $5$abcd$efgh role network-admin', 'tacacs-server key 7 "tacacskey"', 'ntp authentication-key 1 md5 ntpsecret 7', 'interface Ethernet1/1', '  ip ospf authentication-key 3 ospfkey1')
    expect(secretValues(text).sort()).toEqual(['$5$abcd$efgh', 'multicast', 'ntpsecret', 'ospfkey1', 'tacacskey'].sort())
    expect(unconvertedReason(['ip', 'pim'], ['multicast'])).toBe('a statement this converter doesn\'t read')
  })
})
