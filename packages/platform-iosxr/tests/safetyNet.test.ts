// Core's secret safety net (guardPlugin(), #115) on the IOS-XR plugin: the case found in #114 where a mapper's fixed
// reason holds a secret that is also one of its words. Guarded, as every shell gets it from the registry, it leaks
// none, under the conformance kit's secrets check with no allowances.
import { describe, expect, it } from 'vitest'
import { guardPlugin, MODEL_VERSION } from '@dialect/core'
import { checkFixture, checkSecrets } from '@dialect/conformance'
import iosxr from '../src'

const plugin = guardPlugin(iosxr)

describe('the safety net on IOS-XR', () => {
  it('withholds a mapper reason that holds a secret', () => {
    // With a quote opened after the community, `"RO` reads as an access list, whose reason "limits the community to
    // some clients with an access list, which comes with filters" holds `come`.
    const source = 'snmp-server community come RO\ninterface Loopback0\n'
    expect(checkSecrets(plugin, source, ['come'], { allowances: [] }).leaks).toEqual([])
    const expectedModel = plugin.parse!(source, { modelVersion: MODEL_VERSION }).model
    const secrets = checkFixture(plugin, { name: 'come', source, expectedModel }, { allowances: [] }).find((r) => r.check === 'secrets')
    expect(secrets?.status).toBe('passed')
  })
})
