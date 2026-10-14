// The conformance kit over the plugin's own fixtures (tests/fixtures/<area>): each one parsed, rendered, re-parsed and
// put through the coverage ledger and the secrets check; and the kit's probes (#33), with IOS-XR's adapter (probes.ts).
import { describeConformance } from '@dialect/conformance'
import plugin from '../src'
import { probes } from './probes'

describeConformance(plugin, new URL('./fixtures', import.meta.url), { probes })
