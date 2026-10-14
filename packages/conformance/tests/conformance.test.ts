// A careful stub plugin passes the kit: every fixture through the five checks, as a platform plugin's own tests run it.
// A stub that leaks a secret passes too while a temporary allowance names the leak, and the suite's own test finds
// the allowance still needed.
import { describeConformance } from '../src'
import stub, { stubPlugin } from './stubPlatform'

const fixtures = new URL('./fixtures', import.meta.url)

describeConformance(stub, fixtures)
describeConformance(stubPlugin({ id: 'stub-allowed', leaks: ['statement reason'] }), fixtures, {
  allowances: [{ plugin: 'stub-allowed', site: 'statement reason', leak: 'unsupported reasons quote the statement', card: 1 }]
})
