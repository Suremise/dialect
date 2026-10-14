// The conformance kit over the plugin's own fixtures (tests/fixtures/conformance/<area>): each one parsed, rendered,
// re-parsed, put through the coverage ledger and checked for secrets. The set-form fixtures have no expected render:
// the plugin renders hierarchical Junos, which the hierarchical fixtures' renders show. Display set's text is config,
// so the secrets check leaves it alone. And the kit's probes (#33), with the Junos adapter (probes.ts).
import { describeConformance } from '@dialect/conformance'
import plugin from '../src'
import { probes } from './probes'

describeConformance(plugin, new URL('./fixtures/conformance', import.meta.url), { configTools: ['display-set'], probes })
