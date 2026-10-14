// Core's secret safety net (guardPlugin(), #115) on the Junos plugin: the cases found in #114 where one of the
// plugin's fixed texts holds a secret that is also one of its words. Guarded, as every shell gets it from the
// registry, it leaks none of them, under the conformance kit's secrets check with no allowances.
import { describe, expect, it } from 'vitest'
import { guardPlugin, MODEL_VERSION } from '@dialect/core'
import { checkFixture, checkSecrets } from '@dialect/conformance'
import junos from '../src'

const plugin = guardPlugin(junos)
const configTools = ['display-set']
const lines = (...l: string[]) => `${l.join('\n')}\n`
const KEY = 'set protocols ospf area 0.0.0.0 interface ge-0/0/0.0 authentication md5 1 key " the "'

describe('the safety net on Junos', () => {
  const cases: [name: string, source: string, secret: string][] = [
    // A render needs-input item: "This needs its key on Junos, which isn't carried over from the source."
    ['render needs-input', lines('set interfaces ge-0/0/0 unit 0 family inet address 192.0.2.1/24', KEY), ' the '],
    // A mapper's statement reason: "names an interface the configuration doesn't have, or that isn't converted".
    ['statement reason', lines('set chassis frobnicate', KEY), ' the '],
    // display set's and the parse's syntax diagnostic, "statement isn't ended by ';' or '{'", on the text cut just
    // after the community.
    ['syntax diagnostic', 'snmp {\n    community statement {\n        authorization read-only;\n    }\n}\n', 'statement'],
    // A key whose quote is left open: the parse's and display set's "unterminated quoted string" holds it, whichever
    // of those words it is.
    ...['quoted', 'string', 'unterminated'].map((key): [string, string, string] => [`syntax diagnostic on an open quote (${key})`, `set protocols ospf area 0 interface ge-0/0/0 authentication md5 1 key "${key}`, key])
  ]

  for (const [name, source, secret] of cases)
    it(`withholds a ${name} that holds a secret`, () => {
      expect(checkSecrets(plugin, source, [secret], { allowances: [], configTools }).leaks).toEqual([])
      // And as the kit finds the secret itself.
      const expectedModel = plugin.parse!(source, { modelVersion: MODEL_VERSION }).model
      const secrets = checkFixture(plugin, { name, source, expectedModel }, { allowances: [], configTools }).find((r) => r.check === 'secrets')
      expect(secrets?.status).toBe('passed')
    })
})
