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
  it('come from the statement\'s keywords', () => {
    expect(parse('set class-of-service interfaces ge-0/0/0 unit 0').dispositions.L1).toEqual({ kind: 'unsupported', reason: 'class of service comes later' })
    expect(parse('set frobnicate now').dispositions.L1).toEqual({ kind: 'unsupported', reason: 'a statement this converter doesn\'t read' })
  })

  it('never hold a secret that is also a keyword: the next reason that doesn\'t, or the last resort', () => {
    const cos = ['set class-of-service interfaces ge-0/0/0 unit 0', lines('class-of-service {', '    interfaces {', '        ge-0/0/0 {', '            unit 0;', '        }', '    }', '}')] as const
    const cases: [secret: string, statement: readonly [set: string, hierarchical: string], reason: string][] = [
      ['service', cos, 'a statement this converter doesn\'t read'],
      // In the table's reason (a routing instance's) and the generic one: the last resort.
      ['converter', ['set routing-instances R frobnicate x', lines('routing-instances {', '    R {', '        frobnicate x;', '    }', '}')], '—'],
      // In the table's reason only.
      ['comes', cos, 'a statement this converter doesn\'t read']
    ]
    // Each community bare and quoted, in set and hierarchical form; checkSecrets also tries the text cut after it and
    // with an unterminated quote.
    const forms = (spelled: string, [set, hierarchical]: readonly [string, string]) => [
      lines(`set snmp community ${spelled} authorization read-only`, set),
      lines('snmp {', `    community ${spelled} {`, '        authorization read-only;', '    }', '}', hierarchical)
    ]
    for (const [secret, statement, reason] of cases)
      for (const text of [...forms(secret, statement), ...forms(`"${secret}"`, statement)]) {
        const result = parse(text)
        const unsupported = Object.values(result.dispositions).filter((d) => d.kind === 'unsupported')
        expect(unsupported.length, text).toBeGreaterThan(0)
        for (const d of unsupported) expect(d, text).toEqual({ kind: 'unsupported', reason })
        expect(checkSecrets(plugin, text, [secret], { allowances: [], configTools: ['display-set'] }).leaks, text).toEqual([])
        // And as the kit finds the secret itself.
        const secrets = checkFixture(plugin, { name: secret, source: text, expectedModel: result.model }, { allowances: [], configTools: ['display-set'] }).find((r) => r.check === 'secrets')
        expect(secrets?.status, text).toBe('passed')
      }
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
    expect(secretValues(text).sort()).toEqual(['$6$abcd$efgh', '$9$wxyz', 'comes', 'converter', 'ntpvalue', 'psk value', 'tacsecret'].sort())
    // Cut short, as the kit's broken copies are: an unterminated quote, a community with no `{` yet.
    expect(secretValues('set snmp community "comes')).toEqual(['comes'])
    expect(secretValues('snmp {\n    community converter')).toEqual(['converter'])
    expect(unconvertedReason(['class-of-service', 'interfaces'], ['comes'])).toBe('a statement this converter doesn\'t read')
  })
})
