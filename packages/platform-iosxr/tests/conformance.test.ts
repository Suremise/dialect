// The conformance kit over the plugin's own fixtures (tests/fixtures/<area>): each one parsed, rendered, re-parsed and
// put through the coverage ledger and the secrets check.
import { describeConformance } from '@dialect/conformance'
import plugin from '../src'

describeConformance(plugin, new URL('./fixtures', import.meta.url))
