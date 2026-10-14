// The conformance kit over the plugin's own fixtures (tests/fixtures/<area>): each one parsed, rendered, re-parsed and
// put through the coverage ledger, and the kit's probes from the plugin's adapter (tests/probes.ts).
import { describeConformance } from '@dialect/conformance'
import plugin from '../src'
import { IOSXE_PROBES } from './probes'

describeConformance(plugin, new URL('./fixtures', import.meta.url), { probes: IOSXE_PROBES })
