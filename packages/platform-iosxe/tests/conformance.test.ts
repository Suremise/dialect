// The conformance kit over the plugin's own fixtures (tests/fixtures/<area>): each one parsed, rendered, re-parsed and
// put through the coverage ledger.
import { describeConformance } from '@dialect/conformance'
import plugin from '../src'

describeConformance(plugin, new URL('./fixtures', import.meta.url))
