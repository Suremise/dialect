// A careful stub plugin passes the kit: every fixture through the five checks, as a platform plugin's own tests run it.
// A stub that leaks a secret passes too while a temporary allowance names the leak, and the suite's own test finds
// the allowance still needed.
import { describeConformance } from '../src'
import stub, { STUB_CONFIG_TOOLS, stubPlugin } from './stubPlatform'

const fixtures = new URL('./fixtures', import.meta.url)

describeConformance(stub, fixtures, { configTools: STUB_CONFIG_TOOLS })
describeConformance(stubPlugin({ id: 'stub-allowed', leaks: ['statement reason'] }), fixtures, {
  configTools: STUB_CONFIG_TOOLS,
  allowances: [
    { plugin: 'stub-allowed', site: 'statement reason', leak: 'unsupported reasons quote the statement', card: 1 },
    // For a fixture this folder hasn't: another test file's to check, not this suite's.
    { plugin: 'stub-allowed', site: 'tool text', fixtures: ['elsewhere/case'], leak: 'a report quotes a line', card: 1 }
  ]
})
