// Every statement left out says why (#109), in fixed texts (src/unconverted.ts) that are never a word of the
// configuration: and so never one that a secret of it is, as a community named like a keyword would make them (#114).
import { describe, expect, it } from 'vitest'
import { MODEL_VERSION } from '@dialect/core'
import { checkFixture, checkSecrets } from '@dialect/conformance'
import plugin from '../src'
import { secretValues, unconvertedReason } from '../src/unconverted'

const parse = (text: string) => plugin.parse!(text, { modelVersion: MODEL_VERSION })
const lines = (...l: string[]) => l.join('\n')
const GENERIC = 'a statement this converter doesn\'t read'
const WITHHELD = 'a statement whose reason is withheld, as it would repeat a value of this configuration'
const configTools = ['display-set']

/** `text` leaks none of `secret` through checkSecrets, nor as the kit finds its secrets itself (checkFixture). */
function expectNoLeak(text: string, secret: string) {
  expect(checkSecrets(plugin, text, [secret], { allowances: [], configTools }).leaks, text).toEqual([])
  const secrets = checkFixture(plugin, { name: secret.trim(), source: text, expectedModel: parse(text).model }, { allowances: [], configTools }).find((r) => r.check === 'secrets')
  expect(secrets?.status, text).toBe('passed')
}

/** Every unsupported statement of `text` has `reason`. */
function expectReasons(text: string, reason: string) {
  const unsupported = Object.values(parse(text).dispositions).filter((d) => d.kind === 'unsupported')
  expect(unsupported.length, text).toBeGreaterThan(0)
  for (const d of unsupported) expect(d, text).toEqual({ kind: 'unsupported', reason })
}

describe('reasons for what isn\'t converted', () => {
  it('come from the statement\'s keywords', () => {
    expect(parse('set class-of-service interfaces ge-0/0/0 unit 0').dispositions.L1).toEqual({ kind: 'unsupported', reason: 'class of service comes later' })
    expect(parse('set frobnicate now').dispositions.L1).toEqual({ kind: 'unsupported', reason: GENERIC })
  })

  it('never hold a secret that is also a keyword: the next reason that doesn\'t, the withheld one, or the last resort', () => {
    const cos = ['set class-of-service interfaces ge-0/0/0 unit 0', lines('class-of-service {', '    interfaces {', '        ge-0/0/0 {', '            unit 0;', '        }', '    }', '}')] as const
    const cases: [secret: string, statement: readonly [set: string, hierarchical: string], reason: string][] = [
      ['service', cos, GENERIC],
      // In the table's reason only.
      ['comes', cos, GENERIC],
      // In the table's reason (a routing instance's) and the generic one: withheld.
      ['converter', ['set routing-instances R frobnicate x', lines('routing-instances {', '    R {', '        frobnicate x;', '    }', '}')], WITHHELD],
      // In the table's reason (a routing policy's), the generic one and the withheld one: the last resort.
      ['this', ['set policy-options frobnicate x', lines('policy-options {', '    frobnicate x;', '}')], '—']
    ]
    // Each community bare and quoted, in set and hierarchical form; checkSecrets also tries the text cut after it and
    // with an unterminated quote.
    const forms = (spelled: string, [set, hierarchical]: readonly [string, string]) => [
      lines(`set snmp community ${spelled} authorization read-only`, set),
      lines('snmp {', `    community ${spelled} {`, '        authorization read-only;', '    }', '}', hierarchical)
    ]
    for (const [secret, statement, reason] of cases)
      for (const text of [...forms(secret, statement), ...forms(`"${secret}"`, statement)]) {
        expectReasons(text, reason)
        expectNoLeak(text, secret)
      }
  })

  it('never hold a quoted key, with a quote opened after it as the kit tries it', () => {
    // The kit's broken copy turns `key "later"` into `key "later ""`: the quoted value it finds there is `later `.
    const texts = [
      lines('set class-of-service interfaces ge-0/0/0 unit 0', 'set protocols ospf area 0.0.0.0 interface ge-0/0/0.0 authentication md5 1 key "later"'),
      lines('class-of-service {', '    interfaces {', '        ge-0/0/0 {', '            unit 0;', '        }', '    }', '}', 'protocols {', '    ospf {', '        area 0.0.0.0 {', '            interface ge-0/0/0.0 {', '                authentication {', '                    md5 1 key "later";', '                }', '            }', '        }', '    }', '}')
    ]
    for (const text of texts) expectNoLeak(text, 'later')
    expect(secretValues('set protocols ospf area 0 interface ge-0/0/0.0 authentication md5 1 key "later ""')).toContain('later')
  })

  it('never hold a quoted secret whose spaces bring it to four characters', () => {
    // The kit takes ` the ` as the secret: trimmed, `the` would be too short to count, and `…: the model…` would hold it.
    const texts = [
      lines('set chassis frobnicate', 'set system tacplus-server 192.0.2.1 secret " the "'),
      lines('chassis {', '    frobnicate;', '}', 'system {', '    tacplus-server 192.0.2.1 {', '        secret " the ";', '    }', '}')
    ]
    for (const text of texts) {
      expect(Object.values(parse(text).dispositions), text).toContainEqual({ kind: 'unsupported', reason: GENERIC })
      expectNoLeak(text, ' the ')
    }
    expect(secretValues('set system tacplus-server 192.0.2.1 secret " the "')).toContain(' the ')
    // With the kit's quote opened after it, the value is ` the  `: less the space that adds, ` the ` again.
    expect(secretValues('set system tacplus-server 192.0.2.1 secret " the  ""')).toContain(' the ')
  })

  it('find the configuration\'s secrets as the kit does, four characters or more', () => {
    const text = lines(
      'set snmp community "comes" authorization read-only',
      'set snmp community RO authorization read-only',
      'set system login user admin authentication encrypted-password "$6$abcd$efgh"',
      'set system tacplus-server 192.0.2.1 secret tacsecret',
      'set system ntp authentication-key 1 type md5 value "ntpvalue"',
      'set security ike policy P pre-shared-key ascii-text "psk value"',
      'protocols {',
      '    ospf {',
      '        area 0.0.0.0 {',
      '            interface ge-0/0/0.0 {',
      '                authentication {',
      '                    md5 1 key "$9$wxyz";',
      '                }',
      '            }',
      '        }',
      '    }',
      '}',
      'snmp {',
      '    community converter {',
      '        authorization read-only;',
      '    }',
      '}'
    )
    const found = secretValues(text)
    expect(found).toEqual(expect.arrayContaining(['$6$abcd$efgh', '$9$wxyz', 'comes', 'converter', 'ntpvalue', 'psk value', 'tacsecret']))
    expect(found).not.toContain('RO')
    // Cut short, as the kit's broken copies are: an unterminated quote, a community with no `{` yet.
    expect(secretValues('set snmp community "comes')).toContain('comes')
    expect(secretValues('snmp {\n    community converter')).toEqual(['converter'])
  })

  it('compare secrets with reasons in any case', () => {
    expect(unconvertedReason(['class-of-service', 'interfaces'], ['comes'])).toBe(GENERIC)
    expect(unconvertedReason(['class-of-service', 'interfaces'], ['COMES'])).toBe(GENERIC)
    expect(unconvertedReason(['frobnicate'], ['Converter'])).toBe(WITHHELD)
  })
})
