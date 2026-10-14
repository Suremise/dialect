// modelProblems() and isRouteDistinguisher(): what a model must hold beyond its types (validate.ts).
import { describe, expect, it } from 'vitest'
import { fieldPath, isRouteDistinguisher, modelProblems, type Device } from '../src'

describe('isRouteDistinguisher', () => {
  it('takes the three forms: ASN:nn, IP:nn and ASN4:nn, at their bounds', () => {
    for (const ok of ['65000:100', '0:0', '65535:4294967295', '192.0.2.1:100', '0.0.0.0:65535', '255.255.255.255:0', '65536:65535', '4200000000:100', '4294967295:0'])
      expect(isRouteDistinguisher(ok), ok).toBe(true)
  })

  it('refuses anything else', () => {
    for (const bad of [
      '', '65000', ':100', '65000:', '65000:100:1', 'target:65000:100', '65000 :100', ' 65000:100', '-1:100', '+1:100', '065000:100', '65000:0100',
      // Out of range: the assigned number for ASN:nn, IP:nn and ASN4:nn, and the AS itself.
      '65535:4294967296', '192.0.2.1:65536', '65536:65536', '4294967296:0', '4200000000:4294967295',
      // Not an IPv4 address, nor asdot.
      '192.0.2:100', '192.0.2.256:100', '192.0.2.01:100', '1.10:100', '2001:db8::1:100', 'blue:100', '65000L:100'
    ])
      expect(isRouteDistinguisher(bad), bad).toBe(false)
    for (const notText of [undefined, null, 65000, ['65000:100']]) expect(isRouteDistinguisher(notText)).toBe(false)
  })
})

describe('modelProblems', () => {
  const vrf = (networkInstance: string): Device => ({ interfaces: { eth0: { subinterfaces: { '0': { networkInstance }, '10': { vlanId: 10 } } } } })
  const field = fieldPath('interfaces', 'eth0', 'subinterfaces', '0', 'networkInstance')

  it('finds nothing wrong in an empty model, or one whose subinterfaces name declared VRFs', () => {
    expect(modelProblems({})).toEqual([])
    expect(modelProblems({ ...vrf('blue'), networkInstances: { blue: { type: 'vrf' } } })).toEqual([])
  })

  it('reports a subinterface naming a network instance the model doesn\'t have, on its field, without the name', () => {
    for (const device of [vrf('blue'), { ...vrf('blue'), networkInstances: { red: { type: 'vrf' } } }]) {
      const problems = modelProblems(device as Device)
      expect(problems).toEqual([{ severity: 'error', category: 'semantic', code: 'model.unknown-network-instance', message: 'A subinterface names a network instance the model doesn\'t have.', field }])
    }
  })

  it('reports `default` as a subinterface\'s network instance: the default table is said by leaving it out', () => {
    expect(modelProblems({ ...vrf('default'), networkInstances: { default: { type: 'default' } } }).map((d) => [d.code, d.field])).toEqual([['model.default-network-instance', field]])
  })

  it('reports malformed route distinguishers and route targets, once per field, never quoting them', () => {
    const secret = 'CANARY_SECRET'
    const device: Device = {
      networkInstances: {
        good: { type: 'vrf', routeDistinguisher: '65000:1', routeTargets: { import: ['65000:1', '192.0.2.1:7'], export: ['4200000000:1'] } },
        bad: { type: 'vrf', routeDistinguisher: secret, routeTargets: { import: ['65000:1', secret, 'x'], export: [secret] } }
      }
    }
    const problems = modelProblems(device)
    expect(problems.map((d) => [d.code, d.field])).toEqual([
      ['model.route-distinguisher', 'networkInstances.bad.routeDistinguisher'],
      ['model.route-target', 'networkInstances.bad.routeTargets.import'],
      ['model.route-target', 'networkInstances.bad.routeTargets.export']
    ])
    expect(problems.every((d) => d.severity === 'error' && !d.message.includes(secret))).toBe(true)
  })

  it('reads a model from JSON or a careless plugin without trusting its types', () => {
    const loose = JSON.parse('{"interfaces":{"eth0":{"subinterfaces":{"0":{"networkInstance":7}}}},"networkInstances":{"7":{},"v":{"routeDistinguisher":1,"routeTargets":{"import":"65000:1"}}}}') as Device
    expect(modelProblems(loose).map((d) => d.code)).toEqual(['model.unknown-network-instance', 'model.route-distinguisher'])
  })
})
