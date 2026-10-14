// A careful stub plugin passes the kit: every fixture through the four checks, as a platform plugin's own tests run it.
import { describeConformance } from '../src'
import stub from './stubPlatform'

describeConformance(stub, new URL('./fixtures', import.meta.url))
