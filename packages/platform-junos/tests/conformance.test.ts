// The conformance kit over the plugin's own fixtures (tests/fixtures/conformance/<area>): each one parsed, rendered,
// re-parsed and put through the coverage ledger. The set-form fixtures have no expected render: the plugin renders
// hierarchical Junos, which the hierarchical fixtures' renders show.
import { describeConformance } from '@dialect/conformance'
import plugin from '../src'

describeConformance(plugin, new URL('./fixtures/conformance', import.meta.url))
